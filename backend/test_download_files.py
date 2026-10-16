import os
import socket
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
import download_files as files


class FilenameTests(unittest.TestCase):
    def test_separators_control_characters_and_dots_never_survive(self):
        for original in ("..\\..\\etc/passwd", "/etc/shadow", "..", ".hidden", "a\x00b\x1fc", "  ..名字..  ", "name."):
            name = files.sanitize_filename(original, ".mp3")
            self.assertTrue(name.endswith(".mp3"), name)
            body = name[: -len(".mp3")]
            self.assertTrue(body, original)
            self.assertNotIn("/", body)
            self.assertNotIn("\\", body)
            self.assertFalse(body.startswith("."), name)
            self.assertEqual(os.path.basename(body), body)
            self.assertEqual(body, body.strip(" ."))

    def test_unicode_is_kept_and_byte_length_is_capped(self):
        name = files.sanitize_filename("歌手" * 400 + " - " + "歌名" * 400, ".flac")
        body = name[: -len(".flac")]
        self.assertTrue(body.startswith("歌手"))
        self.assertLessEqual(len(body.encode("utf-8")), files.FILENAME_BYTE_LIMIT)

    def test_empty_names_fall_back(self):
        for original in ("  ..  ", "", None, "..."):
            self.assertEqual(files.sanitize_filename(original, ".mp3"), "未命名.mp3")

    def test_a_supplied_audio_extension_is_replaced_not_stacked(self):
        self.assertEqual(files.sanitize_filename("歌 - 名.mp3", ".flac"), "歌 - 名.flac")
        self.assertEqual(files.sanitize_filename("歌 - 名.FLAC", ".mp3"), "歌 - 名.mp3")


class DirectoryTests(unittest.TestCase):
    def test_default_directory_uses_the_music_folder(self):
        for requested in ("", None, "   "):
            self.assertEqual(files.download_directory(requested), os.path.expanduser("~/Music/网易云音乐"))

    def test_explicit_directory_expands_home(self):
        self.assertEqual(files.download_directory("~/音乐/网易云"), os.path.expanduser("~/音乐/网易云"))
        self.assertEqual(files.download_directory("/tmp/nemusic"), "/tmp/nemusic")


class AudioExtensionTests(unittest.TestCase):
    def test_magic_bytes_win_over_the_declared_type(self):
        self.assertEqual(files.audio_extension(b"fLaC\x00\x00", "mp3"), ".flac")
        self.assertEqual(files.audio_extension(b"ID3\x04\x00", "flac"), ".mp3")
        self.assertEqual(files.audio_extension(b"\xff\xfb\x90\x00", None), ".mp3")
        self.assertEqual(files.audio_extension(b"\x00\x00\x00\x20ftypM4A ", "flac"), ".m4a")

    def test_unknown_payloads_fall_back_to_a_known_declared_type_or_fail(self):
        unknown = b"\x01\x02\x03\x04\x05\x06\x07\x08\x09"
        self.assertEqual(files.audio_extension(unknown, "flac"), ".flac")
        self.assertIsNone(files.audio_extension(unknown, None))
        self.assertIsNone(files.audio_extension(unknown, "exe"))


class DownloadUrlTests(unittest.TestCase):
    def test_rejects_non_http_schemes_and_missing_hosts(self):
        for url in ("file:///etc/passwd", "ftp://example.com/song.mp3", "blob:https://music.163.com/x", "https:///song.mp3", "", None):
            with self.assertRaises(ValueError):
                files.validate_download_url(url)

    def test_rejects_loopback_private_and_link_local_hosts(self):
        for address in ("127.0.0.1", "192.168.1.10", "10.0.0.5", "169.254.1.1", "::1", "fd00::1"):
            with patch.object(files.socket, "getaddrinfo", return_value=[(2, 1, 6, "", (address, 80))]):
                with self.assertRaises(ValueError):
                    files.validate_download_url("http://cdn.example.com/song.mp3")

    def test_accepts_a_public_host(self):
        with patch.object(files.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            self.assertEqual(files.validate_download_url("https://m701.music.126.net/song.mp3"), "https://m701.music.126.net/song.mp3")

    def test_reports_unresolvable_hosts(self):
        with patch.object(files.socket, "getaddrinfo", side_effect=socket.gaierror("boom")):
            with self.assertRaises(ValueError):
                files.validate_download_url("https://nope.invalid/song.mp3")


class UniquePathTests(unittest.TestCase):
    def test_existing_files_are_never_overwritten(self):
        with TemporaryDirectory() as directory:
            first, first_path = files.open_unique(directory, "歌 - 名", ".mp3")
            first.close()
            second, second_path = files.open_unique(directory, "歌 - 名", ".mp3")
            second.close()
            self.assertEqual(os.path.basename(first_path), "歌 - 名.mp3")
            self.assertEqual(os.path.basename(second_path), "歌 - 名 (1).mp3")
            self.assertEqual(len(os.listdir(directory)), 2)


