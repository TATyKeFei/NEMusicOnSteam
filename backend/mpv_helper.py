import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SOCKET_NAME = "mpv.sock"
STARTUP_TIMEOUT = 10
IDLE_TIMEOUT = 60
CLIENT_GONE_ERRORS = (BrokenPipeError, ConnectionResetError)


class MpvHttpServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, CLIENT_GONE_ERRORS):
            return
        super().handle_error(request, client_address)


class MpvProcess:
    def __init__(self, runtime_dir):
        executable = self.find_executable()
        if not executable:
            path = os.environ.get("PATH", "")
            raise RuntimeError(f"找不到 mpv，请先安装 mpv；Steam 环境 PATH={path or '(空)'}")
        self.socket_path = os.path.join(runtime_dir, SOCKET_NAME)
        self.log_path = os.path.join(runtime_dir, "mpv.log")
        self.log_handle = open(self.log_path, "ab", buffering=0)
        self.lock = threading.Lock()
        self.request_id = 0
        try:
            self.process = subprocess.Popen(
                [
                    executable,
                    "--idle=yes",
                    "--no-video",
                    "--force-window=no",
                    "--no-terminal",
                    "--really-quiet",
                    "--input-ipc-server=" + self.socket_path,
                ],
                stdin=subprocess.DEVNULL,
                stdout=self.log_handle,
                stderr=subprocess.STDOUT,
                env=self.clean_environment(),
                close_fds=True,
            )
            deadline = time.monotonic() + STARTUP_TIMEOUT
            while time.monotonic() < deadline:
                if os.path.exists(self.socket_path):
                    return
                if self.process.poll() is not None:
                    raise RuntimeError("mpv 启动失败：" + self.read_log())
                time.sleep(0.05)
            raise RuntimeError("mpv IPC socket 启动超时：" + self.read_log())
        except Exception:
            self.close()
            raise

    @staticmethod
    def find_executable():
        candidates = [
            os.environ.get("NEMUSIC_MPV"),
            "/usr/bin/mpv",
            "/usr/local/bin/mpv",
            os.path.expanduser("~/.local/bin/mpv"),
            shutil.which("mpv"),
        ]
        for candidate in candidates:
            if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return None

    @staticmethod
    def clean_environment():
        names = {
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
            "HOME",
            "LANG",
            "PATH",
            "PIPEWIRE_REMOTE",
            "PULSE_SERVER",
            "USER",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "XDG_CONFIG_HOME",
            "XDG_CURRENT_DESKTOP",
            "XDG_DATA_HOME",
            "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE",
        }
        environment = {name: value for name, value in os.environ.items() if name in names or name.startswith("LC_")}
        environment["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        return environment

    def read_log(self):
        try:
            self.log_handle.flush()
            with open(self.log_path, "rb") as handle:
                text = handle.read()[-2048:].decode("utf-8", errors="replace").strip()
            return text.replace("\n", " | ") or "没有更多错误信息"
        except OSError:
            return "无法读取 mpv 日志"

    def command(self, name, *args):
        with self.lock:
            self.request_id += 1
            request_id = self.request_id
            request = {"command": [name, *args], "request_id": request_id}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(self.socket_path)
                connection.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
                buffer = b""
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line:
                            continue
                        try:
                            response = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if response.get("request_id") != request_id:
                            continue
                        if response.get("error") not in (None, "success"):
                            raise RuntimeError("mpv: " + str(response["error"]))
                        return response.get("data")
                    connection.settimeout(max(0.1, deadline - time.monotonic()))
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    buffer += chunk
            raise RuntimeError("mpv 没有返回命令结果")

    def set_position(self, position):
        position = max(0.0, float(position))
        if position <= 0:
            return
        deadline = time.monotonic() + 5
        while True:
            try:
                self.command("set_property", "time-pos", position)
                return
            except RuntimeError as error:
                if "property unavailable" not in str(error):
                    raise
                if time.monotonic() >= deadline:
                    raise RuntimeError("mpv 音频尚未准备好，无法恢复播放进度") from error
                time.sleep(0.1)

    def property(self, name, fallback=None):
        try:
            return self.command("get_property", name)
        except (OSError, RuntimeError, socket.timeout):
            return fallback

    def close(self):
        process = getattr(self, "process", None)
        if process is None:
            return
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        log_handle = getattr(self, "log_handle", None)
        if log_handle is not None:
            log_handle.close()


class MpvService:
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.loop = None
        self.last_seen = time.monotonic()
        self.stopping = False
        self.track = {}
        self.mpv = MpvProcess(runtime_dir)
        self.server = MpvHttpServer(("127.0.0.1", 0), self.make_handler())
        self.server.daemon_threads = True

    def make_handler(self):
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, code, payload):
                body = b"" if code == 204 else json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "X-NEMusic-Token, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_OPTIONS(self):
                self.reply(204, {})

            def authorized(self):
                if self.headers.get("X-NEMusic-Token") != service.token:
                    self.reply(403, {"error": "forbidden"})
                    return False
                with service.lock:
                    service.last_seen = time.monotonic()
                return True

            def read_payload(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > 65536:
                        raise ValueError("invalid length")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError("invalid payload")
                    return payload
                except (ValueError, json.JSONDecodeError):
                    return None

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path == "/state":
                    try:
                        self.reply(200, service.snapshot())
                    except RuntimeError as error:
                        self.reply(502, {"error": str(error)})
                    return
                self.reply(404, {})

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path == "/load":
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        self.reply(200, service.load(payload))
                    except (RuntimeError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/command":
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        self.reply(200, {"handled": service.command(payload)})
                    except (RuntimeError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/shutdown":
                    self.reply(200, {})
                    service.request_shutdown()
                    return
                self.reply(404, {})

        return Handler

    def load(self, payload):
        url = str(payload.get("url") or "")
        if not url.startswith(("http://", "https://")):
            raise ValueError("网易云没有返回有效的音频地址")
        title = str(payload.get("title") or "").strip()
        if not title:
            raise ValueError("缺少歌曲标题")
        position = payload.get("position", 0)
        try:
            position = max(0.0, float(position))
        except (TypeError, ValueError):
            position = 0.0
        self.mpv.command("loadfile", url, "replace")
        self.mpv.command("set_property", "pause", True)
        self.mpv.set_position(position)
        self.mpv.command("set_property", "pause", not bool(payload.get("autoplay", True)))
        with self.lock:
            self.track = {
                "title": title,
                "artist": str(payload.get("artist") or "").strip(),
                "album": str(payload.get("album") or "").strip(),
                "artUrl": str(payload.get("artUrl") or "").strip(),
                "trackId": str(payload.get("trackId") or title),
            }
        return self.snapshot()

    def command(self, payload):
        action = str(payload.get("action") or "")
        if action == "play":
            self.mpv.command("set_property", "pause", False)
        elif action == "pause":
            self.mpv.command("set_property", "pause", True)
        elif action == "playpause":
            self.mpv.command("cycle", "pause")
        elif action == "stop":
            self.mpv.command("stop")
        elif action == "volume":
            self.mpv.command("set_property", "volume", max(0.0, min(100.0, float(payload.get("value", 1)) * 100)))
        elif action == "rate":
            self.mpv.command("set_property", "speed", max(0.1, min(4.0, float(payload.get("value", 1)))))
        elif action == "seek":
            self.mpv.command("seek", float(payload.get("value", 0)) / 1000000.0, "relative", "exact")
        elif action == "setposition":
            self.mpv.command("set_property", "time-pos", max(0.0, float(payload.get("value", 0)) / 1000000.0))
        elif action == "loop":
            value = payload.get("value")
            self.mpv.command("set_property", "loop-file", "inf" if value == "Track" else "no")
        elif action == "shuffle":
            return True
        else:
            return False
        return True

    def snapshot(self):
        path = self.mpv.property("path")
        with self.lock:
            track = dict(self.track)
        if not path or not track:
            return {
                "active": False,
                "playbackStatus": "Stopped",
                "title": track.get("title", ""),
                "artist": track.get("artist", ""),
                "album": track.get("album", ""),
                "artUrl": track.get("artUrl", ""),
                "trackId": track.get("trackId", ""),
                "duration": 0,
                "position": 0,
                "canSeek": False,
                "volume": 1,
                "loopStatus": "None",
                "shuffle": False,
                "rate": 1,
            }
        duration = self.mpv.property("duration", 0) or 0
        position = self.mpv.property("time-pos", 0) or 0
        paused = bool(self.mpv.property("pause", False))
        ended = bool(self.mpv.property("eof-reached", False))
        volume = self.mpv.property("volume", 100) or 100
        speed = self.mpv.property("speed", 1) or 1
        loop_file = self.mpv.property("loop-file", "no")
        return {
            "active": True,
            "playbackStatus": "Stopped" if ended else "Paused" if paused else "Playing",
            **track,
            "duration": max(0.0, float(duration)),
            "position": max(0.0, float(position)),
            "canSeek": True,
            "volume": max(0.0, min(1.0, float(volume) / 100.0)),
            "loopStatus": "Track" if loop_file == "inf" else "None",
            "shuffle": False,
            "rate": max(0.1, min(4.0, float(speed))),
        }

    def request_shutdown(self):
        with self.lock:
            self.stopping = True
        if self.loop is not None:
            self.loop()

    def run(self):
        self.loop = self.server.shutdown
        with open(os.path.join(self.runtime_dir, "port"), "w", encoding="ascii") as port_file:
            port_file.write(str(self.server.server_port))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            while True:
                time.sleep(2)
                with self.lock:
                    if self.stopping:
                        break
                    expired = time.monotonic() - self.last_seen > IDLE_TIMEOUT
                if expired:
                    break
                if self.mpv.process.poll() is not None:
                    break
        finally:
            self.server.shutdown()
            self.server.server_close()
            self.mpv.close()
            try:
                os.unlink(os.path.join(self.runtime_dir, "port"))
            except FileNotFoundError:
                pass
            shutil.rmtree(self.runtime_dir, ignore_errors=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: mpv_helper.py RUNTIME_DIR")
    runtime_dir = sys.argv[1]
    try:
        with open(os.path.join(runtime_dir, "token"), encoding="utf-8") as token_file:
            token = token_file.read().strip()
        service = MpvService(runtime_dir, token)
        service.run()
    except Exception:
        shutil.rmtree(runtime_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise
