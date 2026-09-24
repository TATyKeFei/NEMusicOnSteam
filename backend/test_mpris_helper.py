import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
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


if __name__ == "__main__":
    unittest.main()
