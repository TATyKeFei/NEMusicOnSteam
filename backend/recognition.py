import base64
import hashlib
import json
import os
import select
import shutil
import subprocess
import threading
import time
import uuid
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DURATION = 6
SAMPLE_RATE = 8000
SAMPLE_BYTES = DURATION * SAMPLE_RATE * 4
ENGINE_BASE = "https://raw.githubusercontent.com/NeteaseCloudMusicApiEnhanced/api-enhanced/a8c781fd64faab17fedfd46e0615a2609307f163/public/audio_match_demo/"
ENGINE_FILES = (
    ("afp.wasm.js", "4926a6d69527a1afbc7f7d120b9c21947e677d80c484c8b65572fa7d4ce3b99f"),
    ("afp.js", "3776f3122d8a516d716ec00f55c24b919f03a2fb4bb009191007327170d33763"),
)


def load_engine():
    scripts = []
    for filename, digest in ENGINE_FILES:
        request = Request(ENGINE_BASE + filename, headers={"User-Agent": "NEMusicOnSteam"})
        with urlopen(request, timeout=15) as response:
            content = response.read(1024 * 1024)
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("识曲引擎校验失败，请更新插件后重试")
        scripts.append(content.decode("utf-8"))
    return "\n".join(scripts)


def recorder_command(source):
    if source not in ("system", "microphone"):
        raise ValueError("请选择系统声音或麦克风")
    device = "@DEFAULT_MONITOR@" if source == "system" else "@DEFAULT_SOURCE@"
    recorder = shutil.which("parec")
    if recorder:
        return [recorder, "--raw", "--format=float32le", "--rate=8000", "--channels=1", "--latency-msec=50",
                "--client-name=NEMusicOnSteam", "--stream-name=听歌识曲", "--device=" + device]
    recorder = shutil.which("ffmpeg")
    if recorder:
        return [recorder, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", device,
                "-t", str(DURATION), "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1"]
    raise ValueError("需要安装 parec（pulseaudio-utils / libpulse）或支持 PulseAudio 的 ffmpeg")


def match_fingerprint(fingerprint):
    if not isinstance(fingerprint, str) or not 8 <= len(fingerprint) <= 24000:
        raise ValueError("音频指纹无效")
    try:
        base64.b64decode(fingerprint, validate=True)
    except ValueError:
        raise ValueError("音频指纹无效")
    query = urlencode({"sessionId": uuid.uuid4().hex, "algorithmCode": "shazam_v2", "duration": DURATION,
                       "rawdata": fingerprint, "times": 1, "decrypt": 1})
    request = Request("https://interface.music.163.com/api/music/audio/match?" + query,
                      headers={"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"})
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read(1024 * 1024))
    if payload.get("code") != 200:
        raise ValueError("网易云识曲接口返回 " + str(payload.get("code", "未知错误")))
    results = []
    for item in (payload.get("data") or {}).get("result") or []:
        song = item.get("song") or {}
        song_id = song.get("id")
        if not isinstance(song_id, int) or song_id <= 0:
            continue
        artists = song.get("artists") or song.get("ar") or []
        album = song.get("album") or song.get("al") or {}
        results.append({"id": song_id, "name": str(song.get("name") or "未知歌曲"),
                        "artist": ", ".join(str(artist.get("name") or "") for artist in artists),
                        "album": str(album.get("name") or "")})
    return results[:10]


class RecognitionService:
    def __init__(self):
        self.lock = threading.Lock()
        self.engine_lock = threading.Lock()
        self.engine_source = None
        self.job = None
        self.process = None

    def engine(self):
        with self.engine_lock:
            if self.engine_source is None:
                self.engine_source = load_engine()
            return self.engine_source

    def snapshot(self):
        with self.lock:
            if self.job is None:
                return {"stage": "idle", "id": ""}
            return {key: value for key, value in self.job.items() if key != "updated"}

    def active(self):
        with self.lock:
            return self.job is not None and self.job["stage"] in ("recording", "recorded", "matching")

    def start(self, source):
        command = recorder_command(source)
        with self.lock:
            if self.job and self.job["stage"] in ("recording", "recorded", "matching"):
                raise ValueError("已有识曲任务，请先取消或等待完成")
            job = {"id": uuid.uuid4().hex, "stage": "recording", "source": source, "duration": DURATION,
                   "samples": "", "results": [], "error": "", "updated": time.monotonic()}
            self.job = job
        threading.Thread(target=self.record, args=(job, command), daemon=True).start()
        return job["id"]

    def update(self, job, **changes):
        with self.lock:
            if self.job is not job or job["stage"] == "cancelled":
                return False
            job.update(changes, updated=time.monotonic())
            return True

    def record(self, job, command):
        process = None
        try:
            with self.lock:
                if self.job is not job or job["stage"] == "cancelled":
                    return
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                self.process = process
            recording = bytearray()
            deadline = time.monotonic() + DURATION + 6
            while len(recording) < SAMPLE_BYTES:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise ValueError("录音超时，请检查默认音频设备和 PipeWire/PulseAudio 服务")
                chunk = os.read(process.stdout.fileno(), min(16384, SAMPLE_BYTES - len(recording)))
                if not chunk:
                    raise ValueError("无法采集声音，请检查默认音频设备和 PipeWire/PulseAudio 服务")
                recording.extend(chunk)
            self.update(job, stage="recorded", samples=base64.b64encode(recording).decode("ascii"))
        except (OSError, ValueError) as error:
            self.update(job, stage="error", error=str(error), samples="")
        finally:
            if process is not None:
                self.stop_process(process)
                process.stdout.close()
            with self.lock:
                if self.process is process:
                    self.process = None

    @staticmethod
    def stop_process(process):
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)
            except ProcessLookupError:
                pass

    def submit(self, job_id, fingerprint):
        if not isinstance(fingerprint, str) or len(fingerprint) > 24000:
            raise ValueError("音频指纹无效")
        with self.lock:
            job = self.job
            if not job or job["id"] != job_id or job["stage"] != "recorded":
                raise ValueError("识曲任务已结束，请重新开始")
            job.update(stage="matching", samples="", updated=time.monotonic())
        threading.Thread(target=self.match, args=(job, fingerprint), daemon=True).start()

    def match(self, job, fingerprint):
        try:
            self.update(job, stage="done", results=match_fingerprint(fingerprint))
        except Exception as error:
            self.update(job, stage="error", error=str(error))

    def cancel(self, job_id=None):
        with self.lock:
            if not self.job or (job_id is not None and self.job["id"] != job_id):
                return
            self.job.update(stage="cancelled", samples="")
            process = self.process
        if process is not None:
            self.stop_process(process)

    def expire(self):
        with self.lock:
            job_id = self.job["id"] if self.job and self.job["stage"] in ("recording", "recorded", "matching") and time.monotonic() - self.job["updated"] > 45 else None
        if job_id is not None:
            self.cancel(job_id)
