import importlib.util
import io
import json
import os
import socket
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


WEBP_COVER = b"RIFF\x04\x00\x00\x00WEBP"


repository = ModuleType("gi.repository")
repository.Gio = SimpleNamespace()
repository.GLib = SimpleNamespace(idle_add=Mock())
spec = importlib.util.spec_from_file_location("mpris_helper_test_target", Path(__file__).with_name("mpris_helper.py"))
helper = importlib.util.module_from_spec(spec)
with patch.dict("sys.modules", {"gi": ModuleType("gi"), "gi.repository": repository}):
    spec.loader.exec_module(helper)


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.service = helper.MprisService.__new__(helper.MprisService)
        self.service.lock = threading.Lock()
        self.service.token = "test-token"
        self.service.commands = []
        self.service.state = {"volume": 0.42}
        self.service.notification_serial = 0
        self.service.last_notified_track = None
        self.service.cover_files = {}
        self.service.cover_directory = TemporaryDirectory()
        self.addCleanup(self.service.cover_directory.cleanup)
        repository.GLib.idle_add.reset_mock()

    def post_state(self, state):
        handler_type = self.service.make_handler()
        handler = handler_type.__new__(handler_type)
        body = json.dumps(state).encode()
        handler.path = "/state"
        handler.headers = {"X-NEMusic-Token": "test-token", "Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.reply = Mock()
        handler.do_POST()
        handler.reply.assert_called_once_with(200, {})


class VolumeFeedbackTests(ServiceTestCase):
    def test_write_queues_command_without_claiming_the_player_changed(self):
        result = self.service.on_set_property(None, None, None, "org.mpris.MediaPlayer2.Player", "Volume", SimpleNamespace(unpack=lambda: 0.25))
        self.assertTrue(result)
        self.assertEqual(self.service.commands, [{"action": "volume", "value": 0.25}])
        self.assertEqual(self.service.state["volume"], 0.42)
        repository.GLib.idle_add.assert_not_called()

    def test_missing_reading_keeps_confirmed_volume_including_mute(self):
        for volume in (0.42, 0.0):
            self.service.state = {"volume": volume}
            self.post_state({"volume": None})
            self.assertEqual(self.service.state["volume"], volume)
        repository.GLib.idle_add.assert_not_called()

    def test_player_confirmation_emits_volume_change(self):
        self.post_state({"volume": 0.25})
        self.assertEqual(self.service.state["volume"], 0.25)
        repository.GLib.idle_add.assert_called_once_with(self.service.emit_changed, ["Volume"])


class PlaybackNotificationTests(ServiceTestCase):
    def playback(self, **changes):
        state = {"active": True, "playbackStatus": "Playing", "trackId": "song-1", "title": "歌曲一", "artist": "歌手一"}
        state.update(changes)
        self.post_state(state)

    def notifications(self):
        return [call.args[1:3] for call in repository.GLib.idle_add.call_args_list if call.args[0] == self.service.notify_track]

    def test_start_and_switch_show_song_and_artist_without_repeating_on_polls(self):
        self.playback()
        self.playback(position=5)
        self.playback(position=10, volume=0.3)
        self.playback(trackId="song-2", title="歌曲二", artist="歌手二")
        self.assertEqual(self.notifications(), [("歌曲一", "歌手一"), ("歌曲二", "歌手二")])

    def test_pause_and_resume_same_song_do_not_repeat_notification(self):
        self.playback()
        for repeat in range(3):
            self.playback(playbackStatus="Paused")
            self.playback()
        self.assertEqual(self.notifications(), [("歌曲一", "歌手一")])

    def test_first_play_after_initial_paused_state_notifies_once(self):
        self.playback(playbackStatus="Paused")
        self.assertEqual(self.notifications(), [])
        self.playback()
        self.playback()
        self.assertEqual(self.notifications(), [("歌曲一", "歌手一")])

    def test_track_selected_while_paused_notifies_when_played(self):
        self.playback()
        self.playback(playbackStatus="Paused")
        self.playback(playbackStatus="Paused", trackId="song-2", title="歌曲二")
        self.assertEqual(len(self.notifications()), 1)
        self.playback(trackId="song-2", title="歌曲二")
        self.assertEqual(self.notifications()[-1], ("歌曲二", "歌手一"))
        self.playback(playbackStatus="Paused", trackId="song-2", title="歌曲二")
        self.playback(trackId="song-2", title="歌曲二")
        self.assertEqual(self.notifications(), [("歌曲一", "歌手一"), ("歌曲二", "歌手一")])

    def test_switching_back_to_previous_song_notifies_again(self):
        self.playback()
        self.playback(trackId="song-2", title="歌曲二")
        self.playback()
        self.assertEqual(self.notifications(), [("歌曲一", "歌手一"), ("歌曲二", "歌手一"), ("歌曲一", "歌手一")])

    def test_waits_for_title_and_ignores_inactive_or_stopped_player(self):
        self.playback(active=False)
        self.playback(playbackStatus="Stopped")
        self.playback(title="")
        self.assertEqual(self.notifications(), [])
        self.playback(artist="")
        self.assertEqual(self.notifications(), [("歌曲一", "未知歌手")])

    def test_sends_native_notification_asynchronously_and_escapes_artist_markup(self):
        self.service.connection = Mock()
        variant = Mock(side_effect=lambda signature, value: (signature, value))
        with patch.object(repository.GLib, "Variant", variant, create=True), \
                patch.object(repository.GLib, "VariantType", SimpleNamespace(new=lambda signature: signature), create=True), \
                patch.object(repository.Gio, "DBusCallFlags", SimpleNamespace(NONE=0), create=True):
            self.assertFalse(self.service.notify_track("歌曲 <一>", "歌手 & <二>"))
        args = self.service.connection.call.call_args.args
        self.assertEqual(args[:4], ("org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Notify"))
        signature, values = args[4]
        self.assertEqual(signature, "(susssasa{sv}i)")
        self.assertEqual(values[3:5], ("歌曲 <一>", "歌手 &amp; &lt;二&gt;"))
        self.assertEqual(args[-2], self.service.on_notification_sent)

    def test_song_notification_includes_its_cover_url(self):
        self.playback(artUrl="https://p1.music.126.net/cover.jpg")
        calls = [call for call in repository.GLib.idle_add.call_args_list if call.args[0] == self.service.notify_track]
        self.assertEqual(calls[0].args[3], "https://p1.music.126.net/cover.jpg")

    def test_cover_download_runs_in_background_and_cached_cover_is_reused(self):
        self.service.send_notification = Mock(return_value=False)
        art_url = "https://p1.music.126.net/cover.jpg"
        with patch.object(helper.threading, "Thread") as worker:
            self.assertFalse(self.service.notify_track("歌曲", "歌手", art_url))
            worker.return_value.start.assert_called_once_with()
            self.service.send_notification.assert_not_called()
            self.service.finish_notification_cover(1, "歌曲", "歌手", art_url, WEBP_COVER)
            icon = self.service.send_notification.call_args.args[2]
            self.assertEqual(Path(icon).read_bytes(), WEBP_COVER)
            self.assertEqual(Path(icon).suffix, ".webp")
            self.service.notify_track("歌曲", "歌手", art_url)
            worker.assert_called_once()
            self.service.send_notification.assert_called_with("歌曲", "歌手", icon)

    def test_failed_or_unsupported_cover_keeps_default_icon(self):
        self.service.send_notification = Mock(return_value=False)
        with patch.object(helper, "urlopen", side_effect=OSError("offline")), patch("sys.stderr", new_callable=io.StringIO):
            self.service.load_notification_cover(0, "歌曲", "歌手", "https://p1.music.126.net/cover.jpg")
        callback, *args = repository.GLib.idle_add.call_args.args
        callback(*args)
        self.service.send_notification.assert_called_with("歌曲", "歌手", "audio-x-generic")
        with patch.object(helper.threading, "Thread") as worker:
            self.service.notify_track("歌曲", "歌手", "file:///cover.jpg")
            worker.assert_not_called()
        self.service.send_notification.assert_called_with("歌曲", "歌手")

    def test_download_accepts_images_and_rejects_html_and_oversized_files(self):
        for mime_type, content, expected in [
            ("image/webp", WEBP_COVER, WEBP_COVER),
            ("image/jpg", WEBP_COVER, WEBP_COVER),
            ("application/octet-stream", WEBP_COVER, WEBP_COVER),
            ("image/jpeg", b"<html>error</html>", None),
            ("text/html", b"error", None),
            ("image/png", b"x" * (4 * 1024 * 1024 + 1), None),
        ]:
            response = io.BytesIO(content)
            response.headers = Message()
            response.headers["Content-Type"] = mime_type
            with patch.object(helper, "urlopen", return_value=response), patch("sys.stderr", new_callable=io.StringIO):
                self.service.load_notification_cover(0, "歌曲", "歌手", "https://p1.music.126.net/cover.jpg")
            self.assertEqual(repository.GLib.idle_add.call_args.args[-1], expected)

    def test_slow_cover_from_previous_song_does_not_show_out_of_order(self):
        self.service.send_notification = Mock(return_value=False)
        self.service.notification_serial = 2
        self.service.finish_notification_cover(1, "旧歌曲", "歌手", "https://example.com/old.jpg", b"old cover")
        self.service.send_notification.assert_not_called()
        self.assertEqual(list(Path(self.service.cover_directory.name).iterdir()), [])

    def test_cover_cache_is_bounded(self):
        self.service.send_notification = Mock(return_value=False)
        for index in range(10):
            self.service.finish_notification_cover(0, "歌曲", "歌手", f"https://example.com/{index}.jpg", WEBP_COVER)
        self.assertEqual(len(self.service.cover_files), 8)
        self.assertEqual(len(list(Path(self.service.cover_directory.name).iterdir())), 8)

    def test_cover_path_is_used_for_both_notification_icon_and_image_hint(self):
        self.service.connection = Mock()
        icon = str(Path(self.service.cover_directory.name).resolve() / "cover.webp")
        variant = Mock(side_effect=lambda signature, value: (signature, value))
        with patch.object(repository.GLib, "Variant", variant, create=True), \
                patch.object(repository.GLib, "VariantType", SimpleNamespace(new=lambda signature: signature), create=True), \
                patch.object(repository.Gio, "DBusCallFlags", SimpleNamespace(NONE=0), create=True):
            self.service.send_notification("歌曲", "歌手", icon)
        values = self.service.connection.call.call_args.args[4][1]
        self.assertEqual(values[2], icon)
        self.assertEqual(values[6]["image-path"], ("s", icon))

    def test_missing_notification_service_is_logged_without_breaking_playback(self):
        connection = Mock()
        connection.call_finish.side_effect = RuntimeError("no notification daemon")
        with patch.object(repository.GLib, "Error", RuntimeError, create=True), patch("sys.stderr", new_callable=io.StringIO) as output:
            self.service.on_notification_sent(connection, object(), None)
        self.assertIn("no notification daemon", output.getvalue())


class FilenameTests(unittest.TestCase):
    def test_separators_control_characters_and_dots_never_survive(self):
        for original in ("..\\..\\etc/passwd", "/etc/shadow", "..", ".hidden", "a\x00b\x1fc", "  ..名字..  ", "name."):
            name = helper.sanitize_filename(original, ".mp3")
            self.assertTrue(name.endswith(".mp3"), name)
            body = name[: -len(".mp3")]
            self.assertTrue(body, original)
            self.assertNotIn("/", body)
            self.assertNotIn("\\", body)
            self.assertFalse(body.startswith("."), name)
            self.assertEqual(os.path.basename(body), body)
            self.assertEqual(body, body.strip(" ."))

    def test_unicode_is_kept_and_byte_length_is_capped(self):
        name = helper.sanitize_filename("歌手" * 400 + " - " + "歌名" * 400, ".flac")
        body = name[: -len(".flac")]
        self.assertTrue(body.startswith("歌手"))
        self.assertLessEqual(len(body.encode("utf-8")), helper.FILENAME_BYTE_LIMIT)

    def test_empty_names_fall_back(self):
        for original in ("  ..  ", "", None, "..."):
            self.assertEqual(helper.sanitize_filename(original, ".mp3"), "未命名.mp3")

    def test_a_supplied_audio_extension_is_replaced_not_stacked(self):
        self.assertEqual(helper.sanitize_filename("歌 - 名.mp3", ".flac"), "歌 - 名.flac")
        self.assertEqual(helper.sanitize_filename("歌 - 名.FLAC", ".mp3"), "歌 - 名.mp3")


class DirectoryTests(unittest.TestCase):
    def test_default_directory_uses_the_music_folder(self):
        for requested in ("", None, "   "):
            self.assertEqual(helper.download_directory(requested), os.path.expanduser("~/Music/网易云音乐"))

    def test_explicit_directory_expands_home(self):
        self.assertEqual(helper.download_directory("~/音乐/网易云"), os.path.expanduser("~/音乐/网易云"))
        self.assertEqual(helper.download_directory("/tmp/nemusic"), "/tmp/nemusic")


class AudioExtensionTests(unittest.TestCase):
    def test_magic_bytes_win_over_the_declared_type(self):
        self.assertEqual(helper.audio_extension(b"fLaC\x00\x00", "mp3"), ".flac")
        self.assertEqual(helper.audio_extension(b"ID3\x04\x00", "flac"), ".mp3")
        self.assertEqual(helper.audio_extension(b"\xff\xfb\x90\x00", None), ".mp3")
        self.assertEqual(helper.audio_extension(b"\x00\x00\x00\x20ftypM4A ", "flac"), ".m4a")

    def test_unknown_payloads_fall_back_to_a_known_declared_type_or_fail(self):
        unknown = b"\x01\x02\x03\x04\x05\x06\x07\x08\x09"
        self.assertEqual(helper.audio_extension(unknown, "flac"), ".flac")
        self.assertIsNone(helper.audio_extension(unknown, None))
        self.assertIsNone(helper.audio_extension(unknown, "exe"))


class DownloadUrlTests(unittest.TestCase):
    def test_rejects_non_http_schemes_and_missing_hosts(self):
        for url in ("file:///etc/passwd", "ftp://example.com/song.mp3", "blob:https://music.163.com/x", "https:///song.mp3", "", None):
            with self.assertRaises(ValueError):
                helper.validate_download_url(url)

    def test_rejects_loopback_private_and_link_local_hosts(self):
        for address in ("127.0.0.1", "192.168.1.10", "10.0.0.5", "169.254.1.1", "::1", "fd00::1"):
            with patch.object(helper.socket, "getaddrinfo", return_value=[(2, 1, 6, "", (address, 80))]):
                with self.assertRaises(ValueError):
                    helper.validate_download_url("http://cdn.example.com/song.mp3")

    def test_accepts_a_public_host(self):
        with patch.object(helper.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            self.assertEqual(helper.validate_download_url("https://m701.music.126.net/song.mp3"), "https://m701.music.126.net/song.mp3")

    def test_reports_unresolvable_hosts(self):
        with patch.object(helper.socket, "getaddrinfo", side_effect=socket.gaierror("boom")):
            with self.assertRaises(ValueError):
                helper.validate_download_url("https://nope.invalid/song.mp3")


class UniquePathTests(unittest.TestCase):
    def test_existing_files_are_never_overwritten(self):
        with TemporaryDirectory() as directory:
            first, first_path = helper.open_unique(directory, "歌 - 名", ".mp3")
            first.close()
            second, second_path = helper.open_unique(directory, "歌 - 名", ".mp3")
            second.close()
            self.assertEqual(os.path.basename(first_path), "歌 - 名.mp3")
            self.assertEqual(os.path.basename(second_path), "歌 - 名 (1).mp3")
            self.assertEqual(len(os.listdir(directory)), 2)


class DownloadTestCase(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.service.download = None
        self.service.last_seen = time.monotonic()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def post_download(self, payload, token="test-token"):
        handler_type = self.service.make_handler()
        handler = handler_type.__new__(handler_type)
        body = json.dumps(payload).encode()
        handler.path = "/download"
        handler.headers = {"X-NEMusic-Token": token, "Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.reply = Mock()
        handler.do_POST()
        return handler.reply

    def get_download(self):
        handler_type = self.service.make_handler()
        handler = handler_type.__new__(handler_type)
        handler.path = "/download"
        handler.headers = {"X-NEMusic-Token": "test-token"}
        handler.reply = Mock()
        handler.do_GET()
        return handler.reply

    def public_host(self):
        return patch.object(helper.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))])

    def run_job(self, content, declared="mp3", directory=None, total=None, filename="歌 - 名"):
        headers = Message()
        if total is not None:
            headers["Content-Length"] = str(total)
        response = io.BytesIO(content)
        response.headers = headers
        job = {"active": True, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
        with patch.object(helper, "urlopen", return_value=response):
            self.service.run_download(job, "https://cdn.example.com/song", directory or self.directory.name, filename, declared)
        return job


class DownloadEndpointTests(DownloadTestCase):
    def test_requires_the_token(self):
        reply = self.post_download({"url": "https://cdn.example.com/song.mp3"}, token="wrong")
        reply.assert_called_once_with(403, {"error": "forbidden"})

    def test_rejects_a_bad_scheme_without_starting_a_job(self):
        with patch.object(helper.threading, "Thread") as worker:
            reply = self.post_download({"url": "file:///etc/passwd", "filename": "歌", "directory": self.directory.name})
        reply.assert_called_once_with(400, {"error": "只支持 http/https 音频地址"})
        worker.assert_not_called()
        self.assertIsNone(self.service.download)

    def test_rejects_a_second_job_while_one_is_active(self):
        self.service.download = {"active": True, "received": 1, "total": 2, "filename": "a.mp3", "path": "/tmp/a.mp3", "error": ""}
        with self.public_host():
            reply = self.post_download({"url": "https://cdn.example.com/song.mp3", "filename": "歌", "directory": self.directory.name})
        reply.assert_called_once_with(409, {"error": "已有下载任务在进行"})

    def test_rejects_an_unusable_directory(self):
        with self.public_host():
            reply = self.post_download({"url": "https://cdn.example.com/song.mp3", "filename": "歌", "directory": "/proc/nope/nope"})
        self.assertEqual(reply.call_args.args[0], 400)
        self.assertIn("下载目录不可用", reply.call_args.args[1]["error"])

    def test_creates_a_missing_directory_and_starts_a_background_job(self):
        target = Path(self.directory.name) / "新建目录"
        with self.public_host(), patch.object(helper.threading, "Thread") as worker:
            reply = self.post_download({"url": "https://cdn.example.com/song.mp3", "filename": "歌 - 名", "directory": str(target), "type": "mp3"})
        reply.assert_called_once_with(202, {"started": True})
        worker.return_value.start.assert_called_once_with()
        self.assertTrue(target.is_dir())
        self.assertTrue(self.service.download["active"])
        self.assertEqual(self.service.download["filename"], "")

    def test_reports_an_idle_progress_snapshot(self):
        reply = self.get_download()
        reply.assert_called_once_with(200, {"active": False, "received": 0, "total": 0, "filename": "", "path": "", "error": ""})


class DownloadRunTests(DownloadTestCase):
    def test_streams_audio_and_sniffs_the_extension_from_magic_bytes(self):
        content = b"fLaC" + b"\x00" * 10
        job = self.run_job(content, declared="mp3", total=len(content))
        self.assertEqual(job["error"], "")
        self.assertFalse(job["active"])
        self.assertEqual(job["filename"], "歌 - 名.flac")
        self.assertEqual(Path(job["path"]).read_bytes(), content)
        self.assertEqual(job["received"], len(content))
        self.assertEqual(job["total"], len(content))

    def test_existing_files_are_suffixed_instead_of_overwritten(self):
        first = self.run_job(b"ID3" + b"\x00" * 8)
        second = self.run_job(b"ID3" + b"\x00" * 8)
        self.assertEqual(first["filename"], "歌 - 名.mp3")
        self.assertEqual(second["filename"], "歌 - 名 (1).mp3")
        self.assertEqual(len(os.listdir(self.directory.name)), 2)

    def test_a_crafted_filename_cannot_escape_the_directory(self):
        job = self.run_job(b"ID3" + b"\x00" * 8, filename="../../../etc/passwd")
        self.assertEqual(job["error"], "")
        root = os.path.realpath(self.directory.name)
        self.assertNotIn("/", job["filename"])
        self.assertNotIn("\\", job["filename"])
        self.assertEqual(job["path"], os.path.join(root, job["filename"]))
        self.assertEqual(os.listdir(root), [job["filename"]])

    def test_a_partial_file_is_removed_when_the_size_cap_is_hit(self):
        with patch.object(helper, "MAX_DOWNLOAD_BYTES", 1024):
            job = self.run_job(b"ID3" + b"\x00" * 2048, total=64)
        self.assertIn("大小上限", job["error"])
        self.assertFalse(job["active"])
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_html_and_empty_responses_leave_no_file_behind(self):
        for content, expected in ((b"<html>error</html>", "无法识别的音频格式"), (b"", "音频响应为空")):
            job = self.run_job(content, declared=None)
            self.assertIn(expected, job["error"])
            self.assertEqual(os.listdir(self.directory.name), [])

    def test_transport_errors_are_reported_without_crashing(self):
        job = {"active": True, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
        with patch.object(helper, "urlopen", side_effect=OSError("offline")):
            self.service.run_download(job, "https://cdn.example.com/song", self.directory.name, "歌", "mp3")
        self.assertIn("offline", job["error"])
        self.assertFalse(job["active"])


class IdleShutdownTests(DownloadTestCase):
    def test_an_active_download_prevents_the_idle_shutdown(self):
        self.service.download = {"active": True, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
        self.service.last_seen = time.monotonic() - 3600
        self.assertTrue(self.service.check_idle())

    def test_an_idle_service_still_shuts_down(self):
        self.service.download = {"active": False, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
        self.service.last_seen = time.monotonic() - 3600
        self.service.loop = SimpleNamespace(quit=Mock())
        self.assertFalse(self.service.check_idle())
        self.service.loop.quit.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
