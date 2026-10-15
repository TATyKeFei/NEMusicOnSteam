import threading
import unittest
from unittest.mock import Mock

from mpv_helper import MpvService
from audio_source import audio_headers


class MpvSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.properties = {"path": "https://audio.example/song.mp3", "volume": 0}
        self.service = MpvService.__new__(MpvService)
        self.service.lock = threading.Lock()
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


if __name__ == "__main__":
    unittest.main()
