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
from download_files import find_downloaded_song


SOCKET_NAME = "mpv.sock"
STARTUP_TIMEOUT = 10
ANALYZE_MAX_TRACKS = 8
ANALYZE_CACHE_LIMIT = 512

# Millennium 3.6.3 起辅助进程运行在 SteamRT3 容器里，容器的 /usr/bin 没有
# mpv/ffmpeg；宿主机程序从这里挂载，同时需要宿主动态库和 GI typelib。
HOST_ROOT = "/run/host"
STANDARD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def host_bin_directories():
    return [
        os.path.join(HOST_ROOT, "usr/local/bin"),
        os.path.join(HOST_ROOT, "usr/bin"),
        os.path.join(HOST_ROOT, "bin"),
    ]


def host_library_directories():
    candidates = [
        os.path.join(HOST_ROOT, "usr/local/lib"),
        os.path.join(HOST_ROOT, "usr/lib/x86_64-linux-gnu"),
        os.path.join(HOST_ROOT, "usr/lib64"),
        os.path.join(HOST_ROOT, "usr/lib"),
        os.path.join(HOST_ROOT, "lib/x86_64-linux-gnu"),
        os.path.join(HOST_ROOT, "lib64"),
        os.path.join(HOST_ROOT, "lib"),
    ]
    return [path for path in candidates if os.path.isdir(path)]


def host_typelib_directories():
    typelibs = []
    for path in host_library_directories():
        candidate = os.path.join(path, "girepository-1.0")
        if os.path.isdir(candidate):
            typelibs.append(candidate)
    return typelibs


def host_binary(name):
    for directory in host_bin_directories():
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


class MpvProcess:
    def __init__(self, runtime_dir):
        executable = self.find_executable()
        if not executable:
            path = os.environ.get("PATH", "")
            raise RuntimeError(
                f"找不到 mpv，请先在宿主机安装 mpv；已检查 {HOST_ROOT}/usr/bin，Steam 环境 PATH={path or '(空)'}"
            )
        self.socket_path = os.path.join(runtime_dir, SOCKET_NAME)
        self.log_path = os.path.join(runtime_dir, "mpv.log")
        self.log_handle = open(self.log_path, "ab", buffering=0)
        self.lock = threading.Lock()
        self.request_id = 0
        self.connection = None
        self.receive_buffer = b""
        self.clock_lock = threading.Lock()
        self.clock_state = {}
        self.clock_thread = None
        self.clock_stop = threading.Event()
        try:
            self.process = subprocess.Popen(
                [
                    executable,
                    "--no-config",
                    "--idle=yes",
                    "--no-video",
                    "--force-window=no",
                    "--no-terminal",
                    "--msg-level=all=warn",
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
            host_binary("mpv"),
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
        path_dirs = [path for path in host_bin_directories() if os.path.isdir(path)]
        path_dirs.append(STANDARD_PATH)
        environment["PATH"] = ":".join(path_dirs)
        libraries = host_library_directories()
        if libraries:
            environment["LD_LIBRARY_PATH"] = ":".join(libraries)
        typelibs = host_typelib_directories()
        if typelibs:
            environment["GI_TYPELIB_PATH"] = ":".join(typelibs)
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
            connection = self.connection
            try:
                if connection is None:
                    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    connection.settimeout(2)
                    connection.connect(self.socket_path)
                    self.connection = connection
                connection.settimeout(2)
                connection.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    while b"\n" in self.receive_buffer:
                        line, self.receive_buffer = self.receive_buffer.split(b"\n", 1)
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
                    self.receive_buffer += chunk
                raise RuntimeError("mpv 没有返回命令结果")
            except (OSError, RuntimeError):
                if self.connection is connection:
                    self.connection = None
                    self.receive_buffer = b""
                if connection is not None:
                    try:
                        connection.close()
                    except OSError:
                        pass
                raise

    def playback_clock(self, path):
        """混音线程只读事件缓存，不再每 10 ms 向 mpv 发起查询。"""
        with self.clock_lock:
            if self.clock_thread is None and not self.clock_stop.is_set():
                self.clock_thread = threading.Thread(target=self.watch_clock, name="nemusic-mpv-clock", daemon=True)
                self.clock_thread.start()
            if self.clock_state.get("path") != path:
                return 0
            return self.clock_state.get("time-pos") or 0

    def watch_clock(self):
        while not self.clock_stop.is_set():
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(0.5)
                    connection.connect(self.socket_path)
                    for identifier, name in enumerate(("path", "time-pos"), 1):
                        message = {"command": ["observe_property", identifier, name]}
                        connection.sendall((json.dumps(message) + "\n").encode("utf-8"))
                    buffer = b""
                    while not self.clock_stop.is_set():
                        try:
                            chunk = connection.recv(65536)
                        except socket.timeout:
                            continue
                        if not chunk:
                            break
                        buffer += chunk
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            try:
                                event = json.loads(line)
                            except ValueError:
                                continue
                            if event.get("event") == "property-change" and event.get("name") in ("path", "time-pos"):
                                with self.clock_lock:
                                    if event["name"] == "path" and self.clock_state.get("path") != event.get("data"):
                                        self.clock_state.pop("time-pos", None)
                                    self.clock_state[event["name"]] = event.get("data")
            except OSError:
                pass
            with self.clock_lock:
                self.clock_state.clear()
            self.clock_stop.wait(0.5)

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
        clock_stop = getattr(self, "clock_stop", None)
        if clock_stop is not None:
            clock_stop.set()
        clock_thread = getattr(self, "clock_thread", None)
        if clock_thread is not None:
            clock_thread.join(timeout=2)
        process = getattr(self, "process", None)
        if process is None:
            return
        if process.poll() is None:
            try:
                # 优先通过 IPC 正常退出，让音频输出和 socket 一起关闭。
                try:
                    self.command("quit")
                except (OSError, RuntimeError):
                    process.terminate()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait()
        connection = getattr(self, "connection", None)
        self.connection = None
        self.receive_buffer = b""
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
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

    def configure(self, payload):
        with self.operations:
            mode = payload.get("loudness", "off")
            if mode not in ("off", "replaygain", "dynamic"):
                raise ValueError("无效的响度模式")
            device = payload.get("audioDevice", "auto")
            if not isinstance(device, str) or not device or len(device) > 512 or any(ord(char) < 32 for char in device):
                raise ValueError("无效的音频设备")
            self.audio_configuration = {"loudness": mode, "audioDevice": device}
            self.mpv.command("set_property", "replaygain", "track" if mode == "replaygain" else "no")
            self.mpv.command("set_property", "af", "lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11]" if mode == "dynamic" else "")
            self.device_checked_at = 0
            self.audio_state()

    def audio_state(self):
        now = time.monotonic()
        if now - getattr(self, "device_checked_at", 0) >= 2:
            raw = self.mpv.property("audio-device-list", [])
            self.audio_devices = [{"name": str(item["name"]), "description": str(item.get("description") or item["name"])}
                                  for item in raw if isinstance(item, dict) and item.get("name")] if isinstance(raw, list) else []
            requested = getattr(self, "audio_configuration", {}).get("audioDevice", "auto")
            available = requested == "auto" or any(item["name"] == requested for item in self.audio_devices)
            self.audio_device_status = "" if available else "所选设备已断开，已回退到系统默认输出"
            selected = requested if available else "auto"
            if getattr(self, "selected_audio_device", "auto") != selected:
                try:
                    self.mpv.command("set_property", "audio-device", selected)
                except RuntimeError:
                    if selected == "auto":
                        raise
                    self.mpv.command("set_property", "audio-device", "auto")
                    selected = "auto"
                    self.audio_device_status = "所选设备不可用，已回退到系统默认输出"
                self.selected_audio_device = selected
            self.device_checked_at = now
        return {"audioDevices": getattr(self, "audio_devices", []), "audioDeviceStatus": getattr(self, "audio_device_status", "")}

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
        local = payload.get("localTrack")
        if isinstance(local, dict):
            path = find_downloaded_song(local.get("directory"), local.get("songId"), local.get("quality"))
            if not path:
                raise ValueError("已下载歌曲不存在或已被移走，请重试以使用在线音源")
            return path
        url = str(payload.get("url") or "")
        if not url.startswith(("http://", "https://")):
            raise ValueError("网易云没有返回有效的音频地址")
        if not str(payload.get("title") or "").strip():
            raise ValueError("缺少歌曲标题")
        return url

    def local_track(self, payload):
        return {"available": bool(find_downloaded_song(payload.get("directory"), payload.get("songId"), payload.get("quality")))}

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
        headers = {} if payload.get("localTrack") else audio_headers(url)
        self.mpv.command("set_property", "http-header-fields", [f"{key}: {value}" for key, value in headers.items()])
        self.mpv.command("set_property", "speed", self.rate)
        self.mpv.command("set_property", "loop-file", "inf" if payload.get("loopStatus") == "Track" else "no")
        self.mpv.command("set_property", "pause", True)
        self.close_mixer()
        profile = payload.get("crossfade")
        preload = payload.get("preloadNext") is True and payload.get("transitionMode") == "none"
        if (profile in PROFILES and payload.get("transitionMode") != "none") or preload:
            source = {**payload, "url": url, **self.metadata(payload), "position": position,
                      "loudness": getattr(self, "audio_configuration", {}).get("loudness", "off"),
                      "duration": max(0, self.number(payload.get("duration")))}
            mixer = PcmMixer(self.runtime_dir, source, profile if profile in PROFILES else "standard", MpvProcess.clean_environment(),
                             lambda: self.mpv.playback_clock(mixer.fifo))
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
                payload = {**payload, "url": self.validate(payload)}
                payload = {**payload, "loudness": getattr(self, "audio_configuration", {}).get("loudness", "off")}
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
                self.load_locked({**view["payload"], "crossfade": "off", "preloadNext": False, "position": view["position"],
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
        audio = self.audio_state()
        path = self.mpv.property("path")
        with self.lock:
            track = dict(self.track)
        if not path or not track:
            return {
                "active": False,
                **audio,
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
            **audio,
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
