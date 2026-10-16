import os
import unittest
from tempfile import TemporaryDirectory
import audio_tags as tags


PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 8


def _id3_frame_size(data, offset):
    return int.from_bytes(data[offset:offset + 4], "big")


class TagTests(unittest.TestCase):
    def test_build_id3_tag_has_frames_and_a_synchsafe_size(self):
        tag = tags.build_id3_tag("歌名", "歌手", "专辑", (PNG, "image/png"))
        self.assertTrue(tag.startswith(b"ID3\x03\x00\x00"))
        size = (tag[6] & 0x7F) << 21 | (tag[7] & 0x7F) << 14 | (tag[8] & 0x7F) << 7 | tag[9] & 0x7F
        self.assertEqual(size, len(tag) - 10)
        for frame in (b"TIT2", b"TPE1", b"TALB", b"APIC"):
            self.assertIn(frame, tag)
        self.assertIn("歌名".encode("utf-16-le"), tag)
        self.assertIn(PNG, tag)

    def test_writing_id3_replaces_an_old_tag_and_keeps_audio(self):
        with TemporaryDirectory() as directory:
            path = os.path.join(directory, "song.mp3")
            with open(path, "wb") as handle:
                handle.write(tags.build_id3_tag("旧标题", "", "", None) + b"AUDIO")
            tags.write_id3_tag(path, "新标题", "新歌手", "", None)
            with open(path, "rb") as handle:
                data = handle.read()
        self.assertTrue(data.startswith(b"ID3"))
        self.assertIn("新标题".encode("utf-16-le"), data)
        self.assertIn("新歌手".encode("utf-16-le"), data)
        self.assertNotIn("旧标题".encode("utf-16-le"), data)
        self.assertTrue(data.endswith(b"AUDIO"))

    def test_id3_tag_without_a_cover_omits_apic(self):
        self.assertNotIn(b"APIC", tags.build_id3_tag("歌", "", "", None))

    def test_flac_roundtrip_preserves_streaminfo_and_audio(self):
        streaminfo = b"\x00" * 34
        with TemporaryDirectory() as directory:
            path = os.path.join(directory, "song.flac")
            with open(path, "wb") as handle:
                handle.write(b"fLaC" + bytes([0x80]) + (34).to_bytes(3, "big") + streaminfo + b"AUDIO")
            self.assertTrue(tags.write_flac_tags(path, "歌", "歌手", "专辑", (PNG, "image/png")))
            with open(path, "rb") as handle:
                data = handle.read()
        self.assertTrue(data.startswith(b"fLaC"))
        self.assertIn("TITLE=歌".encode(), data)
        self.assertIn("ARTIST=歌手".encode(), data)
        self.assertIn("ALBUM=专辑".encode(), data)
        self.assertIn(PNG, data)
        self.assertTrue(data.endswith(b"AUDIO"))
        pos = 4
        self.assertEqual(data[pos] & 0x7F, 0)
        while True:
            last = bool(data[pos] & 0x80)
            pos += 4 + int.from_bytes(data[pos + 1:pos + 4], "big")
            if last:
                break
        self.assertEqual(data[pos:], b"AUDIO")

    def test_flac_tags_replace_old_comments_and_pictures(self):
        comment_body = b"\x01\x00\x00\x00x"
        picture_body = b"\x00\x00\x00\x00"
        with TemporaryDirectory() as directory:
            path = os.path.join(directory, "song.flac")
            with open(path, "wb") as handle:
                handle.write(
                    b"fLaC"
                    + bytes([0x00]) + (34).to_bytes(3, "big") + b"\x00" * 34
                    + bytes([0x04]) + len(comment_body).to_bytes(3, "big") + comment_body
                    + bytes([0x80 | 6]) + len(picture_body).to_bytes(3, "big") + picture_body
                    + b"AUDIO"
                )
            self.assertTrue(tags.write_flac_tags(path, "歌", "", "", None))
            with open(path, "rb") as handle:
                data = handle.read()
        self.assertIn("TITLE=歌".encode(), data)
        self.assertNotIn("TITLE=x".encode(), data)
        self.assertTrue(data.endswith(b"AUDIO"))

    def test_tag_audio_skips_unknown_extensions_and_empty_metadata(self):
        with TemporaryDirectory() as directory:
            path = os.path.join(directory, "song.m4a")
            with open(path, "wb") as handle:
                handle.write(b"data")
            self.assertFalse(tags.tag_audio(path, ".m4a", "t", "", "", ""))
            self.assertFalse(tags.tag_audio(path, ".mp3", "", "", "", ""))


