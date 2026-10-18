import array
import math
import random
import threading
import unittest
from unittest.mock import patch

from transition_analysis import (SAMPLE_RATE, SMART_WINDOW, TransitionAnalysis, beat_grid, camelot_key, envelope,
                                 fade_timing, key_estimate, sample_track, smart_plan, tempo_stretch, track_features,
                                 transition_plan, vocal_activity, vocal_busy)


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


def sing(samples, start, stop, level=0.5, freq=520):
    """给一段鼓点叠上“人声”：带轻微颤音和乐句起伏的中频主音，唱到 stop 收声。"""
    total = len(samples)
    first, last = int(start * SAMPLE_RATE), min(int(stop * SAMPLE_RATE), total)
    for i in range(first, last):
        t = i / SAMPLE_RATE
        wobble = 1.0 + 0.02 * math.sin(2 * math.pi * 5.5 * t)
        env = 0.65 + 0.35 * math.sin(2 * math.pi * 1.7 * t)
        samples[i] += level * env * math.sin(2 * math.pi * freq * wobble * t)
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

    def test_none_fallback_marks_the_plan_before_the_analysis_finishes(self):
        # 不做混音：分析没出结果前就要挡住普通淡化接管，等旧歌自然播完。
        with patch("transition_analysis.shutil.which", return_value=None):
            analysis = TransitionAnalysis("https://a/1", 100, "https://a/2", 6, {}, "smart", "none")
        self.assertEqual((analysis.result["mode"], analysis.result["reason"]), ("none", "analysis-unavailable"))
        analysis.close()
        with patch("transition_analysis.shutil.which", return_value=None):
            plain = TransitionAnalysis("https://a/1", 100, "https://a/2", 6, {}, "smart", "normal")
        self.assertEqual(plain.result["mode"], "normal")
        plain.close()

    def test_none_fallback_downgrades_a_plain_analysis_result(self):
        analysis = TransitionAnalysis.__new__(TransitionAnalysis)
        analysis.mode = "smart"
        analysis.fallback = "none"
        analysis.cancelled = threading.Event()
        analysis.result = {}
        rng = random.Random(9)
        raw = array.array("f", [0.3 * (rng.random() * 2 - 1) for _ in range(12 * SAMPLE_RATE)]).tobytes()
        with patch.object(TransitionAnalysis, "read", return_value=raw):
            analysis.run("https://a/1", 100, "https://a/2", 6, {})
        self.assertEqual(analysis.result["mode"], "none")
        self.assertNotEqual(analysis.result["reason"], "analysis-unavailable")


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

    def test_keeps_the_beat_of_a_dense_eighth_note_pattern(self):
        # 回归：真实流行/电子在每拍之间还有一层强八分音符，旧的峰覆盖率门限把它们
        # 全部判成“没有稳定鼓点”，连着好几首歌都回退普通模式。
        grid = beat_grid(groove(20, 120, offbeat=0.7, seed=5))
        self.assertIsNotNone(grid)
        self.assertAlmostEqual(grid["bpm"], 120, delta=0.5)


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

    def test_force_tries_simple_cross_relations_within_the_same_speed_limit(self):
        # 120 对 160 是 3:4 关系：四拍对三拍，0% 变速，拍点仍然锁住，只有尽力模式接。
        strict = smart_plan(groove(40, 120), groove(40, 160, seed=2), 4, 40, FALLBACK)
        self.assertEqual((strict["mode"], strict["reason"]), ("normal", "tempo-gap"))
        plan = smart_plan(groove(40, 120), groove(40, 160, seed=2), 4, 40, FALLBACK, force=True)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertAlmostEqual(plan["ratio"], 1.0, delta=0.02)
        self.assertGreaterEqual(plan["seconds"], 8)

    def test_force_keeps_a_strict_success_unchanged(self):
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2), 4, 40, FALLBACK, force=True)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertAlmostEqual(plan["ratio"], 120 / 115.2, delta=0.01)

    def test_force_stretches_the_detection_range_for_slow_grooves(self):
        # 66 BPM 的拍点落在保守范围的边缘外：严格模式拒绝，尽力模式仍然锁住。
        self.assertIsNone(beat_grid(groove(20, 66)))
        grid = beat_grid(groove(20, 66), force=True)
        self.assertIsNotNone(grid)
        self.assertAlmostEqual(grid["bpm"], 66, delta=0.6)

    def test_force_skips_a_quiet_long_intro_instead_of_giving_up(self):
        strict = smart_plan(groove(40, 120), groove(40, 115.2, seed=2, intro=5.0), 4, 40, FALLBACK)
        self.assertEqual((strict["mode"], strict["reason"]), ("normal", "late-intro-beat"))
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2, intro=5.0), 4, 40, FALLBACK, force=True)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        # 跳过静音前奏，从第一个拍点起唱。
        self.assertGreaterEqual(plan["skip"], 4.5)

    def test_matches_half_speed_neighbours_without_stretching(self):
        # 88 与 176 是半速/倍速关系：按「两拍对一拍」混，几乎不变速，拍点仍然锁住。
        plan = smart_plan(groove(40, 88), groove(40, 176, seed=2), 4, 40, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertAlmostEqual(plan["ratio"], 1.0, delta=0.05)
        self.assertAlmostEqual(plan["fromBpm"], 88, delta=0.5)
        self.assertAlmostEqual(plan["toBpm"], 176, delta=1.0)
        reverse = smart_plan(groove(40, 176, seed=2), groove(40, 88), 4, 40, FALLBACK)
        self.assertEqual(reverse["mode"], "smart")
        self.assertAlmostEqual(reverse["ratio"], 1.0, delta=0.05)

    def test_keeps_normal_plan_when_the_incoming_intro_has_no_beats_for_too_long(self):
        plan = smart_plan(groove(40, 120), groove(40, 115.2, seed=2, intro=5.0), 4, 40, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("normal", "late-intro-beat"))

    def test_mixes_a_musical_intro_instead_of_giving_up(self):
        # 长前奏里有内容时，从最前面的拍点起混：前奏叠在旧歌收尾上，鼓点进来依旧踩拍。
        head = sing(groove(40, 115.2, seed=2, intro=5.0), 0, 5.0, level=0.45)
        plan = smart_plan(groove(40, 120), head, 4, 40, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertLess(plan["skip"], 1.0)

    def test_long_loud_ending_still_gets_a_beat_matched_mix(self):
        # 回归：小节对齐会把起点提前最多一小节，旧检查按“离结尾 30 秒”二次拒绝，
        # 56 秒的歌有一半概率悄悄退回普通淡化。有力收尾现在最多混 8 小节。
        tail = groove(56, 120)[-SMART_WINDOW * SAMPLE_RATE:]
        head = groove(56, 115.2, seed=2)[:SMART_WINDOW * SAMPLE_RATE]
        plan = smart_plan(tail, head, 20, 56, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertLessEqual(plan["seconds"], 16.5)
        self.assertLessEqual(plan["startAt"] + plan["seconds"], 56)

    def test_quiet_outro_allows_a_long_mix_until_the_real_song_end(self):
        tail = groove(60, 120)
        for index in range(int(34 * SAMPLE_RATE), len(tail)):
            tail[index] *= 0.05
        plan = smart_plan(tail[-SMART_WINDOW * SAMPLE_RATE:],
                          groove(60, 115.2, seed=2)[:SMART_WINDOW * SAMPLE_RATE], 24, 60, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertGreater(plan["seconds"], 20)
        self.assertLessEqual(plan["seconds"], 30)
        self.assertLessEqual(plan["startAt"] + plan["seconds"], 60)

    def test_matches_loudness_between_the_two_songs(self):
        even = smart_plan(groove(40, 120), groove(40, 115.2, seed=2), 4, 40, FALLBACK)
        self.assertAlmostEqual(even["gain"], 1.0, delta=0.2)
        quiet_head = groove(40, 115.2, seed=2)
        for index in range(len(quiet_head)):
            quiet_head[index] *= 0.5
        quieter = smart_plan(groove(40, 120), quiet_head, 4, 40, FALLBACK)
        self.assertGreater(quieter["gain"], 1.2)
        self.assertLessEqual(quieter["gain"], 1.67)

    def test_shifts_the_start_past_a_vocal_line_that_runs_into_the_fade(self):
        # 唱到 25.4 秒收声：原起点 24.0 正压着乐句，整小节顺延到 26.0 落点才干净。
        tail = sing(groove(40, 120, melody=False), 4, 25.4)
        plan = smart_plan(tail, groove(40, 115.2, seed=2), 0, 40, FALLBACK)
        self.assertEqual((plan["mode"], plan["reason"]), ("smart", "beat-matched"))
        self.assertEqual(plan["startAt"], 26.0)
        self.assertEqual(plan["vocalShift"], 2.0)
        self.assertEqual(plan["seconds"], 14.0)
        self.assertFalse(vocal_busy(vocal_activity(tail), plan["startAt"]))

    def test_keeps_the_start_when_nothing_is_sung_there(self):
        plan = smart_plan(groove(40, 120, melody=False), groove(40, 115.2, seed=2), 0, 40, FALLBACK)
        self.assertEqual(plan["startAt"], 24.0)
        self.assertEqual(plan["vocalShift"], 0.0)

    def test_keeps_the_start_when_the_vocal_never_stops(self):
        # 一直唱到结尾：没有干净落点可挑，宁可保持原样也不牺牲重叠长度。
        tail = sing(groove(40, 120, melody=False), 4, 40)
        plan = smart_plan(tail, groove(40, 115.2, seed=2), 0, 40, FALLBACK)
        self.assertEqual(plan["mode"], "smart")
        self.assertEqual(plan["vocalShift"], 0.0)
        self.assertTrue(vocal_busy(vocal_activity(tail), plan["startAt"]))


class TempoStretchTests(unittest.TestCase):
    def test_strict_mode_only_uses_eleven_and_octave_relations(self):
        self.assertAlmostEqual(tempo_stretch(1.05), 1.05, delta=0.001)
        self.assertAlmostEqual(tempo_stretch(2.0), 1.0, delta=0.02)
        self.assertAlmostEqual(tempo_stretch(0.5), 1.0, delta=0.02)
        self.assertIsNone(tempo_stretch(0.75))
        self.assertIsNone(tempo_stretch(1.3))

    def test_force_mode_accepts_small_cross_relations_but_still_caps_the_speed_change(self):
        self.assertAlmostEqual(tempo_stretch(0.75, force=True), 1.0, delta=0.02)
        self.assertAlmostEqual(tempo_stretch(1.25, force=True), 0.9375, delta=0.02)
        self.assertIsNone(tempo_stretch(0.6, force=True))
        self.assertIsNone(tempo_stretch(1.15, force=True))

    def test_prefers_the_relation_closest_to_no_stretch(self):
        # 2.0 同时靠近「两拍对一拍」（1.0）与 4:3×?（2.0×2/3=1.333 超范围），仍选 1.0。
        self.assertAlmostEqual(tempo_stretch(2.0, force=True), 1.0, delta=0.001)


class FadeTimingTests(unittest.TestCase):
    PLAN = {"mode": "smart", "startAt": 96.0, "seconds": 8.0, "trim": 0.0, "ratio": 1.05, "ramp": 1.5,
            "beatPeriod": 0.5, "skip": 0.25, "analyzed": True}

    def test_waits_for_the_beat_and_keeps_the_stretch(self):
        timing = fade_timing(self.PLAN, 94.5, 200)
        self.assertEqual(timing["start"], 96.0)
        self.assertTrue(timing["waiting"])
        self.assertTrue(timing["smart"])
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
        self.assertFalse(timing["smart"])
        self.assertEqual(timing["stretch"], 1.0)
        self.assertEqual(timing["ramp"], 0.0)
        self.assertAlmostEqual(timing["duration"], 0.5)

    def test_normal_plans_keep_the_old_behaviour(self):
        timing = fade_timing({"seconds": 6, "skip": 1.0, "trim": 0.5, "analyzed": True}, 50, 60)
        self.assertEqual(timing, {"start": 50, "duration": 6, "stretch": 1.0, "ramp": 0.0, "waiting": False,
                                  "gain": 1.0, "smart": False})
        without_end = fade_timing({"seconds": 6, "skip": 0, "trim": 0, "analyzed": True}, 50, 0)
        self.assertEqual(without_end["duration"], 6)

    def test_carries_the_loudness_gain_into_the_fade(self):
        timing = fade_timing({**self.PLAN, "gain": 1.4}, 94.5, 200)
        self.assertAlmostEqual(timing["gain"], 1.4)
        self.assertAlmostEqual(fade_timing({**self.PLAN, "gain": 20}, 94.5, 200)["gain"], 2.0)
        self.assertAlmostEqual(fade_timing({**self.PLAN, "gain": 0.1}, 94.5, 200)["gain"], 0.5)


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
