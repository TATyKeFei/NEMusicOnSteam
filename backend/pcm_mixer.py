import array
import collections
import errno
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

from audio_source import audio_headers


SAMPLE_RATE = 48000
CHANNELS = 2
FRAME_BYTES = CHANNELS * 4
BLOCK_FRAMES = SAMPLE_RATE // 20
BUFFER_BLOCKS = 160
PROFILES = {
    "conservative": (3.0, 1.0, 0.04, 4),
    "standard": (3.6, 2.0, 0.04, 4),
    "eager": (5.0, 3.0, 0.06, 3),
}
RAW_OPTIONS = {
    "demuxer": "rawaudio",
    "demuxer-rawaudio-format": "floatle",
    "demuxer-rawaudio-rate": str(SAMPLE_RATE),
    "demuxer-rawaudio-channels": "stereo",
    "cache": "no",
    "demuxer-max-bytes": "32768",
    "demuxer-readahead-secs": "0",
    "audio-buffer": "0.1",
    "stream-buffer-size": "4096",
}


def floats(data):
    samples = array.array("f")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def energy(data):
    samples = floats(data)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0.0


def blend(current, following, progress, step):
    outgoing = floats(current)
    incoming = floats(following)
    for frame in range(len(outgoing) // CHANNELS):
        phase = min(1.0, progress + frame * step) * math.pi / 2
        gain_out = math.cos(phase)
        gain_in = math.sin(phase)
        for channel in range(CHANNELS):
            index = frame * CHANNELS + channel
            sample = outgoing[index] * gain_out + incoming[index] * gain_in
            amplitude = abs(sample)
            if amplitude > 0.95:
                sample = math.copysign(0.95 + 0.05 * (1 - math.exp(-(amplitude - 0.95) / 0.05)), sample)
            outgoing[index] = sample
    if sys.byteorder != "little":
        outgoing.byteswap()
    return outgoing.tobytes()


class Decoder:
    def __init__(self, payload, environment):
        executable = shutil.which("ffmpeg", path=environment.get("PATH"))
        if not executable:
            raise RuntimeError("歌曲衔接需要 ffmpeg，请先安装 ffmpeg")
        self.payload = dict(payload)
        self.condition = threading.Condition()
        self.blocks = collections.deque()
        self.buffered = 0
        self.eof = False
        self.error = ""
        self.closed = False
        self.consumed = 0
        self.intro_done = False
        position = max(0.0, float(payload.get("position") or 0))
        arguments = [executable, "-nostdin", "-v", "error", "-rw_timeout", "15000000"]
        if str(payload["url"]).startswith(("http://", "https://")):
            arguments += ["-headers", "".join(f"{key}: {value}\r\n" for key, value in audio_headers(payload["url"]).items())]
        if position:
            arguments += ["-ss", str(position)]
        arguments += ["-i", payload["url"], "-vn", "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
        self.process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=environment, close_fds=True)
        self.thread = threading.Thread(target=self.read, name="nemusic-decode", daemon=True)
        self.thread.start()

    def read(self):
        try:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or len(self.blocks) < BUFFER_BLOCKS)
                    if self.closed:
                        return
                data = self.process.stdout.read(BLOCK_FRAMES * FRAME_BYTES)
                if not data:
                    result = self.process.wait()
                    if result:
                        self.error = "ffmpeg 无法解码音频或网络连接中断"
                    return
                data = data[:len(data) // FRAME_BYTES * FRAME_BYTES]
                with self.condition:
                    self.blocks.append(data)
                    self.buffered += len(data) // FRAME_BYTES
                    self.condition.notify_all()
        except (OSError, ValueError):
            if not self.closed:
                self.error = "ffmpeg 音频管道中断"
        finally:
            with self.condition:
                self.eof = True
                self.condition.notify_all()

    def take(self, frames=BLOCK_FRAMES):
        with self.condition:
            if not self.blocks:
                return b"" if self.eof else None
            data = self.blocks.popleft()
            limit = frames * FRAME_BYTES
            if len(data) > limit:
                self.blocks.appendleft(data[limit:])
                data = data[:limit]
            count = len(data) // FRAME_BYTES
            self.buffered -= count
            self.consumed += count
            self.condition.notify_all()
            return data

    def skip_intro(self):
        while not self.intro_done and self.consumed < SAMPLE_RATE * 2:
            data = self.take(min(BLOCK_FRAMES, SAMPLE_RATE * 2 - self.consumed))
            if data is None:
                return False
            if not data:
                self.intro_done = True
                break
            samples = floats(data)
            onset = next((index // CHANNELS for index in range(0, len(samples), CHANNELS)
                          if max(abs(samples[index]), abs(samples[index + 1])) >= 0.0015), None)
            if onset is not None:
                remaining = data[onset * FRAME_BYTES:]
                with self.condition:
                    self.blocks.appendleft(remaining)
                    self.buffered += len(remaining) // FRAME_BYTES
                    self.consumed -= len(remaining) // FRAME_BYTES
                self.intro_done = True
        if self.consumed >= SAMPLE_RATE * 2:
            self.intro_done = True
        return self.intro_done

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.thread.join(timeout=2)
        self.process.stdout.close()


class PcmMixer:
    def __init__(self, runtime_dir, payload, profile, environment, clock):
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.clock = clock
        self.profile = PROFILES[profile]
        self.environment = environment
        self.rate = 1.0
        self.current = Decoder(payload, environment)
        self.following = None
        self.revision = -1
        self.rendered = 0
        self.quiet_windows = 0
        self.fade_progress = None
        self.fade_seconds = 0
        self.error = ""
        self.identifier = uuid.uuid4().hex
        self.events = [(0, self.current.payload, float(payload.get("position") or 0), "", "")]
        self.fifo = os.path.join(runtime_dir, "pcm-" + self.identifier)
        try:
            os.mkfifo(self.fifo, 0o600)
        except OSError:
            self.current.close()
            raise
        self.thread = threading.Thread(target=self.run, name="nemusic-pcm", daemon=True)

    def start(self):
        self.thread.start()

    def prepare(self, payload):
        with self.lock:
            if self.closed.is_set() or payload.get("fromTrackId") != self.current.payload.get("trackId"):
                return False
            revision = int(payload.get("revision", 0))
            if revision <= self.revision:
                return False
            self.revision = revision
            if self.fade_progress is not None:
                return False
            previous = self.following
            self.following = Decoder(payload, self.environment) if payload.get("url") else None
            self.error = ""
            if previous:
                previous.close()
            return True

    def view(self, seconds):
        with self.lock:
            frame = max(0, int(seconds * SAMPLE_RATE))
            while len(self.events) > 1 and self.events[1][0] <= frame:
                self.events.pop(0)
            start, payload, position, handoff, source = self.events[0]
            return {"payload": dict(payload), "position": position + max(0, frame - start) / SAMPLE_RATE,
                    "handoffId": handoff, "handoffFrom": source,
                    "queuedTrackId": self.following.payload.get("trackId", "") if self.following else "",
                    "error": self.error or self.current.error}

    def render(self):
        with self.lock:
            current = self.current
            following = self.following
            if current.eof and not current.error:
                current.payload["duration"] = float(current.payload.get("position") or 0) + (current.consumed + current.buffered) / SAMPLE_RATE
            if following and following.eof and not following.error:
                following.payload["duration"] = (following.consumed + following.buffered) / SAMPLE_RATE
            data = current.take()
            if data is None:
                return None
            if following and following.error:
                self.error = following.error
                following.close()
                self.following = following = None
                self.fade_progress = None
            if following and self.fade_progress is None:
                ready = following.skip_intro()
                duration = max(0.0, float(current.payload.get("duration") or 0))
                position = float(current.payload.get("position") or 0) + current.consumed / SAMPLE_RATE
                remaining = max(0.0, duration - position)
                maximum, search, threshold, windows = self.profile
                quiet = energy(data) < threshold if duration and remaining <= (maximum + search) * self.rate else False
                self.quiet_windows = self.quiet_windows + 1 if quiet else 0
                next_duration = max(0, float(following.payload.get("duration") or 0) - following.consumed / SAMPLE_RATE)
                fade = min(maximum * self.rate, remaining, next_duration / 2) if next_duration else 0
                enough = following.buffered >= int(min(fade + 0.15, 5.5) * SAMPLE_RATE) or following.eof
                if ready and enough and following.buffered and (not data or (fade > 0 and (
                        self.quiet_windows >= windows or remaining <= maximum * self.rate))):
                    self.fade_progress = 0.0
                    self.fade_seconds = max(0.05, fade / self.rate)
            if self.fade_progress is not None and following:
                incoming = following.take(len(data) // FRAME_BYTES if data else BLOCK_FRAMES)
                if incoming is None:
                    if data:
                        data = blend(data, bytes(len(data)), self.fade_progress, 0)
                    return data or None
                if not incoming:
                    following.close()
                    self.following = None
                    self.fade_progress = None
                    return data
                if data:
                    count = min(len(data), len(incoming))
                    incoming = incoming[:count] + bytes(max(0, len(data) - count))
                    step = 1 / (self.fade_seconds * SAMPLE_RATE * self.rate)
                    data = blend(data, incoming, self.fade_progress, step)
                    self.fade_progress = min(1.0, self.fade_progress + len(data) / FRAME_BYTES * step)
                else:
                    data = incoming
                    self.fade_progress = 1.0
                if self.fade_progress >= 1.0:
                    boundary = self.rendered + len(data) // FRAME_BYTES
                    handoff = self.identifier + ":" + str(boundary)
                    self.events.append((boundary, following.payload, following.consumed / SAMPLE_RATE,
                                        handoff, str(current.payload.get("trackId") or "")))
                    self.current = following
                    self.following = None
                    self.fade_progress = None
                    self.quiet_windows = 0
                    current.close()
            return data

    def run(self):
        descriptor = None
        try:
            while not self.closed.is_set() and descriptor is None:
                try:
                    descriptor = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
                except OSError as error:
                    if error.errno != errno.ENXIO:
                        raise
                    self.closed.wait(0.01)
            while not self.closed.is_set() and descriptor is not None:
                played = max(0.0, float(self.clock() or 0))
                if self.closed.is_set():
                    break
                if self.rendered / SAMPLE_RATE > played + 0.4:
                    self.closed.wait(0.01)
                    continue
                data = self.render()
                if data is None:
                    self.closed.wait(0.01)
                    continue
                if not data:
                    return
                pending = memoryview(data)
                while pending and not self.closed.is_set():
                    try:
                        written = os.write(descriptor, pending)
                        pending = pending[written:]
                    except BlockingIOError:
                        self.closed.wait(0.01)
                with self.lock:
                    self.rendered += len(data) // FRAME_BYTES
        except (OSError, RuntimeError, ValueError) as error:
            if not self.closed.is_set():
                self.error = str(error)
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def close(self):
        self.closed.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=3)
        with self.lock:
            self.current.close()
            if self.following:
                self.following.close()
                self.following = None
        try:
            os.unlink(self.fifo)
        except FileNotFoundError:
            pass
