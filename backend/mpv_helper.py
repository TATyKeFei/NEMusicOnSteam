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
from transition_analysis import TransitionAnalysis, fade_timing


SOCKET_NAME = "mpv.sock"
STARTUP_TIMEOUT = 10


class MpvProcess:
    def __init__(self, runtime_dir, name="mpv"):
        executable = self.find_executable()
        if not executable:
            path = os.environ.get("PATH", "")
            raise RuntimeError(f"找不到 mpv，请先安装 mpv；Steam 环境 PATH={path or '(空)'}")
        self.socket_path = os.path.join(runtime_dir, SOCKET_NAME if name == "mpv" else name + ".sock")
        self.log_path = os.path.join(runtime_dir, name + ".log")
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
        self.url = ""
        self.prepared = None
        self.fading = None
        self.master_volume = None
        # 用户倍速与智能混音的变速是分开的：snapshot 回报的永远是用户的那一档。
        self.rate = 1.0
        self.closed = threading.Event()
        self.worker = None
        self.serial = 0
        self.transport_revision = 0
        self.mpv = MpvProcess(runtime_dir)
        self.start_http()

    def alive(self):
        return self.mpv.process.poll() is None

    def close(self):
        with self.operations:
            self.closed.set()
            self.cancel_transition()
            self.mpv.close()

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

    def clear_prepared(self):
        prepared, self.prepared = self.prepared, None
        if prepared:
            prepared["analysis"].close()
            prepared["player"].close()

    def finish_fade(self):
        fading, self.fading = self.fading, None
        if fading:
            # 等拍点接入的新歌可能还按着，旧歌一走就得把声音接上；这个判断要在关进程之前做。
            resume = fading.get("waiting") and not fading["player"].property("pause", False)
            fading["player"].close()
            if resume:
                self.mpv.command("set_property", "pause", False)
            self.mpv.command("set_property", "speed", self.rate)
            self.mpv.command("set_property", "volume", self.master_volume)

    def set_pause(self, paused):
        self.mpv.command("set_property", "pause", paused)
        if self.fading:
            self.fading["player"].command("set_property", "pause", paused)
            if not paused and self.fading.get("waiting"):
                # 拍点没到之前新歌必须保持沉默，由 update_fade 到点放开。
                self.mpv.command("set_property", "pause", True)

    def cancel_transition(self):
        self.serial += 1
        self.clear_prepared()
        self.finish_fade()

    def prepare(self, payload):
        with self.operations:
            if self.closed.is_set():
                raise RuntimeError("mpv 后端已关闭")
            self.serial += 1
            serial = self.serial
            self.clear_prepared()
            if not payload.get("url"):
                if payload.get("cancelFade"):
                    self.finish_fade()
                return {}
            url = self.validate(payload)
            if str(payload.get("from")) != self.track.get("trackId"):
                return {}
            current_url = self.url
            duration = self.number(self.mpv.property("duration"))
        # 启动和网络加载不持操作锁，让当前歌曲的暂停、停止立即生效。
        player = MpvProcess(self.runtime_dir, "next-" + str(serial))
        try:
            player.command("set_property", "volume", 0)
            player.command("set_property", "http-header-fields", [f"{key}: {value}" for key, value in audio_headers(url).items()])
            player.command("loadfile", url, "replace")
            player.command("set_property", "pause", True)
            with self.operations:
                if self.closed.is_set() or serial != self.serial or str(payload.get("from")) != self.track.get("trackId"):
                    player.close()
                    return {}
                maximum = max(1, min(12, self.number(payload.get("seconds"), 6)))
                mode = "smart" if payload.get("mode") == "smart" else "normal"
                analysis = TransitionAnalysis(current_url, duration, url, maximum, MpvProcess.clean_environment(), mode)
                self.prepared = {"player": player, "from": self.track["trackId"],
                                 "track": self.metadata(payload), "analysis": analysis}
                if self.worker is None:
                    self.worker = threading.Thread(target=self.fade_loop, daemon=True)
                    self.worker.start()
                return {"prepared": True}
        except Exception:
            player.close()
            raise

    def fade_loop(self):
        while not self.closed.wait(0.04):
            with self.operations:
                if self.fading:
                    try:
                        self.update_fade()
                    except (RuntimeError, OSError):
                        # 尾奏进程失败不影响新歌继续正常出声。
                        try:
                            self.finish_fade()
                        except (RuntimeError, OSError):
                            pass

    def update_fade(self):
        fading = self.fading
        if not fading:
            return
        player = fading["player"]
        # 用音频时钟而非墙上时间，暂停/缓冲期间不会悄悄走完淡化。
        elapsed = max(0.0, self.number(player.property("time-pos"), fading["start"]) - fading["start"])
        if fading.get("waiting"):
            # 智能混音：到拍点才放开新歌，两边从这一刻同步走表。
            if elapsed > 0 and not player.property("pause", False):
                fading["waiting"] = False
                self.mpv.command("set_property", "pause", False)
            else:
                elapsed = 0.0
        if player.property("eof-reached", False):
            # 旧歌先到结尾时不必再等表走完，否则新歌会被压着不放声。
            elapsed = fading["duration"]
        progress = min(1.0, elapsed / fading["duration"])
        ramp = fading.get("ramp", 0.0)
        if ramp and elapsed > fading["duration"] - ramp:
            # 旧歌已经压到听不清之后，把新歌的变速平滑拉回用户倍速，避免收尾突然变速。
            ratio = min(1.0, max(0.0, (elapsed - (fading["duration"] - ramp)) / ramp))
            speed = fading["stretch"] + (1 - fading["stretch"]) * ratio
            if abs(speed - fading.get("speed", 1.0)) > 0.002:
                fading["speed"] = speed
                self.mpv.command("set_property", "speed", self.rate * speed)
        self.mpv.command("set_property", "volume", self.master_volume * math.sin(progress * math.pi / 2))
        player.command("set_property", "volume", self.master_volume * math.cos(progress * math.pi / 2))
        if progress >= 1:
            self.finish_fade()

    def adopt_prepared(self, payload):
        prepared = self.prepared
        if not payload.get("transition") or not prepared or prepared["from"] != str(payload.get("from")) \
                or prepared["from"] != self.track.get("trackId") \
                or prepared["track"]["trackId"] != str(payload.get("trackId")):
            return False
        player = prepared["player"]
        if not player.property("path") or not player.property("audio-params"):
            return False
        plan = dict(prepared["analysis"].result)
        self.finish_fade()
        volume = self.master_volume if self.master_volume is not None else self.number(self.mpv.property("volume"), 100)
        if payload.get("volume") is not None:
            volume = max(0, min(100, self.number(payload["volume"]) * 100))
        autoplay = bool(payload.get("autoplay", True))
        old = self.mpv
        old_position = max(0.0, self.number(old.property("time-pos")))
        song_end = max(0.0, self.number(old.property("duration")))
        timing = fade_timing(plan, old_position, song_end)
        # 没有前导静音时无需 seek，让预加载好的解码器直接播放。
        player.set_position(max(0.0, self.number(plan.get("skip"))))
        player.command("set_property", "speed", self.rate * timing["stretch"])
        player.command("set_property", "loop-file", "no")
        # 智能混音等拍点接入：新歌先保持暂停，由 update_fade 到点放开；
        # 错过拍点或对不齐时 timing 已经退回普通模式，立即可闻。
        player.command("set_property", "pause", True if timing["waiting"] else not autoplay)
        old.command("set_property", "pause", not autoplay)
        prepared["analysis"].close()
        self.prepared = None
        self.mpv = player
        self.track = prepared["track"]
        self.url = str(payload.get("url"))
        self.master_volume = volume
        remaining = max(0.0, song_end - old_position) if song_end else self.number(plan.get("seconds"), 6.0)
        if remaining > 0.15 and not old.property("eof-reached", False):
            self.fading = {"player": old, "start": timing["start"], "duration": timing["duration"],
                           "stretch": timing["stretch"], "ramp": timing["ramp"], "waiting": timing["waiting"],
                           "speed": timing["stretch"]}
            self.update_fade()
        else:
            old.close()
            player.command("set_property", "pause", not autoplay)
            player.command("set_property", "speed", self.rate)
            player.command("set_property", "volume", volume)
        return True

    def load(self, payload):
        with self.operations:
            if self.closed.is_set():
                raise RuntimeError("mpv 后端已关闭")
            return self.load_locked(payload)

    def load_locked(self, payload):
        url = self.validate(payload)
        if payload.get("transition") and payload.get("transportRevision") != self.transport_revision:
            return {**self.snapshot(), "transitionCancelled": True}
        if self.adopt_prepared(payload):
            return {**self.snapshot(), "transitioned": True}
        if payload.get("transition"):
            # 接管失败时保留旧歌，禁止把智能过渡悄悄退化为提前 loadfile 硬切。
            self.clear_prepared()
            return {**self.snapshot(), "transitionCancelled": True}
        self.cancel_transition()
        position = max(0, self.number(payload.get("position")))
        volume = payload.get("volume")
        if isinstance(volume, (int, float)) and not isinstance(volume, bool):
            # mpv 默认音量是 100%：先按网页音量落好再放声，否则从网页切过来就是一声爆音。
            self.mpv.command("set_property", "volume", max(0.0, min(100.0, float(volume) * 100)))
        self.master_volume = None
        headers = audio_headers(url)
        self.mpv.command("set_property", "http-header-fields", [f"{key}: {value}" for key, value in headers.items()])
        self.mpv.command("set_property", "speed", self.rate)
        self.mpv.command("set_property", "pause", True)
        self.mpv.command("loadfile", url, "replace")
        self.mpv.set_position(position)
        self.mpv.command("set_property", "pause", not bool(payload.get("autoplay", True)))
        self.track = self.metadata(payload)
        self.url = url
        return self.snapshot()

    def command(self, payload):
        with self.operations:
            return self.command_locked(payload)

    def command_locked(self, payload):
        action = str(payload.get("action") or "")
        if action in ("play", "pause", "playpause", "stop", "seek", "setposition", "loop", "shuffle"):
            self.transport_revision += 1
        if action in ("stop", "seek", "setposition", "loop", "shuffle"):
            self.cancel_transition()
        if action == "play":
            self.set_pause(False)
        elif action == "pause":
            self.set_pause(True)
        elif action == "playpause":
            source = self.fading["player"] if self.fading else self.mpv
            self.set_pause(not bool(source.property("pause", False)))
        elif action == "stop":
            self.mpv.command("stop")
        elif action == "volume":
            volume = max(0, min(100, self.number(payload.get("value"), 1) * 100))
            if self.fading:
                self.master_volume = volume
                self.update_fade()
            else:
                self.master_volume = None
                self.mpv.command("set_property", "volume", volume)
        elif action == "rate":
            self.rate = max(0.1, min(4.0, self.number(payload.get("value"), 1)))
            self.mpv.command("set_property", "speed", self.rate * (self.fading.get("speed", 1.0) if self.fading else 1.0))
            if self.fading:
                self.fading["player"].command("set_property", "speed", self.rate)
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
        paused = bool(self.mpv.property("pause", False))
        if self.fading and self.fading.get("waiting"):
            # 新歌还在等拍点，播放状态以正在退场的旧歌为准。
            paused = bool(self.fading["player"].property("pause", False))
        ended = bool(self.mpv.property("eof-reached", False))
        volume = self.mpv.property("volume", 100)
        volume = 100 if volume is None else volume
        if self.master_volume is not None:
            volume = self.master_volume
        loop_file = self.mpv.property("loop-file", "no")
        transition = None
        if self.prepared:
            prepared = self.prepared
            ready = bool(prepared["player"].property("audio-params")) and not prepared["player"].property("eof-reached", False)
            plan = prepared["analysis"].result
            transition = {"from": prepared["from"], "trackId": prepared["track"]["trackId"],
                          "ready": ready, "seconds": plan["seconds"], "trim": plan["trim"], "analyzed": plan["analyzed"],
                          "mode": plan.get("mode", "normal"), "reason": plan.get("reason"),
                          "startAt": plan.get("startAt")}
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
            "rate": max(0.1, min(4.0, float(self.rate))),
            "transition": transition,
            "transitioning": self.fading is not None,
            "transportRevision": self.transport_revision,
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
