import threading
import unittest
from unittest.mock import Mock

from mpv_helper import MpvService


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


if __name__ == "__main__":
    unittest.main()
