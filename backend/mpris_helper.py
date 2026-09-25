import hashlib
import html
import ipaddress
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPException
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from gi.repository import Gio, GLib


OBJECT_PATH = "/org/mpris/MediaPlayer2"
BUS_NAME = "org.mpris.MediaPlayer2.NEMusicOnSteam"


def cover_extension(data):
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


DEFAULT_DOWNLOAD_DIRECTORY = "~/Music/网易云音乐"
DOWNLOAD_CHUNK = 64 * 1024
DOWNLOAD_TIMEOUT = 30
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
FILENAME_BYTE_LIMIT = 180
DECLARED_AUDIO_TYPES = ("mp3", "flac", "m4a", "wav", "aac", "ape", "ogg")
AUDIO_SUFFIXES = tuple("." + kind for kind in DECLARED_AUDIO_TYPES)
CONTROL_CHARACTERS = frozenset(chr(code) for code in range(32)) | {"\x7f"}
MP3_MAGIC = (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa", b"\xff\xf9")


def audio_extension(data, declared=None):
    if data[:3] == b"ID3" or data[:2] in MP3_MAGIC:
        return ".mp3"
    if data[:4] == b"fLaC":
        return ".flac"
    if data[4:8] == b"ftyp":
        return ".m4a"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return ".wav"
    if data[:4] == b"OggS":
        return ".ogg"
    kind = str(declared or "").lower()
    return "." + kind if kind in DECLARED_AUDIO_TYPES else None


def sanitize_filename(name, extension):
    text = "".join("-" if character in "/\\" else character for character in str(name or ""))
    text = "".join(" " if character in CONTROL_CHARACTERS else character for character in text)
    text = " ".join(text.split()).strip(" .")
    for suffix in AUDIO_SUFFIXES:
        if text.lower().endswith(suffix):
            text = text[: -len(suffix)].strip(" .")
            break
    while text and len(text.encode("utf-8")) > FILENAME_BYTE_LIMIT:
        text = text[:-1].strip(" .")
    return (text or "未命名") + extension


def download_directory(requested):
    return os.path.expanduser(str(requested or "").strip() or DEFAULT_DOWNLOAD_DIRECTORY)


def validate_download_url(url):
    parts = urlsplit(str(url or ""))
    if parts.scheme not in ("http", "https"):
        raise ValueError("只支持 http/https 音频地址")
    host = parts.hostname
    if not host:
        raise ValueError("音频地址缺少主机名")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
        addresses = {info[4][0].split("%")[0] for info in socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)}
    except (OSError, ValueError) as error:
        raise ValueError(f"无法解析音频地址主机: {error}")
    if not addresses:
        raise ValueError("无法解析音频地址主机")
    for address in addresses:
        try:
            resolved = ipaddress.ip_address(address)
        except ValueError:
            raise ValueError(f"无法识别的音频地址主机: {address}")
        if not resolved.is_global:
            raise ValueError("拒绝下载内网或保留地址")
    return str(url)


def open_unique(directory, base, extension):
    root = os.path.realpath(directory)
    for index in range(1000):
        suffix = "" if index == 0 else f" ({index})"
        path = os.path.join(root, f"{base}{suffix}{extension}")
        if os.path.dirname(os.path.realpath(path)) != root:
            raise ValueError("下载路径越界")
        try:
            return open(path, "xb"), path
        except FileExistsError:
            continue
    raise ValueError("同名文件过多")


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
    <property name="Volume" type="d" access="readwrite"/>
  </interface>
</node>"""


class MprisService:
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.state = {}
        self.commands = []
        self.download = None
        self.last_seen = time.monotonic()
        self.notification_serial = 0
        self.last_notified_track = None
        self.cover_files = {}
        self.cover_directory = TemporaryDirectory(prefix="covers-", dir=runtime_dir)
        self.loop = GLib.MainLoop()
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        for interface in self.node.interfaces:
            self.connection.register_object(OBJECT_PATH, interface, self.on_method, self.on_property, self.on_set_property)
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

            def read_payload(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > 65536:
                        raise ValueError("invalid length")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError("invalid payload")
                    return payload
                except (ValueError, json.JSONDecodeError):
                    return None

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path == "/commands":
                    with service.lock:
                        service.last_seen = time.monotonic()
                        commands, service.commands = service.commands, []
                    self.reply(200, commands)
                    return
                if self.path == "/download":
                    with service.lock:
                        service.last_seen = time.monotonic()
                    self.reply(200, service.download_snapshot())
                    return
                self.reply(404, {})

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path == "/shutdown":
                    self.reply(200, {})
                    GLib.idle_add(service.loop.quit)
                    return
                if self.path == "/download":
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {})
                        return
                    try:
                        job = service.start_download(payload.get("url"), payload.get("filename"), payload.get("directory"), payload.get("type"))
                    except ValueError as error:
                        self.reply(400, {"error": str(error)})
                        return
                    if job is None:
                        self.reply(409, {"error": "已有下载任务在进行"})
                        return
                    self.reply(202, {"started": True})
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
                    if state.get("volume") is None:
                        state["volume"] = previous.get("volume")
                    service.state = state
                    service.last_seen = time.monotonic()
                    if state.get("active") and state.get("playbackStatus") == "Playing" and state.get("title"):
                        track = (state.get("trackId"), state.get("title"), state.get("artist"))
                        if track != service.last_notified_track:
                            service.last_notified_track = track
                            GLib.idle_add(service.notify_track, str(state["title"]), str(state.get("artist") or "未知歌手"), str(state.get("artUrl") or ""))
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
                if previous.get("volume") != state.get("volume"):
                    changed.append("Volume")
                if state.get("active"):
                    changed.append("Position")
                if changed:
                    GLib.idle_add(service.emit_changed, changed)
                if previous.get("trackId") == state.get("trackId") and previous.get("active") and state.get("active"):
                    old_position = float(previous.get("position") or 0)
                    new_position = float(state.get("position") or 0)
                    if abs(new_position - old_position) > 3.5:
                        GLib.idle_add(service.emit_seeked, int(new_position * 1000000))
                self.reply(200, {})

        return Handler

    def notify_track(self, title, artist, art_url=""):
        self.notification_serial += 1
        serial = self.notification_serial
        if art_url in self.cover_files:
            self.cover_files[art_url] = self.cover_files.pop(art_url)
            return self.send_notification(title, artist, self.cover_files[art_url])
        if art_url.startswith(("https://", "http://")):
            threading.Thread(target=self.load_notification_cover, args=(serial, title, artist, art_url), daemon=True).start()
            return False
        return self.send_notification(title, artist)

    def load_notification_cover(self, serial, title, artist, art_url):
        data = None
        try:
            request = Request(art_url, headers={"User-Agent": "NEMusicOnSteam", "Referer": "https://music.163.com/"})
            with urlopen(request, timeout=3) as response:
                limit = 4 * 1024 * 1024
                content = response.read(limit + 1)
                if len(content) <= limit and cover_extension(content):
                    data = content
                else:
                    print(f"[NEMusic] Notification cover rejected: type={response.headers.get_content_type()}, bytes={len(content)}", file=sys.stderr, flush=True)
        except (OSError, ValueError, HTTPException) as error:
            print(f"[NEMusic] Notification cover unavailable: {error}", file=sys.stderr, flush=True)
        GLib.idle_add(self.finish_notification_cover, serial, title, artist, art_url, data)

    def finish_notification_cover(self, serial, title, artist, art_url, data):
        if serial != self.notification_serial:
            return False
        icon = "audio-x-generic"
        extension = cover_extension(data) if data else None
        if extension:
            try:
                path = os.path.join(self.cover_directory.name, hashlib.sha256(art_url.encode()).hexdigest() + extension)
                with open(path, "wb") as cover_file:
                    cover_file.write(data)
                self.cover_files[art_url] = path
                while len(self.cover_files) > 8:
                    oldest = next(iter(self.cover_files))
                    os.unlink(self.cover_files.pop(oldest))
                icon = path
            except OSError as error:
                print(f"[NEMusic] Notification cover cache failed: {error}", file=sys.stderr, flush=True)
        return self.send_notification(title, artist, icon)

    def send_notification(self, title, artist, icon="audio-x-generic"):
        try:
            hints = {"suppress-sound": GLib.Variant("b", True)}
            if os.path.isabs(icon):
                hints["image-path"] = GLib.Variant("s", icon)
            self.connection.call(
                "org.freedesktop.Notifications",
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "Notify",
                GLib.Variant("(susssasa{sv}i)", (
                    "网易云音乐 (Steam)", 0, icon, title, html.escape(artist),
                    [], hints, 5000,
                )),
                GLib.VariantType.new("(u)"),
                Gio.DBusCallFlags.NONE,
                5000,
                None,
                self.on_notification_sent,
                None,
            )
        except GLib.Error as error:
            print(f"[NEMusic] Notification failed: {error}", file=sys.stderr, flush=True)
        return False

    def on_notification_sent(self, connection, result, _user_data):
        try:
            connection.call_finish(result)
        except GLib.Error as error:
            print(f"[NEMusic] Notification failed: {error}", file=sys.stderr, flush=True)

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

    def on_set_property(self, _connection, _sender, _path, interface, name, value):
        if interface != "org.mpris.MediaPlayer2.Player" or name != "Volume":
            return False
        volume = max(0.0, min(1.0, float(value.unpack())))
        self.queue({"action": "volume", "value": volume})
        return True

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
            "Volume": GLib.Variant("d", max(0.0, min(1.0, float(state.get("volume") if state.get("volume") is not None else 1.0)))),
        }
        return player.get(name)

    def emit_changed(self, names):
        changed = {name: self.on_property(None, None, None, "org.mpris.MediaPlayer2.Player", name) for name in names}
        self.connection.emit_signal(None, OBJECT_PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged", GLib.Variant("(sa{sv}as)", ("org.mpris.MediaPlayer2.Player", changed, [])))
        return False

    def emit_seeked(self, position):
        self.connection.emit_signal(None, OBJECT_PATH, "org.mpris.MediaPlayer2.Player", "Seeked", GLib.Variant("(x)", (position,)))
        return False

    def download_snapshot(self):
        with self.lock:
            if self.download is None:
                return {"active": False, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
            return dict(self.download)

    def start_download(self, url, filename, directory, declared):
        validate_download_url(url)
        destination = download_directory(directory)
        try:
            os.makedirs(destination, exist_ok=True)
        except OSError as error:
            raise ValueError(f"下载目录不可用: {error}")
        if not os.path.isdir(destination) or not os.access(destination, os.W_OK):
            raise ValueError(f"下载目录不可用: {destination}")
        with self.lock:
            if self.download is not None and self.download.get("active"):
                return None
            job = {"active": True, "received": 0, "total": 0, "filename": "", "path": "", "error": ""}
            self.download = job
            self.last_seen = time.monotonic()
        worker = threading.Thread(target=self.run_download, args=(job, str(url), destination, str(filename or ""), declared), daemon=True)
        worker.start()
        return job

    def run_download(self, job, url, destination, filename, declared):
        path = None
        try:
            request = Request(url, headers={"User-Agent": "NEMusicOnSteam", "Referer": "https://music.163.com/"})
            with urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
                declared_total = int(response.headers.get("Content-Length") or 0)
                if declared_total > MAX_DOWNLOAD_BYTES:
                    raise ValueError("音频文件超过大小上限")
                chunk = response.read(DOWNLOAD_CHUNK)
                if not chunk:
                    raise ValueError("音频响应为空")
                extension = audio_extension(chunk, declared)
                if extension is None:
                    raise ValueError("无法识别的音频格式")
                handle, path = open_unique(destination, sanitize_filename(filename, ""), extension)
                received = 0
                with handle:
                    while chunk:
                        handle.write(chunk)
                        received += len(chunk)
                        if received > MAX_DOWNLOAD_BYTES:
                            raise ValueError("音频文件超过大小上限")
                        with self.lock:
                            job["received"] = received
                            job["total"] = max(declared_total, received)
                            self.last_seen = time.monotonic()
                        chunk = response.read(DOWNLOAD_CHUNK)
                with self.lock:
                    job["filename"] = os.path.basename(path)
                    job["path"] = path
                    job["total"] = received
        except (OSError, ValueError, HTTPException) as error:
            if path is not None:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            with self.lock:
                job["error"] = str(error) or error.__class__.__name__
        finally:
            with self.lock:
                job["active"] = False
                self.last_seen = time.monotonic()

    def check_idle(self):
        with self.lock:
            downloading = self.download is not None and self.download.get("active")
            expired = time.monotonic() - self.last_seen > 15
        if downloading:
            return True
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
            self.cover_directory.cleanup()


if __name__ == "__main__":
    with open(os.path.join(sys.argv[1], "token"), encoding="ascii") as token_file:
        MprisService(sys.argv[1], token_file.read()).run()
