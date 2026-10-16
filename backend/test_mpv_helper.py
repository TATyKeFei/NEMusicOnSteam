import math
import threading
import unittest
from unittest.mock import Mock, patch

from mpv_helper import MpvService
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
        # 到拍点：放开新歌，两边从这一刻等同功率混音。
        self.old_properties["time-pos"] = 96.5
        self.service.update_fade()
        self.assertFalse(self.next_properties["pause"])
        self.assertAlmostEqual(self.next_properties["volume"], 50 * math.sin(0.5 / 8 * math.pi / 2))
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



if __name__ == "__main__":
    unittest.main()
