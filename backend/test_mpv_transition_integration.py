"""显式启用的真实 mpv/ffmpeg 检查，使用空音频输出，不向扬声器播放。"""
import contextlib
import functools
import math
import os
import random
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from mpv_helper import MpvService

RATE = 8000


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def write_wave(path, seconds, render):
    with wave.open(path, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        frames = bytearray()
        for i in range(int(seconds * RATE)):
            value = max(-1.0, min(1.0, render(i / RATE)))
            frames += struct.pack("<h", round(value * 8000))
        output.writeframes(bytes(frames))


def write_groove(path, seconds, bpm, seed=1):
    """底鼓每拍、踩镲半拍，供节拍分析识别；重音让小节头可判。"""
    rng = random.Random(seed)
    beat = 60.0 / bpm
    accents = {0: 2.2}

    def render(t):
        phase = t % beat
        beat_index = int(t / beat)
        strength = 0.8 * accents.get(beat_index % 4, 1.0)
        value = strength * math.sin(2 * math.pi * (55 + 40 * math.exp(-24 * phase)) * phase) * math.exp(-9 * phase)
        if phase < 0.05:
            value += 0.15 * (rng.random() * 2 - 1) * math.exp(-60 * phase)
        return value

    write_wave(path, seconds, render)


def write_tone(path, seconds, frequency):
    write_wave(path, seconds, lambda t: 0.75 * math.sin(2 * math.pi * frequency * t))


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@contextlib.contextmanager
def transition_harness(tracks):
    """在临时目录起一个 HTTP 源，用 --ao=null 启动真实 mpv。"""
    popen = subprocess.Popen

    def silent_popen(args, **kwargs):
        if os.path.basename(args[0]) == "mpv":
            args = [*args, "--no-config", "--ao=null"]
        return popen(args, **kwargs)

    with tempfile.TemporaryDirectory(prefix="nemusic-transition-") as directory:
        for name, build in tracks.items():
            build(os.path.join(directory, name))
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=directory))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with patch("mpv_helper.subprocess.Popen", side_effect=silent_popen):
                service = MpvService(directory, "test-token")
                try:
                    yield service, f"http://127.0.0.1:{server.server_port}"
                finally:
                    service.close()
                    service.server.server_close()
        finally:
            server.shutdown()
            server.server_close()


@unittest.skipUnless(os.environ.get("NEMUSIC_TEST_REAL_MPV") == "1" and shutil.which("mpv") and shutil.which("ffmpeg"),
                     "set NEMUSIC_TEST_REAL_MPV=1 to exercise real mpv/ffmpeg")
class RealMpvTransitionTests(unittest.TestCase):
    def test_preload_analysis_pause_and_decoder_handoff(self):
        tracks = {
            "one.wav": lambda path: write_tone(path, 10, 440),
            "two.wav": lambda path: write_tone(path, 10, 660),
        }
        with transition_harness(tracks) as (service, base):
            service.load({"url": base + "/one.wav", "title": "One", "trackId": "1", "volume": 0.4})
            self.assertTrue(wait_for(lambda: service.snapshot()["position"] > 0.2))
            self.assertTrue(service.prepare({"url": base + "/two.wav", "title": "Two", "trackId": "2", "from": "1", "seconds": 6})["prepared"])
            self.assertTrue(wait_for(lambda: service.snapshot().get("transition", {}).get("ready")))
            self.assertTrue(wait_for(lambda: service.snapshot()["transition"]["analyzed"]))
            service.command({"action": "setposition", "value": 7_000_000})
            # 用户 seek 会清掉预加载，重新准备后再接管。
            service.prepare({"url": base + "/two.wav", "title": "Two", "trackId": "2", "from": "1", "seconds": 6})
            self.assertTrue(wait_for(lambda: service.snapshot()["transition"]["ready"]))
            self.assertTrue(wait_for(lambda: service.snapshot()["transition"]["analyzed"]))
            old = service.mpv
            state = service.load({"url": base + "/two.wav", "title": "Two", "trackId": "2", "from": "1", "transition": True,
                                  "transportRevision": service.transport_revision, "volume": 0.4})
            self.assertTrue(state["transitioned"])
            self.assertEqual(state["trackId"], "2")
            self.assertTrue(state["transitioning"])
            self.assertIsNotNone(service.fading)
            start = service.fading["start"]
            duration = service.fading["duration"]
            old_position = old.property("time-pos")
            previous_in, previous_out = 0, 40
            for progress in (0.2, 0.5, 0.8):
                self.assertTrue(wait_for(lambda: old.property("time-pos") >= start + duration * progress))
                service.command({"action": "pause"})
                with service.operations:
                    self.assertIsNotNone(service.fading, "tail must survive throughout the overlap")
                    service.update_fade()
                    incoming = service.mpv.property("volume")
                    outgoing = old.property("volume")
                    self.assertGreater(incoming, previous_in)
                    self.assertLess(incoming, 40)
                    self.assertGreater(outgoing, 0)
                    self.assertLess(outgoing, previous_out)
                    self.assertAlmostEqual(incoming ** 2 + outgoing ** 2, 40 ** 2, delta=2)
                    self.assertGreater(old.property("time-pos"), old_position)
                    self.assertIsNone(old.process.poll())
                    self.assertTrue(service.mpv.property("pause"))
                    self.assertTrue(old.property("pause"))
                    paused_position = service.snapshot()["position"]
                time.sleep(0.2)
                self.assertLess(abs(service.snapshot()["position"] - paused_position), 0.1)
                previous_in, previous_out = incoming, outgoing
                old_position = old.property("time-pos")
                service.command({"action": "play"})
            self.assertTrue(wait_for(lambda: service.fading is None))
            self.assertTrue(wait_for(lambda: old.process.poll() is not None))
            self.assertAlmostEqual(service.snapshot()["volume"], 0.4)

    def test_smart_transition_waits_for_the_beat_and_stretches_the_next_track(self):
        tracks = {
            "tail.wav": lambda path: write_groove(path, 18, 120, seed=1),
            "head.wav": lambda path: write_groove(path, 18, 115.2, seed=2),
        }
        with transition_harness(tracks) as (service, base):
            service.load({"url": base + "/tail.wav", "title": "Tail", "trackId": "1", "volume": 0.5})
            self.assertTrue(wait_for(lambda: service.snapshot()["position"] > 1.0))
            self.assertTrue(service.prepare({"url": base + "/head.wav", "title": "Head", "trackId": "2", "from": "1",
                                             "seconds": 6, "mode": "smart"})["prepared"])
            self.assertTrue(wait_for(lambda: service.snapshot().get("transition", {}).get("ready")))
            self.assertTrue(wait_for(lambda: service.snapshot()["transition"]["analyzed"], timeout=20))
            plan = service.snapshot()["transition"]
            # 分析线程已经识别出鼓点并给出了拍点计划，前端因此能提前触发。
            self.assertEqual(plan["mode"], "smart")
            self.assertIsNotNone(plan["startAt"])
            old = service.mpv
            state = service.load({"url": base + "/head.wav", "title": "Head", "trackId": "2", "from": "1",
                                  "transition": True, "transportRevision": service.transport_revision, "volume": 0.5})
            self.assertTrue(state["transitioned"])
            fading = service.fading
            self.assertIsNotNone(fading)
            # 120 / 115.2：新歌要被加快约 4%，并且先从拍点等待再出声。
            self.assertAlmostEqual(fading["stretch"], 120 / 115.21, delta=0.01)
            self.assertGreater(fading["stretch"], 1.0)
            self.assertTrue(wait_for(lambda: not service.mpv.property("pause", True), timeout=6))
            time.sleep(1.0)
            first_old, first_new = old.property("time-pos"), service.mpv.property("time-pos")
            time.sleep(1.5)
            second_old, second_new = old.property("time-pos"), service.mpv.property("time-pos")
            # 混音中两首歌都在走表，新歌的消耗速度就是时间拉伸系数。
            self.assertGreater(second_old - first_old, 0.5)
            self.assertAlmostEqual((second_new - first_new) / (second_old - first_old), fading["stretch"], delta=0.06)
            # 用户拖动进度会结束混音，另一路立即恢复原速。
            service.command({"action": "setposition", "value": 5_000_000})
            self.assertTrue(wait_for(lambda: service.fading is None))
            self.assertEqual(service.snapshot()["playbackStatus"], "Playing")
            self.assertEqual(service.mpv.property("speed"), 1.0)


if __name__ == "__main__":
    unittest.main()
