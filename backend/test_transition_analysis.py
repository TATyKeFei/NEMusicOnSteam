import array
import math
import random
import unittest
from unittest.mock import patch

from transition_analysis import (SAMPLE_RATE, TransitionAnalysis, beat_grid, envelope, fade_timing,
                                 smart_plan, transition_plan)


def groove(seconds, bpm, seed=1, accent=2.2, melody=True, intro=0.0, noise=0.002):
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
        position += beat
        count += 1
    if melody:
        for i in range(total):
            samples[i] += 0.12 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)
    for i in range(total):
        samples[i] += noise * (rng.random() * 2 - 1)
    return samples


FALLBACK = {"seconds": 6, "skip": 0, "trim": 0, "analyzed": True}


class AnalysisTests(unittest.TestCase):
    def test_envelope_measures_signal_energy(self):
        raw = array.array("f", [0.5] * 800 + [0] * 800).tobytes()
        self.assertEqual(envelope(raw), [0.5, 0])

    def test_dense_music_uses_less_overlap_than_quiet_intros(self):
        dense = transition_plan([0.5] * 80, [0.5] * 80, 6)
        quiet = transition_plan([0.02] * 60 + [0.5] * 20, [0.02] * 60 + [0.5] * 20, 6)
        self.assertLess(dense["seconds"], quiet["seconds"])
        self.assertGreaterEqual(dense["seconds"], 1)

    def test_silence_trimming_is_bounded_and_missing_analysis_falls_back(self):
        plan = transition_plan([0.3] * 30 + [0] * 50, [0] * 50 + [0.3] * 30, 6)
        self.assertEqual(plan["skip"], 2)
        self.assertEqual(plan["trim"], 2)
        self.assertEqual(transition_plan([], [], 6), {"seconds": 6, "skip": 0, "trim": 0, "analyzed": False})

    def test_missing_ffmpeg_never_prevents_playback(self):
        with patch("transition_analysis.shutil.which", return_value=None):
            analysis = TransitionAnalysis("https://a/1", 100, "https://a/2", 6, {})
        self.assertEqual(analysis.result["seconds"], 6)
        self.assertFalse(analysis.result["analyzed"])
        analysis.close()


class BeatGridTests(unittest.TestCase):
    def test_finds_bpm_and_downbeat_of_a_real_drum_pattern(self):
        grid = beat_grid(groove(20, 120))
        self.assertAlmostEqual(grid["bpm"], 120, delta=0.5)
        self.assertAlmostEqual(grid["period"], 0.5, delta=0.005)
        self.assertIsNotNone(grid["bar"])
        self.assertLess(abs((grid["first"] - grid["phase"]) % grid["period"]), 0.06)

    def test_rejects_music_without_stable_drums(self):
        melody = array.array("f", [0.4 * math.sin(2 * math.pi * 330 * i / SAMPLE_RATE) for i in range(20 * SAMPLE_RATE)])
        self.assertIsNone(beat_grid(melody))


class SmartPlanTests(unittest.TestCase):
    def test_aligns_beats_and_stretches_within_eight_percent(self):
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2), 4, 40, FALLBACK)
        self.assertEqual(plan["mode"], "smart")
        self.assertEqual(plan["reason"], "beat-matched")
        self.assertAlmostEqual(plan["ratio"], 120 / 115.21, delta=0.01)
        self.assertLessEqual(plan["skip"], 2)
        # 开始和长度都落在拍点/四拍的整数倍上，重叠在 8–30 秒之间。
        offset = plan["startAt"] % plan["beatPeriod"]
        self.assertLess(min(offset, plan["beatPeriod"] - offset), 0.06)
        self.assertAlmostEqual(plan["seconds"] / plan["beatPeriod"], round(plan["seconds"] / plan["beatPeriod"]))
        self.assertEqual(round(plan["seconds"] / plan["beatPeriod"]) % 4, 0)
        self.assertGreaterEqual(plan["seconds"], 8)
        self.assertLessEqual(plan["seconds"], 30)
        self.assertGreaterEqual(plan["ramp"], 0)
        self.assertLessEqual(plan["startAt"] + plan["seconds"], 40)

    def test_skips_to_the_downbeat_when_the_intro_allows_it(self):
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2, intro=1.2), 4, 40, FALLBACK)
        self.assertTrue(plan["barAligned"])
        self.assertAlmostEqual(plan["skip"], 1.2, delta=0.12)

    def test_refuses_tempo_gaps_and_unstable_beats(self):
        gap = smart_plan(groove(40, 120), groove(40, 140, seed=2), 4, 40, FALLBACK)
        self.assertEqual((gap["mode"], gap["reason"]), ("normal", "tempo-gap"))
        melody = array.array("f", [0.4 * math.sin(2 * math.pi * 330 * i / SAMPLE_RATE) for i in range(20 * SAMPLE_RATE)])
        quiet = smart_plan(groove(40, 120), melody, 4, 40, FALLBACK)
        self.assertEqual((quiet["mode"], quiet["reason"]), ("normal", "unstable-beats"))

    def test_keeps_normal_plan_when_the_incoming_intro_has_no_beats_for_too_long(self):
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2, intro=5.0), 4, 40, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("normal", "late-intro-beat"))


class FadeTimingTests(unittest.TestCase):
    PLAN = {"mode": "smart", "startAt": 96.0, "seconds": 8.0, "trim": 0.0, "ratio": 1.05, "ramp": 1.5,
            "beatPeriod": 0.5, "skip": 0.25, "analyzed": True}

    def test_waits_for_the_beat_and_keeps_the_stretch(self):
        timing = fade_timing(self.PLAN, 94.5, 200)
        self.assertEqual(timing["start"], 96.0)
        self.assertTrue(timing["waiting"])
        self.assertEqual(timing["duration"], 8.0)
        self.assertAlmostEqual(timing["stretch"], 1.05)
        self.assertAlmostEqual(timing["ramp"], 1.5)

    def test_missed_beat_shifts_to_the_next_one_and_shortens_the_overlap(self):
        timing = fade_timing(self.PLAN, 96.6, 200)
        self.assertEqual(timing["start"], 97.0)
        self.assertAlmostEqual(timing["duration"], 7.0)
        self.assertTrue(timing["waiting"])

    def test_gives_up_alignment_when_adoption_is_too_late(self):
        timing = fade_timing(self.PLAN, 99.5, 100)
        self.assertEqual(timing["start"], 99.5)
        self.assertFalse(timing["waiting"])
        self.assertEqual(timing["stretch"], 1.0)
        self.assertEqual(timing["ramp"], 0.0)
        self.assertAlmostEqual(timing["duration"], 0.5)

    def test_normal_plans_keep_the_old_behaviour(self):
        timing = fade_timing({"seconds": 6, "skip": 1.0, "trim": 0.5, "analyzed": True}, 50, 60)
        self.assertEqual(timing, {"start": 50, "duration": 6, "stretch": 1.0, "ramp": 0.0, "waiting": False})
        without_end = fade_timing({"seconds": 6, "skip": 0, "trim": 0, "analyzed": True}, 50, 0)
        self.assertEqual(without_end["duration"], 6)


if __name__ == "__main__":
    unittest.main()
