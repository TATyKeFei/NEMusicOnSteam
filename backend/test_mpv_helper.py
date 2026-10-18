import math
import threading
import unittest
from unittest.mock import Mock, patch

from mpv_helper import LEVEL_RELEASE_SECONDS, MpvService, incoming_graph, outgoing_graph
from audio_source import audio_headers


class MpvSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.properties = {"path": "https://audio.example/song.mp3", "volume": 0}
        self.service = MpvService.__new__(MpvService)
        self.service.lock = threading.Lock()
        self.service.operations = threading.RLock()
        self.service.closed = threading.Event()
        self.service.prepared = None
        self.service.fading = None
        self.service.master_volume = None
        self.service.transport_revision = 0
        self.service.serial = 0
        self.service.rate = 1.0
        self.service.track = {"title": "歌曲", "trackId": "1"}
        self.service.mpv = Mock()
        self.service.mpv.property.side_effect = lambda name, fallback=None: self.properties.get(name, fallback)

    def test_zero_volume_is_preserved(self):
        self.assertEqual(self.service.snapshot()["volume"], 0.0)

    def test_nonzero_volume_is_normalized(self):
        self.properties["volume"] = 25
        self.assertEqual(self.service.snapshot()["volume"], 0.25)

    def test_missing_volume_uses_default(self):
        del self.properties["volume"]
        self.assertEqual(self.service.snapshot()["volume"], 1.0)

    def test_none_volume_uses_default(self):
        self.properties["volume"] = None
        self.assertEqual(self.service.snapshot()["volume"], 1.0)

    def test_load_resets_source_headers_between_tracks(self):
        self.service.load({"url": "https://cn-example.bilivideo.com/audio.m4a", "title": "歌曲"})
        self.service.mpv.command.assert_any_call("set_property", "http-header-fields", ["User-Agent: okhttp/3.4.1", "Referer: https://www.bilibili.com/"])
        self.service.mpv.command.reset_mock()
        self.service.load({"url": "https://music.126.net/song.mp3", "title": "歌曲"})
        self.service.mpv.command.assert_any_call("set_property", "http-header-fields", ["User-Agent: NEMusicOnSteam", "Referer: https://music.163.com/"])

    def test_source_headers_require_a_real_domain_boundary(self):
        for url in ("https://bilivideo.com.evil.example/song.m4a", "https://notbilivideo.com/song.m4a"):
            self.assertEqual(audio_headers(url)["Referer"], "https://music.163.com/")


class TransitionFixture(unittest.TestCase):
    def setUp(self):
        with patch("mpv_helper.MpvProcess"), patch.object(MpvService, "start_http"):
            self.service = MpvService("/tmp/mpv-transition-test", "token")
        self.old, self.old_properties = self.player({"duration": 100, "time-pos": 95, "volume": 50})
        self.next, self.next_properties = self.player({"time-pos": 0, "pause": True, "volume": 0})
        self.service.mpv = self.old
        self.service.track = {"title": "Old", "trackId": "1"}
        self.service.url = "https://audio.example/1.mp3"
        self.analysis = Mock(result={"seconds": 4, "skip": 0, "trim": 0, "analyzed": True})
        self.service.prepared = {"from": "1", "track": {"title": "Next", "trackId": "2"},
                                 "player": self.next, "analysis": self.analysis}
        self.payload = {"url": "https://audio.example/2.mp3", "title": "Next", "trackId": "2",
                        "from": "1", "transition": True, "transportRevision": 0, "volume": 0.5}

    @staticmethod
    def player(properties):
        values = {"path": "https://audio.example/a.mp3", "audio-params": {"samplerate": 44100}, "pause": False,
                  "duration": 100, "time-pos": 0, "volume": 100, **properties}
        player = Mock()
        player.property.side_effect = lambda name, fallback=None: values.get(name, fallback)
        def command(name, *args):
            if name == "set_property":
                values[args[0]] = args[1]
        player.command.side_effect = command
        return player, values

    def smart_prepared(self, **overrides):
        plan = {"mode": "smart", "reason": "beat-matched", "startAt": 96.0, "seconds": 8.0, "trim": 0.0,
                "ratio": 1.05, "ramp": 1.5, "beatPeriod": 0.5, "skip": 0.25, "analyzed": True}
        plan.update(overrides)
        self.analysis = Mock(result=plan)
        self.service.prepared = {"from": "1", "track": {"title": "Next", "trackId": "2"},
                                 "player": self.next, "analysis": self.analysis}
        return plan


class MpvTransitionTests(TransitionFixture):
    def test_adopts_preloaded_decoder_and_reports_master_volume_through_fade(self):
        state = self.service.load(self.payload)
        self.assertTrue(state["transitioned"])
        self.assertEqual(state["trackId"], "2")
        self.assertEqual(state["volume"], 0.5)
        self.assertEqual(self.next_properties["volume"], 0)
        self.old_properties["time-pos"] = 97
        self.service.update_fade()
        self.assertAlmostEqual(self.old_properties["volume"], 35.355339, places=5)
        self.assertAlmostEqual(self.next_properties["volume"], 35.355339, places=5)
        self.assertFalse(any(call.args[0] == "loadfile" for call in self.next.command.call_args_list))
        self.old_properties["time-pos"] = 99
        self.service.update_fade()
        self.old.close.assert_called_once()
        self.assertEqual(self.next_properties["volume"], 50)
        self.assertEqual(self.next_properties["speed"], 1.0)
        self.assertIsNone(self.service.fading)

    def test_pause_freezes_both_players_and_volume_changes_keep_the_fade(self):
        self.service.load(self.payload)
        self.service.command({"action": "pause"})
        self.assertTrue(self.old_properties["pause"])
        self.assertTrue(self.next_properties["pause"])
        self.service.update_fade()
        self.assertEqual(self.next_properties["volume"], 0)
        self.old_properties["time-pos"] = 97
        self.service.command({"action": "volume", "value": 0.2})
        self.assertEqual(self.service.snapshot()["volume"], 0.2)
        self.service.command({"action": "play"})
        self.assertFalse(self.old_properties["pause"])
        self.assertFalse(self.next_properties["pause"])

    def test_seek_finishes_the_tail_and_stop_cleans_preloaded_players(self):
        self.service.load(self.payload)
        self.service.command({"action": "setposition", "value": 10_000_000})
        self.old.close.assert_called_once()
        self.assertIsNone(self.service.fading)
        self.assertEqual(self.next_properties["volume"], 50)
        self.assertEqual(self.next_properties["time-pos"], 10)

    def test_pause_or_stop_wins_over_a_late_transition_request(self):
        for action in ("pause", "stop"):
            self.service.command({"action": action})
            result = self.service.load(self.payload)
            self.assertTrue(result["transitionCancelled"])
            self.assertEqual(result["trackId"], "1")
            self.assertIsNone(self.service.fading)

    def test_shutdown_closes_both_decoders_and_analysis(self):
        self.service.close()
        self.old.close.assert_called_once()
        self.next.close.assert_called_once()
        self.analysis.close.assert_called_once()

    def test_stale_preload_keeps_current_song_instead_of_cutting_it_short(self):
        self.payload["trackId"] = "3"
        state = self.service.load(self.payload)
        self.assertTrue(state["transitionCancelled"])
        self.assertEqual(state["trackId"], "1")
        self.next.close.assert_called_once()
        self.assertFalse(any(call.args[0] == "loadfile" for call in self.old.command.call_args_list))

    def test_plain_crossfade_keeps_full_bass_on_both_sides(self):
        state = self.service.load(self.payload)
        self.assertTrue(state["transitioned"])
        # 普通淡化只动音量，不碰滤镜。
        for player in (self.old, self.next):
            self.assertFalse(any(call.args[:2] == ("set_property", "af")
                                 for call in player.command.call_args_list))

    def test_normal_crossfade_keeps_the_linear_curve(self):
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 96
        self.service.update_fade()
        # 普通模式照旧用线性进度的等功率曲线，不套智能模式的 S 形。
        self.assertAlmostEqual(self.next_properties["volume"], 50 * math.sin(0.25 * math.pi / 2))
        shaped = 0.25 ** 3 * (0.25 * (0.25 * 6 - 15) + 10)
        self.assertGreater(self.next_properties["volume"], 50 * math.sin(shaped * math.pi / 2))

    def test_plain_crossfade_finishes_without_touching_filters(self):
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 99.0
        self.service.update_fade()
        self.assertIsNone(self.service.fading)
        # 普通模式从始到终都不碰滤镜，收场也不会多此一举地清滤镜。
        for player in (self.old, self.next):
            self.assertFalse(any(call.args[:2] == ("set_property", "af")
                                 for call in player.command.call_args_list))


class MpvSmartTransitionTests(TransitionFixture):
    def setUp(self):
        super().setUp()
        self.old_properties["duration"] = 200
        self.old_properties["time-pos"] = 94.5
        self.smart_prepared()

    def test_snapshot_exposes_the_plan_so_the_frontend_can_trigger_early(self):
        transition = self.service.snapshot()["transition"]
        self.assertEqual(transition["mode"], "smart")
        self.assertEqual(transition["startAt"], 96.0)

    def test_prepare_passes_the_requested_mode_to_the_analysis(self):
        with patch("mpv_helper.TransitionAnalysis") as analysis, patch("mpv_helper.MpvProcess"):
            analysis.return_value.result = {"seconds": 6, "skip": 0, "trim": 0, "analyzed": False}
            result = self.service.prepare({**self.payload, "mode": "smart"})
        self.assertTrue(result["prepared"])
        self.assertEqual(analysis.call_args.args[5], "smart")

    def test_prepare_passes_the_requested_fallback_to_the_analysis(self):
        with patch("mpv_helper.TransitionAnalysis") as analysis, patch("mpv_helper.MpvProcess"):
            analysis.return_value.result = {"seconds": 6, "skip": 0, "trim": 0, "analyzed": False}
            self.service.prepare({**self.payload, "mode": "smart", "fallback": "none"})
            self.assertEqual(analysis.call_args.args[6], "none")
            self.service.prepare({**self.payload, "mode": "smart"})
            self.assertEqual(analysis.call_args.args[6], "normal")

    def test_waits_for_the_beat_then_time_stretches_and_eases_back(self):
        state = self.service.load(self.payload)
        self.assertTrue(state["transitioned"])
        self.next.set_position.assert_called_once_with(0.25)
        self.assertEqual(self.next_properties["speed"], 1.05)
        self.assertTrue(self.next_properties["pause"])
        self.assertTrue(self.service.fading["waiting"])
        self.assertEqual(self.service.fading["start"], 96.0)
        # 还没到拍点：旧歌照常出声，新歌保持沉默。
        self.old_properties["time-pos"] = 95.5
        self.service.update_fade()
        self.assertEqual(self.next_properties["volume"], 0)
        self.assertEqual(self.old_properties["volume"], 50)
        self.assertTrue(self.next_properties["pause"])
        # 到拍点：放开新歌，S 形进度让新歌从很低的音量悄悄进入。
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])
        progress = 0.5 / 8
        shaped = progress * progress * progress * (progress * (progress * 6 - 15) + 10)
        self.assertAlmostEqual(self.next_properties["volume"], 50 * math.sin(shaped * math.pi / 2))
        # 收尾阶段把新歌的变速平滑拉回用户倍速。
        self.old_properties["time-pos"] = 103.25
        self.service.update_fade()
        self.assertAlmostEqual(self.next_properties["speed"], 1.025, places=6)
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        self.assertIsNone(self.service.fading)
        self.old.close.assert_called_once()
        self.assertEqual(self.next_properties["speed"], 1.0)
        self.assertEqual(self.next_properties["volume"], 50)

    def test_user_pause_during_the_wait_keeps_the_beat_sync(self):
        self.service.load(self.payload)
        self.service.command({"action": "pause"})
        self.service.command({"action": "play"})
        self.assertFalse(self.old_properties["pause"])
        self.assertTrue(self.next_properties["pause"])
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])

    def test_beat_lock_never_releases_while_the_old_song_is_paused(self):
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 96.5
        self.old_properties["pause"] = True
        self.service.update_fade()
        self.assertTrue(self.next_properties["pause"])
        self.assertTrue(self.service.fading["waiting"])
        self.old_properties["pause"] = False
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])
        self.assertFalse(self.service.fading["waiting"])

    def test_loudness_match_gain_is_applied_and_released_smoothly(self):
        self.smart_prepared(gain=1.4)
        self.service.load(self.payload)
        self.assertEqual(self.service.fading["gain"], 1.4)
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        progress = 0.5 / 8
        shaped = progress * progress * progress * (progress * (progress * 6 - 15) + 10)
        self.assertAlmostEqual(self.next_properties["volume"], 50 * 1.4 * math.sin(shaped * math.pi / 2))
        # 混音结束：先按匹配增益继续出声，再在 8 秒里平滑放回用户音量。
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        self.assertIsNone(self.service.fading)
        self.assertIsNotNone(self.service.settle)
        self.assertEqual(self.next_properties["volume"], 50 * 1.4)
        with patch("mpv_helper.time.monotonic", return_value=self.service.settle["start"] + 4.0):
            self.service.settle_levels()
        self.assertAlmostEqual(self.next_properties["volume"], 50 * 1.2)
        with patch("mpv_helper.time.monotonic", return_value=self.service.settle["start"] + LEVEL_RELEASE_SECONDS):
            self.service.settle_levels()
        self.assertIsNone(self.service.settle)
        self.assertIsNone(self.service.master_volume)
        self.assertEqual(self.next_properties["volume"], 50)

    def test_seek_during_the_release_restores_the_user_volume_at_once(self):
        self.smart_prepared(gain=1.4)
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        self.assertIsNotNone(self.service.settle)
        self.service.command({"action": "setposition", "value": 30_000_000})
        self.assertIsNone(self.service.settle)
        self.assertEqual(self.next_properties["volume"], 50)

    def test_volume_changes_during_the_release_use_the_new_user_volume(self):
        self.smart_prepared(gain=1.4)
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        with patch("mpv_helper.time.monotonic", return_value=self.service.settle["start"] + 4.0):
            self.service.command({"action": "volume", "value": 0.8})
        self.assertAlmostEqual(self.next_properties["volume"], 80 * 1.2)

    def test_plain_load_after_the_mix_does_not_inherit_the_loudness_gain(self):
        self.smart_prepared(gain=1.4)
        self.service.load(self.payload)
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        self.assertIsNotNone(self.service.settle)
        state = self.service.load({"url": "https://audio.example/3.mp3", "title": "Other", "trackId": "3",
                                   "volume": 0.4, "autoplay": False})
        self.assertEqual(state["trackId"], "3")
        self.assertIsNone(self.service.settle)
        self.assertIsNone(self.service.master_volume)
        self.assertEqual(self.next_properties["volume"], 40)

    def test_rate_changes_keep_the_stretch_ratio_during_the_fade(self):
        self.service.load(self.payload)
        self.service.command({"action": "rate", "value": 1.5})
        self.assertEqual(self.old_properties["speed"], 1.5)
        self.assertAlmostEqual(self.next_properties["speed"], 1.5 * 1.05)
        self.assertEqual(self.service.snapshot()["rate"], 1.5)

    def test_missed_beat_shifts_the_start_and_shortens_the_fade(self):
        self.old_properties["time-pos"] = 96.6
        self.service.load(self.payload)
        self.assertEqual(self.service.fading["start"], 97.0)
        self.assertAlmostEqual(self.service.fading["duration"], 7.0)
        self.assertTrue(self.service.fading["waiting"])

    def test_adoption_too_late_falls_back_to_a_plain_crossfade(self):
        self.old_properties["time-pos"] = 99.5
        self.service.load(self.payload)
        self.assertEqual(self.service.fading["start"], 99.5)
        self.assertEqual(self.service.fading["stretch"], 1.0)
        self.assertFalse(self.service.fading["waiting"])
        self.assertFalse(self.next_properties["pause"])
        self.assertEqual(self.next_properties["speed"], 1.0)
        # 回退的普通淡化不动滤镜，两首歌保持完整频段。
        self.assertFalse(any(call.args[:2] == ("set_property", "af")
                             for call in self.old.command.call_args_list))

    def test_fade_graphs_are_armed_at_adoption_and_left_alone_at_release(self):
        events = []
        for player, tag in ((self.old, "old"), (self.next, "next")):
            inner = player.command.side_effect

            def record(name, *args, _inner=inner, _tag=tag):
                events.append((_tag, name, args))
                return _inner(name, *args)

            player.command.side_effect = record
        self.service.load(self.payload)
        # 接管一刻两张渐变图就挂好：权重从 0 起步，等拍点期间都是原声直通。
        armed = {(event[0], event[2][1]) for event in events
                 if event[1] == "set_property" and event[2][0] == "af"}
        self.assertEqual(armed, {("old", outgoing_graph(96.0, 8.0)),
                                 ("next", incoming_graph(0.25, 8.0, 1.05))})
        # 放开新歌这一刻不再动滤镜：各频段交给时间轴上的渐变窗口。
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])
        later = [event for event in events
                 if event[1] == "set_property" and event[2][0] == "af"]
        self.assertEqual(len(later), 2)

    def test_fade_graphs_bake_the_stage_windows(self):
        outgoing = outgoing_graph(96.0, 8.0)
        # 旧歌：高频搁架从进度 20% 起压镲片/齿音，中点前完成。
        self.assertIn("highshelf=f=6500:g=-7", outgoing)
        self.assertIn("-0.2)/0.250", outgoing)
        # 旧歌：人声频段赶在正中间轻降一档。
        self.assertIn("equalizer=f=1000:width_type=h:width=3800:g=-2", outgoing)
        self.assertIn("-0.3)/0.400", outgoing)
        # 旧歌：低频交接 1.2 秒，窗口中心对齐 S 形进度交叉点（96 + 4 秒）。
        self.assertIn("(t-99.400)/1.200", outgoing)
        self.assertIn("asetnsamples=n=256", outgoing)
        # 长重叠交接上限 2 秒；最短重叠也有下限，窗口始终落在混音内部。
        self.assertIn("(t-110.000)/2.000", outgoing_graph(96.0, 30.0))
        self.assertIn("(t-1.700)/0.600", outgoing_graph(0.0, 4.0))
        # 新歌：只做同一时刻的人声轻降，不碰低频和高频；窗口按自己的媒体时间铺开。
        incoming = incoming_graph(0.25, 8.0, 1.05)
        self.assertIn("equalizer=f=1000:width_type=h:width=3800:g=-2", incoming)
        self.assertIn("(t-0.250)/8.400", incoming)
        self.assertIn("-0.3)/0.400", incoming)
        self.assertNotIn("highpass", incoming)
        self.assertNotIn("highshelf", incoming)

    def test_smart_mix_that_needs_no_wait_arms_the_fade_graphs_right_away(self):
        with patch("mpv_helper.fade_timing", return_value={"start": 94.5, "duration": 8.0, "stretch": 1.05,
                                                           "ramp": 1.5, "waiting": False, "gain": 1.0,
                                                           "smart": True}):
            self.service.load(self.payload)
        self.old.command.assert_any_call("set_property", "af", outgoing_graph(94.5, 8.0))
        self.next.command.assert_any_call("set_property", "af", incoming_graph(0.25, 8.0, 1.05))
        self.assertTrue(self.service.fading["filtered"])

    def test_incoming_filters_are_cleared_after_the_mix(self):
        self.service.load(self.payload)
        self.next.command.assert_any_call("set_property", "af", incoming_graph(0.25, 8.0, 1.05))
        self.old_properties["time-pos"] = 104.0
        self.service.update_fade()
        self.assertIsNone(self.service.fading)
        # 混音收场：渐入图摘掉，新歌余下部分回到无滤镜直通。
        self.next.command.assert_any_call("set_property", "af", "")

    def test_a_rejected_filter_degrades_to_a_volume_only_mix(self):
        for player in (self.old, self.next):
            inner = player.command.side_effect

            def flaky(name, *args, _inner=inner):
                if name == "set_property" and args[0] == "af":
                    raise RuntimeError("mpv: property not found")
                return _inner(name, *args)

            player.command.side_effect = flaky
        self.service.load(self.payload)
        # mpv 拒绝滤镜时静默退化：混音本身照旧，只是各频段不再交接。
        self.assertTrue(self.service.fading["smart"])
        self.assertFalse(self.service.fading["filtered"])
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])
        progress = 0.5 / 8
        self.assertAlmostEqual(self.old_properties["volume"],
                               50 * math.cos(self.shaped(progress) * math.pi / 2))

    @staticmethod
    def shaped(progress):
        return progress * progress * progress * (progress * (progress * 6 - 15) + 10)

    def test_smart_fade_holds_both_ends_and_swaps_in_the_middle(self):
        self.service.load(self.payload)
        # 前段比线性更慢：新歌悄悄进来，旧歌还稳着。
        self.old_properties["time-pos"] = 98.0
        self.service.update_fade()
        self.assertAlmostEqual(self.next_properties["volume"], 50 * math.sin(self.shaped(0.25) * math.pi / 2))
        self.assertLess(self.next_properties["volume"], 50 * math.sin(0.25 * math.pi / 2))
        # 中点与线性重合，等功率交接保持不变。
        self.old_properties["time-pos"] = 100.0
        self.service.update_fade()
        self.assertAlmostEqual(self.next_properties["volume"], 50 * math.sin(0.5 * math.pi / 2))
        self.assertAlmostEqual(self.old_properties["volume"] ** 2 + self.next_properties["volume"] ** 2,
                               50 ** 2, delta=0.5)
        # 后段旧歌退得比线性干脆，交接利落。
        self.old_properties["time-pos"] = 102.0
        self.service.update_fade()
        self.assertLess(self.old_properties["volume"], 50 * math.cos(0.75 * math.pi / 2))


class MpvAnalyzeTests(TransitionFixture):
    @patch("mpv_helper.track_features")
    @patch("mpv_helper.sample_track")
    def test_analyze_uses_the_cache_and_skips_invalid_items(self, sample, features):
        features.return_value = {"bpm": 120.0, "energy": 0.3, "key": "8B", "keyConfidence": 0.5}
        sample.return_value = object()
        result = self.service.analyze({"tracks": [
            {"trackId": "1", "url": "https://audio.example/1.mp3"},
            {"trackId": "1", "url": "https://audio.example/1.mp3?fresh=1"},
            {"trackId": "2", "url": "not-a-url"},
            {"trackId": "", "url": "https://audio.example/3.mp3"},
            "junk",
        ]})
        # 同曲换 URL 也命中缓存；无效条目直接跳过。
        self.assertEqual(result["tracks"], [{"trackId": "1", "bpm": 120.0, "energy": 0.3,
                                             "key": "8B", "keyConfidence": 0.5}])
        self.assertEqual(sample.call_count, 1)
        self.assertEqual(features.call_count, 1)
        self.assertEqual(sample.call_args[0][2], 18)

    @patch("mpv_helper.track_features")
    @patch("mpv_helper.sample_track")
    def test_analyze_does_not_cache_failed_decodes(self, sample, features):
        sample.return_value = None
        features.return_value = None
        result = self.service.analyze({"tracks": [{"trackId": "9", "url": "https://audio.example/9.mp3"}]})
        self.assertEqual(result, {"tracks": []})
        features.assert_called_once_with(None)
        self.assertEqual(self.service.features, {})

    def test_analyze_rejects_empty_and_oversized_batches(self):
        with self.assertRaises(ValueError):
            self.service.analyze({"tracks": []})
        with self.assertRaises(ValueError):
            self.service.analyze({"tracks": [{"trackId": str(index), "url": "https://audio.example/x.mp3"}
                                             for index in range(9)]})


if __name__ == "__main__":
    unittest.main()
