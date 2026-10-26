import threading
import unittest
from unittest.mock import Mock, patch

from mpv_helper import MpvService
from audio_source import audio_headers


class MpvPlaybackTests(unittest.TestCase):
    def setUp(self):
        self.properties = {"path": "https://audio.example/song.mp3", "volume": 0}
        self.service = MpvService.__new__(MpvService)
        self.service.lock = threading.Lock()
        self.service.operations = threading.RLock()
        self.service.closed = threading.Event()
        self.service.rate = 1.0
        self.service.mixer = None
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

    def test_load_preserves_paused_playback_position_volume_and_rate(self):
        self.service.rate = 1.5
        self.service.load({"url": "https://audio.example/song.mp3", "title": "歌曲", "trackId": "2",
                           "position": 42, "autoplay": False, "volume": 0.25})
        commands = self.service.mpv.command.call_args_list
        self.assertEqual(commands[0].args, ("set_property", "volume", 25.0))
        self.service.mpv.command.assert_any_call("set_property", "speed", 1.5)
        self.service.mpv.command.assert_any_call("loadfile", "https://audio.example/song.mp3", "replace")
        self.service.mpv.set_position.assert_called_once_with(42)
        self.assertEqual(commands[-1].args, ("set_property", "pause", True))
        self.assertEqual(self.service.track["trackId"], "2")

    def test_transport_commands_control_the_current_player(self):
        cases = [
            ({"action": "pause"}, ("set_property", "pause", True)),
            ({"action": "play"}, ("set_property", "pause", False)),
            ({"action": "playpause"}, ("set_property", "pause", True)),
            ({"action": "volume", "value": 0.25}, ("set_property", "volume", 25.0)),
            ({"action": "rate", "value": 1.5}, ("set_property", "speed", 1.5)),
            ({"action": "seek", "value": -2_000_000}, ("seek", -2.0, "relative", "exact")),
            ({"action": "setposition", "value": 30_000_000}, ("set_property", "time-pos", 30.0)),
            ({"action": "loop", "value": "Track"}, ("set_property", "loop-file", "inf")),
            ({"action": "stop"}, ("stop",)),
        ]
        for payload, expected in cases:
            with self.subTest(action=payload["action"]):
                self.service.mpv.command.reset_mock()
                self.assertTrue(self.service.command(payload))
                self.service.mpv.command.assert_called_once_with(*expected)

    def test_stale_cancellation_cannot_restart_a_newer_fade(self):
        self.service.mixer = Mock(identifier="stream", revision=5, lock=threading.RLock())
        with patch.object(self.service, "seek_mixer") as seek:
            result = self.service.prepare({"streamId": "stream", "fromTrackId": "1", "revision": 4})
        self.assertFalse(result["accepted"])
        seek.assert_not_called()
        self.service.mixer.prepare.assert_not_called()


class MpvAnalyzeTests(unittest.TestCase):
    def setUp(self):
        with patch("mpv_helper.MpvProcess"), patch.object(MpvService, "start_http"):
            self.service = MpvService("/tmp/mpv-analyze-test", "token")

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
