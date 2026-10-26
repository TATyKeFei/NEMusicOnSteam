import json
import math
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from playback_http import PlaybackHttpService
from audio_source import audio_headers
from track_analysis import ANALYZE_WINDOW, sample_track, track_features
from pcm_mixer import PcmMixer, PROFILES, RAW_OPTIONS


SOCKET_NAME = "mpv.sock"
STARTUP_TIMEOUT = 10
ANALYZE_MAX_TRACKS = 8
ANALYZE_CACHE_LIMIT = 512


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
                    "--pause=yes",
                    "--keep-open=yes",
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
                process.wait()
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        log_handle = getattr(self, "log_handle", None)
        if log_handle is not None:
            log_handle.close()


class MpvService(PlaybackHttpService):
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.operations = threading.RLock()
        self.track = {}
        self.rate = 1.0
        self.closed = threading.Event()
        self.features = {}
        self.mixer = None
        self.mpv = MpvProcess(runtime_dir)
        self.start_http()

    def alive(self):
        return self.mpv.process.poll() is None

    def close(self):
        with self.operations:
            self.closed.set()
            self.close_mixer()
            self.mpv.close()

    def close_mixer(self):
        mixer = self.mixer
        self.mixer = None
        if mixer:
            mixer.close()

    @staticmethod
    def number(value, fallback=0):
        try:
            result = float(value)
            return result if math.isfinite(result) else fallback
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def validate(payload):
        url = str(payload.get("url") or "")
        if not url.startswith(("http://", "https://")):
            raise ValueError("网易云没有返回有效的音频地址")
        if not str(payload.get("title") or "").strip():
            raise ValueError("缺少歌曲标题")
        return url

    @staticmethod
    def metadata(payload):
        return {key: str(payload.get(key) or (payload.get("title") if key == "trackId" else "") or "").strip()
                for key in ("title", "artist", "album", "artUrl", "trackId")}

    def analyze(self, payload):
        """按请求离线分析几首歌的开头（BPM/能量/调性），供歌单智能排序使用。

        不持操作锁：分析期间暂停、停止、切歌都要照常生效；结果按 trackId 缓存。
        """
        if self.closed.is_set():
            raise RuntimeError("mpv 后端已关闭")
        tracks = payload.get("tracks")
        if not isinstance(tracks, list) or not tracks:
            raise ValueError("缺少要分析的歌曲")
        if len(tracks) > ANALYZE_MAX_TRACKS:
            raise ValueError(f"一次最多分析 {ANALYZE_MAX_TRACKS} 首")
        environment = MpvProcess.clean_environment()
        results = []
        seen = set()
        for item in tracks:
            if not isinstance(item, dict):
                continue
            track_id = str(item.get("trackId") or "").strip()
            url = str(item.get("url") or "")
            if not track_id or track_id in seen or not url.startswith(("http://", "https://")):
                continue
            seen.add(track_id)
            # 逐首刷新活跃时间：长批次也不会被空闲回收掐断。
            with self.lock:
                self.last_seen = time.monotonic()
            feature = self.features.get(track_id)
            if feature is None:
                feature = track_features(sample_track(url, environment, ANALYZE_WINDOW))
                if feature is not None:
                    if len(self.features) >= ANALYZE_CACHE_LIMIT:
                        self.features.pop(next(iter(self.features)))
                    self.features[track_id] = feature
            if feature is not None:
                results.append({"trackId": track_id, **feature})
        return {"tracks": results}

    def load(self, payload):
        with self.operations:
            if self.closed.is_set():
                raise RuntimeError("mpv 后端已关闭")
            return self.load_locked(payload)

    def load_locked(self, payload):
        url = self.validate(payload)
        position = max(0, self.number(payload.get("position")))
        volume = payload.get("volume")
        if isinstance(volume, (int, float)) and not isinstance(volume, bool):
            # mpv 默认音量是 100%：先按网页音量落好再放声，否则从网页切过来就是一声爆音。
            self.mpv.command("set_property", "volume", max(0.0, min(100.0, float(volume) * 100)))
        headers = audio_headers(url)
        self.mpv.command("set_property", "http-header-fields", [f"{key}: {value}" for key, value in headers.items()])
        self.mpv.command("set_property", "speed", self.rate)
        self.mpv.command("set_property", "loop-file", "inf" if payload.get("loopStatus") == "Track" else "no")
        self.mpv.command("set_property", "pause", True)
        self.close_mixer()
        profile = payload.get("crossfade")
        if profile in PROFILES:
            source = {**payload, **self.metadata(payload), "position": position,
                      "duration": max(0, self.number(payload.get("duration")))}
            mixer = PcmMixer(self.runtime_dir, source, profile, MpvProcess.clean_environment(),
                             lambda: self.mpv.property("time-pos", 0) if self.mpv.property("path") == mixer.fifo else 0)
            mixer.rate = self.rate
            self.mixer = mixer
            try:
                mixer.start()
                self.mpv.command("loadfile", mixer.fifo, "replace", -1, RAW_OPTIONS)
            except Exception:
                self.close_mixer()
                raise
        else:
            self.mpv.command("loadfile", url, "replace")
            self.mpv.set_position(position)
        self.mpv.command("set_property", "pause", not bool(payload.get("autoplay", True)))
        self.track = self.metadata(payload)
        return self.snapshot()

    def prepare(self, payload):
        with self.operations:
            if not self.mixer or self.closed.is_set():
                return {"accepted": False}
            if payload.get("streamId") != self.mixer.identifier:
                return {"accepted": False}
            with self.mixer.lock:
                if int(payload.get("revision", 0)) <= self.mixer.revision:
                    return {"accepted": False}
            if not payload.get("url"):
                view = self.mixer.view(self.mpv.property("time-pos", 0) or 0)
                with self.mixer.lock:
                    mixed = self.mixer.fade_progress is not None or self.mixer.current.payload.get("trackId") != payload.get("fromTrackId")
                if mixed and view["payload"].get("trackId") == payload.get("fromTrackId"):
                    self.seek_mixer(view["position"])
                    return {"accepted": True, "streamId": self.mixer.identifier}
            if payload.get("url"):
                self.validate(payload)
                payload = {**payload, **self.metadata(payload), "position": 0,
                           "duration": max(0, self.number(payload.get("duration")))}
            return {"accepted": self.mixer.prepare(payload), "streamId": self.mixer.identifier}

    def seek_mixer(self, position):
        view = self.mixer.view(self.mpv.property("time-pos", 0) or 0)
        payload = {**view["payload"], "position": max(0, position),
                   "autoplay": not self.mpv.property("pause", False),
                   "volume": (self.mpv.property("volume", 100) or 0) / 100}
        self.load_locked(payload)

    def command(self, payload):
        with self.operations:
            return self.command_locked(payload)

    def command_locked(self, payload):
        action = str(payload.get("action") or "")
        if action == "play":
            self.mpv.command("set_property", "pause", False)
        elif action == "pause":
            self.mpv.command("set_property", "pause", True)
        elif action == "playpause":
            self.mpv.command("set_property", "pause", not bool(self.mpv.property("pause", False)))
        elif action == "stop":
            self.close_mixer()
            self.mpv.command("stop")
        elif action == "volume":
            volume = max(0, min(100, self.number(payload.get("value"), 1) * 100))
            self.mpv.command("set_property", "volume", volume)
        elif action == "rate":
            self.rate = max(0.1, min(4.0, self.number(payload.get("value"), 1)))
            if self.mixer:
                with self.mixer.lock:
                    self.mixer.rate = self.rate
            self.mpv.command("set_property", "speed", self.rate)
        elif action == "seek":
            offset = self.number(payload.get("value")) / 1000000.0
            if self.mixer:
                position = self.mixer.view(self.mpv.property("time-pos", 0) or 0)["position"]
                self.seek_mixer(position + offset)
            else:
                self.mpv.command("seek", offset, "relative", "exact")
        elif action == "setposition":
            position = max(0.0, self.number(payload.get("value")) / 1000000.0)
            if self.mixer:
                self.seek_mixer(position)
            else:
                self.mpv.command("set_property", "time-pos", position)
        elif action == "loop":
            value = payload.get("value")
            if value == "Track" and self.mixer:
                view = self.mixer.view(self.mpv.property("time-pos", 0) or 0)
                self.load_locked({**view["payload"], "crossfade": "off", "position": view["position"],
                                  "autoplay": not self.mpv.property("pause", False),
                                  "volume": (self.mpv.property("volume", 100) or 0) / 100})
            self.mpv.command("set_property", "loop-file", "inf" if value == "Track" else "no")
        elif action == "shuffle":
            return True
        else:
            return False
        return True

    def snapshot(self):
        with self.operations:
            return self.snapshot_locked()

    def snapshot_locked(self):
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
                "rate": max(0.1, min(4.0, float(self.rate))),
            }
        duration = self.mpv.property("duration", 0) or 0
        position = self.mpv.property("time-pos", 0) or 0
        transition = {}
        if self.mixer:
            view = self.mixer.view(position if path == self.mixer.fifo else 0)
            track = self.metadata(view["payload"])
            duration = view["payload"].get("duration") or 0
            position = view["position"]
            transition = {"pcm": True, "streamId": self.mixer.identifier,
                          **{key: view[key] for key in ("handoffId", "handoffFrom", "queuedTrackId", "error")}}
        paused = bool(self.mpv.property("pause", False))
        ended = bool(self.mpv.property("eof-reached", False))
        volume = self.mpv.property("volume", 100)
        volume = 100 if volume is None else volume
        loop_file = self.mpv.property("loop-file", "no")
        return {
            "active": True,
            "playbackStatus": "Stopped" if ended else "Paused" if paused else "Playing",
            **track,
            **transition,
            "duration": max(0.0, float(duration)),
            "position": max(0.0, float(position)),
            "canSeek": True,
            "volume": max(0.0, min(1.0, float(volume) / 100.0)),
            "loopStatus": "Track" if loop_file == "inf" else "None",
            "shuffle": False,
            "rate": max(0.1, min(4.0, float(self.rate))),
        }



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
