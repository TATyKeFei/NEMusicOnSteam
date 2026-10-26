import array
import math
import random
import unittest

from track_analysis import SAMPLE_RATE, camelot_key, estimate_bpm, key_estimate, sample_track, track_features


def groove(seconds, bpm, seed=1, accent=2.2, melody=True, intro=0.0, noise=0.002, offbeat=0.0):
    """合成一段有底鼓/军鼓/踩镲的 8 kHz 鼓点，重音落在小节头上。"""
    rng = random.Random(seed)
    total = int(seconds * SAMPLE_RATE)
    samples = array.array("f", bytes(4 * total))
    beat = 60.0 / bpm

    def add(position, length, render):
        start = int(position * SAMPLE_RATE)
        for i in range(max(0, int(length * SAMPLE_RATE))):
            index = start + i
            if 0 <= index < total:
                samples[index] += render(i / SAMPLE_RATE)

    position = intro
    count = 0
    while position < seconds:
        strength = 0.9 * (accent if count % 4 == 0 else 1.0)
        add(position, 0.18, lambda t, a=strength: a * math.sin(2 * math.pi * (55 + 40 * math.exp(-24 * t)) * t) * math.exp(-9 * t))
        if count % 4 in (1, 3):
            add(position, 0.12, lambda t: 0.35 * (rng.random() * 2 - 1) * math.exp(-30 * t))
        for half in (0.0, 0.5):
            add(position + beat * half, 0.05, lambda t: 0.12 * (rng.random() * 2 - 1) * math.exp(-60 * t))
        if offbeat:
            # 强八分音符：真实流行/电子里每拍之间还有一层重音，专门欺负只看峰覆盖率的检测。
            add(position + beat * 0.5, 0.12, lambda t: offbeat * (rng.random() * 2 - 1) * math.exp(-30 * t))
        position += beat
        count += 1
    if melody:
        for i in range(total):
            samples[i] += 0.12 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)
    for i in range(total):
        samples[i] += noise * (rng.random() * 2 - 1)
    return samples


class TempoEstimateTests(unittest.TestCase):
    def test_estimates_a_regular_drum_pattern(self):
        self.assertAlmostEqual(estimate_bpm(groove(20, 120)), 120, delta=0.5)

    def test_rejects_music_without_stable_drums(self):
        melody = array.array("f", [0.4 * math.sin(2 * math.pi * 330 * index / SAMPLE_RATE)
                                   for index in range(20 * SAMPLE_RATE)])
        self.assertIsNone(estimate_bpm(melody))

    def test_estimates_a_dense_eighth_note_pattern(self):
        self.assertAlmostEqual(estimate_bpm(groove(20, 120, offbeat=0.7, seed=5)), 120, delta=0.5)


def tones(seconds, frequencies, rate=SAMPLE_RATE):
    """一段简单叠加正弦的“和弦”，用来验证调性估计。"""
    samples = array.array("f", bytes(4 * int(seconds * rate)))
    for index in range(len(samples)):
        time = index / rate
        samples[index] = sum(math.sin(2 * math.pi * frequency * time) for frequency in frequencies) / len(frequencies)
    return samples


class TrackFeatureTests(unittest.TestCase):
    def test_camelot_wheel_positions_are_standard(self):
        for tonic, minor, expected in ((0, False, "8B"), (7, False, "9B"), (2, False, "10B"), (11, False, "1B"),
                                       (9, False, "11B"), (4, False, "12B"),
                                       (9, True, "8A"), (4, True, "9A"), (10, True, "3A"), (0, True, "5A")):
            self.assertEqual(camelot_key(tonic, minor), expected)

    def test_key_estimate_reads_synthetic_chords(self):
        self.assertEqual(key_estimate(tones(8, [261.63, 329.63, 392.00]))["key"], "8B")   # C 大三和弦
        self.assertEqual(key_estimate(tones(8, [220.00, 261.63, 329.63]))["key"], "8A")   # A 小三和弦
        self.assertEqual(key_estimate(tones(8, [261.63, 311.13, 392.00]))["key"], "5A")   # C 小三和弦

    def test_track_features_measure_tempo_energy_and_key(self):
        tail = groove(40, 120)
        mixed = array.array("f", (tail[index] * 0.7 + 0.5 * math.sin(2 * math.pi * 261.63 * index / SAMPLE_RATE)
                                  for index in range(len(tail))))
        features = track_features(mixed[:18 * SAMPLE_RATE])
        self.assertAlmostEqual(features["bpm"], 120.0, delta=0.5)
        self.assertGreater(features["energy"], 0.1)
        self.assertEqual(features["key"], "8B")
        self.assertIsInstance(features["keyConfidence"], float)

    def test_track_features_ignore_short_or_missing_samples(self):
        self.assertIsNone(track_features(None))
        self.assertIsNone(track_features(tones(1, [440.0])))

    def test_sample_track_returns_none_without_ffmpeg(self):
        self.assertIsNone(sample_track("https://audio.example/1.mp3", {"PATH": "/does/not/exist"}))


if __name__ == "__main__":
    unittest.main()
