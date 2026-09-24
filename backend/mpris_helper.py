import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gi.repository import Gio, GLib


OBJECT_PATH = "/org/mpris/MediaPlayer2"
BUS_NAME = "org.mpris.MediaPlayer2.NEMusicOnSteam"
INTROSPECTION = """<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>"""


class MprisService:
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.state = {}
        self.commands = []
        self.last_seen = time.monotonic()
        self.loop = GLib.MainLoop()
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        for interface in self.node.interfaces:
            self.connection.register_object(OBJECT_PATH, interface, self.on_method, self.on_property, None)
        self.owner = Gio.bus_own_name_on_connection(self.connection, BUS_NAME, Gio.BusNameOwnerFlags.NONE, None, None)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.make_handler())
        self.server.daemon_threads = True

    def make_handler(self):
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, code, payload):
                body = b"" if code == 204 else json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "X-NEMusic-Token, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.reply(204, {})

            def authorized(self):
                if self.headers.get("X-NEMusic-Token") != service.token:
                    self.reply(403, {"error": "forbidden"})
                    return False
                return True

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path != "/commands":
                    self.reply(404, {})
                    return
                with service.lock:
                    service.last_seen = time.monotonic()
                    commands, service.commands = service.commands, []
                self.reply(200, commands)

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path == "/shutdown":
                    self.reply(200, {})
                    GLib.idle_add(service.loop.quit)
                    return
                if self.path != "/state":
                    self.reply(404, {})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > 65536:
                        raise ValueError("invalid length")
                    state = json.loads(self.rfile.read(length))
                    if not isinstance(state, dict):
                        raise ValueError("invalid state")
                except (ValueError, json.JSONDecodeError):
                    self.reply(400, {})
                    return
                with service.lock:
                    previous = service.state
                    service.state = state
                    service.last_seen = time.monotonic()
                changed = []
                if any(previous.get(key) != state.get(key) for key in ("active", "playbackStatus")):
                    changed.append("PlaybackStatus")
                if any(previous.get(key) != state.get(key) for key in ("active", "title", "artist", "album", "artUrl", "trackId", "duration")):
                    changed.append("Metadata")
                if previous.get("active") != state.get("active"):
                    changed.extend(("CanPlay", "CanPause", "CanControl"))
                if any(previous.get(key) != state.get(key) for key in ("active", "canGoNext")):
                    changed.append("CanGoNext")
                if any(previous.get(key) != state.get(key) for key in ("active", "canGoPrevious")):
                    changed.append("CanGoPrevious")
                if any(previous.get(key) != state.get(key) for key in ("active", "canSeek")):
                    changed.append("CanSeek")
                if changed:
                    GLib.idle_add(service.emit_changed, changed)
                if previous.get("trackId") == state.get("trackId") and previous.get("active") and state.get("active"):
                    old_position = float(previous.get("position") or 0)
                    new_position = float(state.get("position") or 0)
                    if abs(new_position - old_position) > 3.5:
                        GLib.idle_add(service.emit_seeked, int(new_position * 1000000))
                self.reply(200, {})

        return Handler

    def queue(self, command):
        with self.lock:
            self.commands.append(command)

    def on_method(self, _connection, _sender, _path, interface, method, parameters, invocation):
        if interface == "org.mpris.MediaPlayer2":
            if method == "Raise":
                self.queue({"action": "open"})
        elif method in ("Next", "Previous", "Pause", "PlayPause", "Stop", "Play"):
            self.queue({"action": method.lower()})
        elif method == "Seek":
            self.queue({"action": "seek", "value": parameters.unpack()[0]})
        elif method == "SetPosition":
            track_id, position = parameters.unpack()
            with self.lock:
                current = self.metadata(self.state).get("mpris:trackid")
            if current is not None and current.unpack() == track_id:
                self.queue({"action": "setposition", "value": position})
        invocation.return_value(None)

    def metadata(self, state):
        title = str(state.get("title") or "")
        artist = str(state.get("artist") or "")
        album = str(state.get("album") or "")
        art = str(state.get("artUrl") or "")
        if not title:
            return {}
        key = str(state.get("trackId") or title + artist)
        track_id = OBJECT_PATH + "/Track/" + hashlib.sha1(key.encode()).hexdigest()
        result = {
            "mpris:trackid": GLib.Variant("o", track_id),
            "xesam:title": GLib.Variant("s", title),
            "xesam:artist": GLib.Variant("as", [artist] if artist else []),
        }
        if album:
            result["xesam:album"] = GLib.Variant("s", album)
        if art.startswith(("https://", "http://")):
            result["mpris:artUrl"] = GLib.Variant("s", art)
        duration = state.get("duration")
        if isinstance(duration, (int, float)) and duration > 0:
            result["mpris:length"] = GLib.Variant("x", int(duration * 1000000))
        return result

    def on_property(self, _connection, _sender, _path, interface, name):
        with self.lock:
            state = dict(self.state)
        if interface == "org.mpris.MediaPlayer2":
            root = {
                "CanQuit": GLib.Variant("b", False),
                "CanRaise": GLib.Variant("b", True),
                "HasTrackList": GLib.Variant("b", False),
                "Identity": GLib.Variant("s", "网易云音乐 (Steam)"),
                "SupportedUriSchemes": GLib.Variant("as", []),
                "SupportedMimeTypes": GLib.Variant("as", []),
            }
            return root.get(name)
        active = bool(state.get("active"))
        player = {
            "PlaybackStatus": GLib.Variant("s", state.get("playbackStatus") if active else "Stopped"),
            "Metadata": GLib.Variant("a{sv}", self.metadata(state) if active else {}),
            "Position": GLib.Variant("x", int(float(state.get("position") or 0) * 1000000)),
            "CanGoNext": GLib.Variant("b", active and bool(state.get("canGoNext"))),
            "CanGoPrevious": GLib.Variant("b", active and bool(state.get("canGoPrevious"))),
            "CanPlay": GLib.Variant("b", active),
            "CanPause": GLib.Variant("b", active),
            "CanSeek": GLib.Variant("b", active and bool(state.get("canSeek"))),
            "CanControl": GLib.Variant("b", active),
        }
        return player.get(name)

    def emit_changed(self, names):
        changed = {name: self.on_property(None, None, None, "org.mpris.MediaPlayer2.Player", name) for name in names}
        self.connection.emit_signal(None, OBJECT_PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged", GLib.Variant("(sa{sv}as)", ("org.mpris.MediaPlayer2.Player", changed, [])))
        return False

    def emit_seeked(self, position):
        self.connection.emit_signal(None, OBJECT_PATH, "org.mpris.MediaPlayer2.Player", "Seeked", GLib.Variant("(x)", (position,)))
        return False

    def check_idle(self):
        with self.lock:
            expired = time.monotonic() - self.last_seen > 15
        if expired:
            self.loop.quit()
            return False
        return True

    def run(self):
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        with open(os.path.join(self.runtime_dir, "port"), "w", encoding="ascii") as port_file:
            port_file.write(str(self.server.server_port))
        GLib.timeout_add_seconds(2, self.check_idle)
        try:
            self.loop.run()
        finally:
            self.server.shutdown()
            Gio.bus_unown_name(self.owner)


if __name__ == "__main__":
    with open(os.path.join(sys.argv[1], "token"), encoding="ascii") as token_file:
        MprisService(sys.argv[1], token_file.read()).run()
