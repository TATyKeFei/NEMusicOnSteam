import io
import threading
import unittest
from unittest.mock import Mock, patch

from mpd_helper import MpdClient, MpdService, quote


class MpdProtocolTests(unittest.TestCase):
    def connection(self, response):
        connection = Mock()
        connection.makefile.return_value = io.BytesIO(response)
        return connection

    def test_tcp_authentication_and_quoted_arguments(self):
        connection = self.connection(b"OK MPD 0.24.15\nOK\nId: 7\nOK\n")
        client = MpdClient({"host": "music.local", "port": 6601, "password": 'a"b\\c'})
        with patch("mpd_helper.socket.create_connection", return_value=connection) as connect:
            with client.session() as session:
                self.assertEqual(session.command("addid", "https://music.example/a b.mp3"), {"Id": "7"})
        connect.assert_called_once_with(("music.local", 6601), timeout=3)
        self.assertEqual(connection.sendall.call_args_list[0].args[0], b'password "a\\"b\\\\c"\n')
        self.assertEqual(connection.sendall.call_args_list[1].args[0], b'addid "https://music.example/a b.mp3"\n')
        connection.close.assert_called_once()

    def test_unix_socket_takes_precedence_over_tcp(self):
        connection = self.connection(b"OK MPD 0.24.15\nOK\n")
        with patch("mpd_helper.socket.socket", return_value=connection), patch("mpd_helper.socket.create_connection") as tcp:
            with MpdClient({"socket": "/tmp/test-mpd.sock", "host": "ignored"}).session() as session:
                self.assertEqual(session.command("ping"), {})
        connection.connect.assert_called_once_with("/tmp/test-mpd.sock")
        tcp.assert_not_called()

    def test_authentication_error_does_not_expose_password(self):
        connection = self.connection(b"OK MPD 0.24.15\nACK [3@0] {password} secret\n")
        with patch("mpd_helper.socket.create_connection", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, "认证失败") as error:
                with MpdClient({"password": "secret"}).session():
                    pass
        self.assertNotIn("secret", str(error.exception))
        connection.close.assert_called_once()

    def test_protocol_ack_and_disconnect_are_reported(self):
        for response, message in ((b"ACK [5@0] {status} permission denied\n", "permission denied"), (b"", "断开")):
            connection = self.connection(b"OK MPD 0.24.15\n" + response)
            with patch("mpd_helper.socket.create_connection", return_value=connection):
                with MpdClient({}).session() as session:
                    with self.assertRaisesRegex(RuntimeError, message):
                        session.command("status")

    def test_rejects_command_injection(self):
        for value in ("x\nclear", "x\rstop", "x\x00"):
            with self.assertRaises(ValueError):
                quote(value)
            with self.assertRaises(ValueError):
                MpdClient({"password": value})


class MpdServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = MpdService.__new__(MpdService)
        self.service.operations = threading.RLock()
        self.service.track = {"title": "歌曲", "trackId": "123"}
        self.service.song_id = "7"
        self.service.original_modes = {"single": "0", "repeat": "1", "random": "1", "consume": "0"}
        self.service.loop_status = "None"
        self.service.shuffle = False
        self.status = {"songid": "7", "state": "play", "volume": "0", "elapsed": "12.5", "duration": "100"}
        self.commands = []
        self.session = Mock()
        self.session.__enter__ = Mock(return_value=self.session)
        self.session.__exit__ = Mock(return_value=False)
        def command(name, *args):
            self.commands.append((name, *args))
            return {"status": self.status, "playlistid": {"Id": "7"}, "addid": {"Id": "7"}}.get(name, {})
        self.session.command.side_effect = command
        self.service.client = Mock()
        self.service.client.session.return_value = self.session

    def test_snapshot_preserves_zero_volume_and_fractional_position(self):
        state = self.service.snapshot()
        self.assertEqual(state["volume"], 0)
        self.assertEqual(state["position"], 12.5)
        self.assertEqual(state["duration"], 100)
        self.assertEqual(state["playbackStatus"], "Playing")
        self.assertEqual(state["trackId"], "123")

    def test_load_applies_explicit_repeat_mode_for_finish_current_and_recovery(self):
        for mode in ("Track", "None", "Playlist"):
            self.commands.clear()
            self.service.load({"url": "https://music.example/song.mp3", "title": "歌曲", "loopStatus": mode})
            self.assertIn(("repeat", 1 if mode == "Track" else 0), self.commands)
            self.assertEqual(self.service.loop_status, mode)

    def test_reports_missing_mixer_without_faking_full_volume(self):
        self.status["volume"] = "-1"
        self.assertIsNone(self.service.snapshot()["volume"])
        self.assertFalse(self.service.command({"action": "volume", "value": 1}))
        self.assertFalse(any(command[0] == "setvol" for command in self.commands))

    def test_surfaces_decoder_errors_and_external_takeover(self):
        self.status["error"] = "HTTP 403"
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            self.service.snapshot()
        del self.status["error"]
        self.status["songid"] = "9"
        with self.assertRaisesRegex(RuntimeError, "其他客户端"):
            self.service.snapshot()
        self.assertFalse(self.service.command({"action": "stop"}))

    def test_natural_end_without_current_song_still_reports_active_stopped(self):
        del self.status["songid"]
        self.status["state"] = "stop"
        state = self.service.snapshot()
        self.assertTrue(state["active"])
        self.assertEqual(state["playbackStatus"], "Stopped")
        self.assertTrue(self.service.command({"action": "play"}))
        self.assertIn(("playid", "7"), self.commands)

    def test_load_preserves_user_queue_and_seek_is_not_reset_by_playid(self):
        self.service.load({"url": "https://music.example/song.mp3", "title": "新歌", "trackId": "456", "position": 20, "volume": 0})
        self.assertIn(("setvol", 0), self.commands)
        self.assertIn(("seekid", "7", 20.0), self.commands)
        self.assertNotIn(("playid", "7"), self.commands)
        self.assertFalse(any(command[0] in ("clear", "kill") for command in self.commands))
        self.assertIn(("deleteid", "7"), self.commands)
        self.assertLess(self.commands.index(("stop",)), self.commands.index(("deleteid", "7")))
        self.assertEqual(self.service.track["trackId"], "456")

    def test_load_paused_song_and_reject_non_http_urls(self):
        self.service.load({"url": "https://music.example/song.mp3", "title": "歌曲", "autoplay": False})
        self.assertIn(("pause", 1), self.commands)
        with self.assertRaises(ValueError):
            self.service.load({"url": "file:///private/file", "title": "歌曲"})

    def test_commands_use_microseconds_and_keep_shuffle_in_web_queue(self):
        self.assertTrue(self.service.command({"action": "seek", "value": -2500000}))
        self.assertIn(("seekid", "7", 10.0), self.commands)
        self.assertTrue(self.service.command({"action": "setposition", "value": 3000000}))
        self.assertIn(("seekid", "7", 3.0), self.commands)
        self.assertTrue(self.service.command({"action": "loop", "value": "Track"}))
        self.assertIn(("repeat", 1), self.commands)
        self.assertTrue(self.service.command({"action": "shuffle", "value": True}))
        self.assertNotIn(("random", 1), self.commands)
        self.assertFalse(self.service.command({"action": "rate", "value": 2}))

    def test_close_restores_modes_and_deletes_only_own_song(self):
        self.service.close()
        self.assertIn(("stop",), self.commands)
        self.assertIn(("deleteid", "7"), self.commands)
        for key, value in (("single", "0"), ("repeat", "1"), ("random", "1"), ("consume", "0")):
            self.assertIn((key, value), self.commands)
        self.assertFalse(any(command[0] in ("clear", "kill") for command in self.commands))

    def test_close_leaves_external_playback_running(self):
        self.status["songid"] = "9"
        self.service.close()
        self.assertNotIn(("stop",), self.commands)
        self.assertNotIn(("single", "0"), self.commands)
        self.assertIn(("deleteid", "7"), self.commands)


if __name__ == "__main__":
    unittest.main()
