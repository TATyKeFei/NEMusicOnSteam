import array
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from unittest.mock import patch

from mpv_helper import MpvProcess, MpvService
from pcm_mixer import BLOCK_FRAMES, BUFFER_BLOCKS, FRAME_BYTES, SAMPLE_RATE, Decoder, PcmMixer, blend, energy, floats


def make_audio(path, seconds, frequency=440, silence=0):
    samples = array.array("h")
    for frame in range(int(seconds * SAMPLE_RATE)):
        sample = int(6000 * math.sin(math.tau * frequency * frame / SAMPLE_RATE)) if frame >= silence * SAMPLE_RATE else 0
        samples.extend((sample, sample))
    with wave.open(path, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(samples.tobytes())


def wait_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("audio operation timed out")


class BlendTests(unittest.TestCase):
    def test_stereo_uses_the_same_gain_and_equal_power(self):
        current = array.array("f", [0.4, -0.4] * 4).tobytes()
        following = array.array("f", [0.2, -0.2] * 4).tobytes()
        samples = floats(blend(current, following, 0.5, 0))
        self.assertAlmostEqual(samples[0], 0.6 / math.sqrt(2), places=6)
        for frame in range(4):
            self.assertEqual(samples[frame * 2], -samples[frame * 2 + 1])

    def test_peak_protection_is_finite_and_below_full_scale(self):
        data = array.array("f", [1, -1] * 16).tobytes()
        result = floats(blend(data, data, 0.5, 0))
        self.assertTrue(all(math.isfinite(sample) and abs(sample) <= 1 for sample in result))
        self.assertGreater(result[0], 0.95)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
class MixerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nemusic-mixer-test-")
        self.addCleanup(self.directory.cleanup)
        self.first = os.path.join(self.directory.name, "first.wav")
        self.second = os.path.join(self.directory.name, "second.wav")
        make_audio(self.first, 5)
        make_audio(self.second, 8, 660, silence=0.2)
        self.environment = MpvProcess.clean_environment()

    def mixer(self):
        mixer = PcmMixer(self.directory.name, {"url": self.first, "title": "first", "trackId": "1", "duration": 5},
                         "standard", self.environment, lambda: 0)
        self.addCleanup(mixer.close)
        return mixer

    def test_decoder_is_bounded_and_closes_children(self):
        decoder = Decoder({"url": self.second}, self.environment)
        self.addCleanup(decoder.close)
        wait_until(lambda: decoder.buffered >= BUFFER_BLOCKS * BLOCK_FRAMES or decoder.eof)
        self.assertLessEqual(decoder.buffered, BUFFER_BLOCKS * BLOCK_FRAMES)
        decoder.close()
        self.assertFalse(decoder.thread.is_alive())
        self.assertIsNotNone(decoder.process.poll())

    def test_handoff_preserves_the_single_timeline_and_skips_only_silence(self):
        mixer = self.mixer()
        self.assertTrue(mixer.prepare({"url": self.second, "title": "second", "trackId": "2", "duration": 8,
                                       "fromTrackId": "1", "revision": 1}))
        wait_until(lambda: mixer.following.buffered > 4 * SAMPLE_RATE)
        wait_until(lambda: mixer.current.eof)
        audio = bytearray()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = mixer.render()
            if data is None:
                time.sleep(0.001)
                continue
            if not data:
                break
            audio.extend(data)
            mixer.rendered += len(data) // FRAME_BYTES
        else:
            self.fail("mixer did not finish")
        self.assertEqual(len(mixer.events), 2)
        boundary = mixer.events[1][0] / SAMPLE_RATE
        self.assertAlmostEqual(boundary, 5, delta=0.15)
        before = mixer.view(boundary - 0.01)
        after = mixer.view(boundary + 0.01)
        self.assertEqual(before["payload"]["trackId"], "1")
        self.assertEqual(after["payload"]["trackId"], "2")
        self.assertGreater(after["position"], 3.5)
        self.assertEqual(after["handoffFrom"], "1")
        self.assertTrue(after["handoffId"])
        self.assertTrue(all(abs(sample) <= 1 for sample in floats(audio)))
        for frame in range(0, len(audio) // FRAME_BYTES, BLOCK_FRAMES):
            self.assertGreater(energy(audio[frame * FRAME_BYTES:(frame + BLOCK_FRAMES) * FRAME_BYTES]), 0.01)

    def test_cancel_rejects_stale_preparation_and_removes_fifo(self):
        mixer = self.mixer()
        payload = {"url": self.second, "trackId": "2", "fromTrackId": "1", "revision": 2}
        self.assertTrue(mixer.prepare(payload))
        decoder = mixer.following
        self.assertTrue(mixer.prepare({"fromTrackId": "1", "revision": 3}))
        self.assertIsNone(mixer.following)
        self.assertIsNotNone(decoder.process.poll())
        self.assertFalse(mixer.prepare(payload))
        self.assertFalse(mixer.prepare({**payload, "fromTrackId": "old", "revision": 4}))
        mixer.close()
        self.assertFalse(os.path.exists(mixer.fifo))

    def test_failed_next_decode_keeps_current_audio(self):
        mixer = self.mixer()
        mixer.prepare({"url": self.second + ".missing", "trackId": "2", "fromTrackId": "1", "revision": 1})
        wait_until(lambda: mixer.following.eof and mixer.current.buffered)
        self.assertGreater(energy(mixer.render()), 0.01)
        self.assertIsNone(mixer.following)
        self.assertIn("ffmpeg", mixer.error)

    def test_underrun_holds_gain_and_rate_change_preserves_fade_progress(self):
        mixer = self.mixer()
        mixer.prepare({"url": self.second, "trackId": "2", "duration": 8, "fromTrackId": "1", "revision": 1})
        wait_until(lambda: mixer.following.buffered > 4 * SAMPLE_RATE and mixer.current.eof)
        while mixer.fade_progress is None:
            data = mixer.render()
            mixer.rendered += len(data) // FRAME_BYTES
        progress = mixer.fade_progress
        following = mixer.following
        with patch.object(following, "take", return_value=None):
            data = mixer.render()
            mixer.rendered += len(data) // FRAME_BYTES
        self.assertEqual(mixer.fade_progress, progress)
        self.assertGreater(energy(data), 0.01)
        mixer.rate = 2
        data = mixer.render()
        expected_step = len(data) / FRAME_BYTES / (mixer.fade_seconds * SAMPLE_RATE * 2)
        self.assertAlmostEqual(mixer.fade_progress, progress + expected_step)

    def test_intro_scan_preserves_first_audible_frame_and_has_a_limit(self):
        make_audio(self.second, 4, silence=3)
        decoder = Decoder({"url": self.second}, self.environment)
        self.addCleanup(decoder.close)
        wait_until(lambda: decoder.eof)
        self.assertTrue(decoder.skip_intro())
        self.assertEqual(decoder.consumed, 2 * SAMPLE_RATE)
        self.assertEqual(energy(decoder.take()), 0)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("mpv"), "mpv and ffmpeg are required")
class PcmOutputTests(unittest.TestCase):
    def test_real_mpv_uses_one_stream_and_keeps_pause_and_seek(self):
        with tempfile.TemporaryDirectory(prefix="nemusic-pcm-output-") as directory:
            first = os.path.join(directory, "first.wav")
            second = os.path.join(directory, "second.wav")
            make_audio(first, 4)
            make_audio(second, 6, 660)
            original_popen = subprocess.Popen

            def launch(arguments, **kwargs):
                if arguments[0].endswith("mpv"):
                    arguments = [*arguments, "--no-config", "--ao=null"]
                return original_popen(arguments, **kwargs)

            with patch("mpv_helper.subprocess.Popen", side_effect=launch), patch.object(MpvService, "start_http"):
                service = MpvService(directory, "token")
            try:
                with patch.object(service, "validate", side_effect=lambda payload: payload["url"]):
                    service.load({"url": first, "title": "first", "trackId": "1", "duration": 4,
                                  "autoplay": True, "crossfade": "standard"})
                    mixer = service.mixer
                    service.prepare({"url": second, "title": "second", "trackId": "2", "duration": 6,
                                     "fromTrackId": "1", "revision": 1, "crossfade": "standard", "streamId": mixer.identifier})
                    process = service.mpv.process.pid
                    wait_until(lambda: service.snapshot()["trackId"] == "2", timeout=9)
                    state = service.snapshot()
                    self.assertGreater(state["position"], 2)
                    self.assertEqual(service.mpv.process.pid, process)
                    self.assertEqual(service.mpv.property("path"), mixer.fifo)
                    service.command({"action": "pause"})
                    position = service.snapshot()["position"]
                    time.sleep(0.15)
                    self.assertAlmostEqual(service.snapshot()["position"], position, delta=0.08)
                    service.command({"action": "setposition", "value": 1_000_000})
                    self.assertAlmostEqual(service.snapshot()["position"], 1, delta=0.1)
                    self.assertFalse(os.path.exists(mixer.fifo))
                    self.assertEqual(service.snapshot()["playbackStatus"], "Paused")
                    self.assertFalse(service.prepare({"fromTrackId": "2", "revision": 9,
                                                      "streamId": mixer.identifier})["accepted"])
            finally:
                service.close()
            self.assertFalse(any(thread.name in ("nemusic-pcm", "nemusic-decode") for thread in threading.enumerate()))
