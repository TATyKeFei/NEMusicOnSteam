import importlib.util
import io
import json
from pathlib import Path
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


repository = ModuleType("gi.repository")
repository.Gio = SimpleNamespace()
repository.GLib = SimpleNamespace(idle_add=Mock())
spec = importlib.util.spec_from_file_location("mpris_helper_test_target", Path(__file__).with_name("mpris_helper.py"))
helper = importlib.util.module_from_spec(spec)
with patch.dict("sys.modules", {"gi": ModuleType("gi"), "gi.repository": repository}):
    spec.loader.exec_module(helper)


class VolumeFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.service = helper.MprisService.__new__(helper.MprisService)
        self.service.lock = threading.Lock()
        self.service.token = "test-token"
        self.service.commands = []
        self.service.state = {"volume": 0.42}
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


if __name__ == "__main__":
    unittest.main()
