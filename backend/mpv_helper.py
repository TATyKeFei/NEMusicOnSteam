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
from transition_analysis import ANALYZE_WINDOW, TransitionAnalysis, fade_timing, sample_track, track_features


SOCKET_NAME = "mpv.sock"
STARTUP_TIMEOUT = 10
# 混音结束后把响度匹配增益缓慢放回 1，避免结束时音量突变。
LEVEL_RELEASE_SECONDS = 8.0
# 智能混音在重叠中段把旧歌低频渐交给新歌（DJ 的低音交换）；普通淡化不动滤镜。
SMART_BASS_CUT_HZ = 120
# 低频交接时长范围（秒）：短重叠快速交、长重叠从容交，中心对齐 S 形进度交叉点。
SMART_BASS_RAMP_SECONDS = (0.6, 2.0)
# volume 表达式按帧求值，mpv 喂进来的帧较大，先把帧细切成小段再进渐变图，消掉台阶声。
SMART_FILTER_FRAME_SAMPLES = 256
# 旧歌高频提前退场：中段前把齿音/镲片压下去，减少两首歌高频打架（虚构窗按进度比例）。
SMART_TONE_HZ = 6500
SMART_TONE_DB = -7
SMART_TONE_MAX = 0.6
SMART_TONE_WINDOW = (0.2, 0.45)
# 重叠中段的人声频段轻降：两首歌的“嗓子”各让一点，减少人声互撞。
SMART_DUCK_HZ = 1000
SMART_DUCK_WIDTH_HZ = 3800
SMART_DUCK_DB = -2
SMART_DUCK_WINDOW = (0.3, 0.7)
# 歌单智能排序：单次请求最多分析几首、按 trackId 缓存多少个结果。
ANALYZE_MAX_TRACKS = 8
ANALYZE_CACHE_LIMIT = 512


def fade_shape(progress):
    """五次平滑阶，参考 SongMix 的 invisible S 曲线：两端各留一段平台，交接集中在中段。

    只是对进度做重映射，sin²+cos²=1 恒成立，等功率混音性质不变；
    听感上两首歌各自的音量在淡入淡出的头尾更稳，中段干脆地完成交换。
    """
    return progress * progress * progress * (progress * (progress * 6 - 15) + 10)


def _wet_dry(label, out, spec, weight):
    """一段湿/干混合支路：干权重 1-w、湿权重 w，amix 相加；weight 是 t 的表达式。

    权重从 0 起步时湿支路被完全旁通（滤波器启动瞬态听不到），湿支路也能在
    挂图后很晚才起作用，因此整张图可以在接管一刻就挂好。
    """
    tail = f"[{out}]" if out else ""
    return (f"[{label}]asplit=2[{label}a][{label}b];"
            f"[{label}b]{spec}[w_{label}];"
            f"[{label}a]volume=volume='1-({weight})':eval=frame[d_{label}];"
            f"[w_{label}]volume=volume='{weight}':eval=frame[v_{label}];"
            f"[d_{label}][v_{label}]amix=inputs=2:normalize=0{tail};")


def outgoing_graph(start, duration):
    """旧歌的渐出图：高频提前退场 → 中段人声频段轻降 → 低频在正中间渐交给新歌。

    全部按媒体时间 t 自动演化：挂图时各支路权重是 0，等于原声直通；暂停、
    倍速天然一致；mpv 拒绝滤镜时由调用方静默退化。
    """
    def progress(low, high):
        return f"min(max(((t-{start:.3f})/{duration:.3f}-{low})/{high - low:.3f},0),1)"

    tone = f"{SMART_TONE_MAX}*(0.5-0.5*cos(3.14159265*{progress(*SMART_TONE_WINDOW)}))"
    duck = f"0.5-0.5*cos(6.28318531*{progress(*SMART_DUCK_WINDOW)})"
    ramp = min(SMART_BASS_RAMP_SECONDS[1], max(SMART_BASS_RAMP_SECONDS[0], duration * 0.15))
    begin = start + duration * 0.5 - ramp / 2.0
    bass = f"0.5-0.5*cos(3.14159265*min(max((t-{begin:.3f})/{ramp:.3f},0),1))"
    return (f"lavfi=[asetnsamples=n={SMART_FILTER_FRAME_SAMPLES}[head];"
            + _wet_dry("head", "tone", f"highshelf=f={SMART_TONE_HZ}:g={SMART_TONE_DB}", tone)
            + _wet_dry("tone", "duck", f"equalizer=f={SMART_DUCK_HZ}:width_type=h:width="
                                        f"{SMART_DUCK_WIDTH_HZ}:g={SMART_DUCK_DB}", duck)
            + _wet_dry("duck", "", f"highpass=f={SMART_BASS_CUT_HZ}", bass)
            + "]")


def incoming_graph(skip, duration, ratio):
    """新歌的渐入图：只在重叠中段做一次人声频段轻降，窗口与旧歌那张对齐。

    新歌变速播放，按自己的媒体时间走表：从 skip 起，重叠长度乘上 stretch 系数。
    """
    length = max(0.1, duration * ratio)
    span = f"min(max(((t-{skip:.3f})/{length:.3f}-{SMART_DUCK_WINDOW[0]})/" \
           f"{SMART_DUCK_WINDOW[1] - SMART_DUCK_WINDOW[0]:.3f},0),1)"
    duck = f"0.5-0.5*cos(6.28318531*{span})"
    return (f"lavfi=[asetnsamples=n={SMART_FILTER_FRAME_SAMPLES}[head];"
            + _wet_dry("head", "", f"equalizer=f={SMART_DUCK_HZ}:width_type=h:width="
                                     f"{SMART_DUCK_WIDTH_HZ}:g={SMART_DUCK_DB}", duck)
            + "]")


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
        self.settle = None
        self.master_volume = None
        # 用户倍速与智能混音的变速是分开的：snapshot 回报的永远是用户的那一档。
        self.rate = 1.0
        self.closed = threading.Event()
        self.worker = None
        self.serial = 0
        self.transport_revision = 0
        # 歌单排序的分析结果缓存在进程里：按键是 trackId，换 URL 也能命中。
        self.features = {}
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
        gain = 1.0
        if fading:
            # 等拍点接入的新歌可能还按着，旧歌一走就得把声音接上；这个判断要在关进程之前做。
            resume = fading.get("waiting") and not fading["player"].property("pause", False)
            gain = max(0.5, min(2.0, self.number(fading.get("gain"), 1.0)))
            # 先静音再关，避免半途终止 mpv 时音频输出截断出响声。
            fading["player"].command("set_property", "volume", 0)
            fading["player"].close()
            if fading.get("filtered"):
                # 混音收场后把渐入图摘掉，新歌余下部分回到无滤镜直通。
                try:
                    self.mpv.command("set_property", "af", "")
                except (RuntimeError, OSError, socket.timeout):
                    pass
            if resume:
                self.mpv.command("set_property", "pause", False)
            self.mpv.command("set_property", "speed", self.rate)
        # 响度匹配增益缓慢放回用户音量：混音结束时音量不跳变。
        if self.master_volume is not None:
            if abs(gain - 1.0) > 0.01:
                self.settle = {"gain": gain, "start": time.monotonic()}
                self.mpv.command("set_property", "volume", self.master_volume * gain)
            else:
                self.settle = None
                self.mpv.command("set_property", "volume", self.master_volume)

    def settle_levels(self):
        """把响度匹配增益在 LEVEL_RELEASE_SECONDS 内平滑放回 1。"""
        settle = self.settle
        if not settle or self.fading or self.master_volume is None:
            return
        ratio = min(1.0, (time.monotonic() - settle["start"]) / LEVEL_RELEASE_SECONDS)
        if ratio >= 1.0:
            volume = self.master_volume
            self.settle = None
            self.master_volume = None
            self.mpv.command("set_property", "volume", volume)
            return
        gain = settle["gain"] + (1.0 - settle["gain"]) * ratio
        self.mpv.command("set_property", "volume", self.master_volume * gain)

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
                fallback = payload.get("fallback") if payload.get("fallback") in ("none", "force") else "normal"
                analysis = TransitionAnalysis(current_url, duration, url, maximum, MpvProcess.clean_environment(), mode, fallback)
                self.prepared = {"player": player, "from": self.track["trackId"],
                                 "track": self.metadata(payload), "analysis": analysis}
                if self.worker is None:
                    self.worker = threading.Thread(target=self.fade_loop, daemon=True)
                    self.worker.start()
                return {"prepared": True}
        except Exception:
            player.close()
            raise

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
                if self.settle:
                    try:
                        self.settle_levels()
                    except (RuntimeError, OSError):
                        self.settle = None

    def locked_onto_beat(self, player, target):
        """旧歌走到拍点的那一刻再放开新歌；距拍点 60 ms 内改用 4 ms 细轮询，消除主循环的错拍。"""
        deadline = time.monotonic() + 0.12
        while time.monotonic() < deadline:
            position = self.number(player.property("time-pos"), -1.0)
            if position < 0:
                return False
            if position >= target:
                return not player.property("pause", False)
            if player.property("pause", False) or player.property("eof-reached", False):
                return False
            speed = max(0.25, self.number(player.property("speed"), 1.0)) or 1.0
            if (target - position) / speed > 0.06:
                return False
            time.sleep(0.004)
        return False

    @staticmethod
    def arm_filters(outgoing, incoming, start, duration, skip, ratio):
        """接管时把两张渐变图一次挂好；个别 mpv 版本拒绝滤镜时静默退化成纯音量混音。

        实测运行时整体替换 af 链不爆音（无样本跳变、相位偏差 ≤2 采样），
        scaletempo 不受影响，且所有支路权重从 0 起步，挂图这一刻就是原声直通。
        """
        armed = False
        for player, graph in ((outgoing, outgoing_graph(start, duration)),
                              (incoming, incoming_graph(skip, duration, ratio))):
            try:
                player.command("set_property", "af", graph)
                armed = True
            except (RuntimeError, OSError, socket.timeout):
                pass
        return armed

    def update_fade(self):
        fading = self.fading
        if not fading:
            return
        player = fading["player"]
        if fading.get("waiting"):
            # 智能混音：到拍点才放开新歌，两边从这一刻同步走表。
            if self.locked_onto_beat(player, fading["start"]):
                fading["waiting"] = False
                # 低频交接图在接管时就挂好了，到重叠中段会自动让出低频。
                self.mpv.command("set_property", "pause", False)
                elapsed = max(0.0, self.number(player.property("time-pos"), fading["start"]) - fading["start"])
            else:
                elapsed = 0.0
        else:
            # 用音频时钟而非墙上时间，暂停/缓冲期间不会悄悄走完淡化。
            elapsed = max(0.0, self.number(player.property("time-pos"), fading["start"]) - fading["start"])
        if player.property("eof-reached", False):
            # 旧歌先到结尾时不必再等表走完，否则新歌会被压着不放声。
            elapsed = fading["duration"]
        progress = min(1.0, elapsed / fading["duration"])
        # 智能混音走 S 形进度（两头稳、中段交接）；普通淡化与回退保持原来的线性曲线。
        shape = fade_shape(progress) if fading.get("smart") else progress
        ramp = fading.get("ramp", 0.0)
        if ramp and elapsed > fading["duration"] - ramp:
            # 旧歌已经压到听不清之后，把新歌的变速平滑拉回用户倍速，避免收尾突然变速。
            ratio = min(1.0, max(0.0, (elapsed - (fading["duration"] - ramp)) / ramp))
            speed = fading["stretch"] + (1 - fading["stretch"]) * ratio
            if abs(speed - fading.get("speed", 1.0)) > 0.002:
                fading["speed"] = speed
                self.mpv.command("set_property", "speed", self.rate * speed)
        gain = max(0.5, min(2.0, self.number(fading.get("gain"), 1.0)))
        self.mpv.command("set_property", "volume", self.master_volume * gain * math.sin(shape * math.pi / 2))
        player.command("set_property", "volume", self.master_volume * math.cos(shape * math.pi / 2))
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
        # 上一段混音留下的响度补偿交给这段混音接管，不叠加。
        self.settle = None
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
                           "gain": timing["gain"], "speed": timing["stretch"],
                           "smart": bool(timing.get("smart"))}
            if self.fading["smart"]:
                # 两张渐变图随接管一次挂好：权重从 0 起步，等拍点期间都是原声直通，
                # 各频段到重叠中段（新歌已起量）自动交接，不再需要掐着拍点切。
                self.fading["filtered"] = self.arm_filters(
                    old, player, timing["start"], timing["duration"],
                    max(0.0, self.number(plan.get("skip"))), timing["stretch"])
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
            if self.fading or self.settle:
                self.master_volume = volume
                if self.fading:
                    self.update_fade()
                else:
                    self.settle_levels()
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
