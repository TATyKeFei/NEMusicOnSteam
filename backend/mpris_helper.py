import hashlib
import html
import ipaddress
import json
import os
import shutil
import socket
import sys
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPException
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from gi.repository import Gio, GLib
from recognition import RecognitionService

warnings.filterwarnings("ignore", message="Gio.DBusConnection.register_object is deprecated")

OBJECT_PATH = "/org/mpris/MediaPlayer2"
BUS_NAME = "org.mpris.MediaPlayer2.NEMusicOnSteam"
POSITION_SEEK_THRESHOLD = 3.5
SEEK_REANCHOR_WINDOW = 3.0
CLIENT_GONE_ERRORS = (BrokenPipeError, ConnectionResetError)


class MprisHttpServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, CLIENT_GONE_ERRORS):
            return
        super().handle_error(request, client_address)


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


COVER_MIME = {".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}


def fetch_cover(url):
    """下载用于嵌入的封面图；返回 (字节, mime) 或 None。任何失败都不会中断下载。"""
    if not url or not url.startswith(("http://", "https://")):
        return None
    try:
        validate_download_url(url)
        request = Request(url, headers={"User-Agent": "NEMusicOnSteam", "Referer": "https://music.163.com/"})
        with urlopen(request, timeout=10) as response:
            content = response.read(4 * 1024 * 1024 + 1)
    except (OSError, ValueError, HTTPException) as error:
        print(f"[NEMusic] Cover download skipped: {error}", file=sys.stderr, flush=True)
        return None
    if len(content) > 4 * 1024 * 1024:
        return None
    extension = cover_extension(content)
    if extension is None:
        return None
    return content, COVER_MIME[extension]


def _synchsafe(value):
    return bytes(((value >> 21) & 0x7F, (value >> 14) & 0x7F, (value >> 7) & 0x7F, value & 0x7F))


def _id3_text(value):
    # v2.3 文本帧：encoding 0x01 表示带 BOM 的 UTF-16，以 NUL 结尾。
    return b"\x01\xff\xfe" + value.encode("utf-16-le") + b"\x00\x00"


def _id3_frame(frame_id, payload):
    return frame_id.encode("ascii") + len(payload).to_bytes(4, "big") + b"\x00\x00" + payload


def build_id3_tag(title, artist, album, cover):
    frames = []
    if title:
        frames.append(_id3_frame("TIT2", _id3_text(title)))
    if artist:
        frames.append(_id3_frame("TPE1", _id3_text(artist)))
    if album:
        frames.append(_id3_frame("TALB", _id3_text(album)))
    if cover is not None:
        data, mime = cover
        payload = b"\x00" + mime.encode("ascii") + b"\x00" + b"\x03" + b"\x00" + data
        frames.append(_id3_frame("APIC", payload))
    body = b"".join(frames)
    return b"ID3\x03\x00\x00" + _synchsafe(len(body)) + body


def write_id3_tag(path, title, artist, album, cover):
    with open(path, "rb") as handle:
        data = handle.read()
    if data.startswith(b"ID3") and len(data) >= 10:
        old_size = (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | data[9] & 0x7F
        audio = data[10 + old_size:]
    else:
        audio = data
    with open(path, "wb") as handle:
        handle.write(build_id3_tag(title, artist, album, cover) + audio)
    return True


def _flac_vorbis_block(comments):
    vendor = b"NEMusicOnSteam"
    entries = []
    for key, value in comments:
        if not value:
            continue
        entry = f"{key}={value}".encode("utf-8")
        entries.append(len(entry).to_bytes(4, "little") + entry)
    payload = len(vendor).to_bytes(4, "little") + vendor + len(entries).to_bytes(4, "little") + b"".join(entries)
    return 4, payload


def _flac_picture_block(cover):
    data, mime = cover
    payload = (3).to_bytes(4, "big")  # front cover
    payload += len(mime).to_bytes(4, "big") + mime.encode("ascii")
    payload += (0).to_bytes(4, "big")  # empty description
    payload += b"\x00\x00\x00\x00" * 4  # width/height/depth/colors: decoders read the image
    payload += len(data).to_bytes(4, "big") + data
    return 6, payload


def write_flac_tags(path, title, artist, album, cover):
    with open(path, "rb") as handle:
        data = handle.read()
    if not data.startswith(b"fLaC") or len(data) < 8:
        return False
    pos = 4
    kept = []
    while True:
        if pos + 4 > len(data):
            return False
        header = data[pos:pos + 4]
        last = bool(header[0] & 0x80)
        block_type = header[0] & 0x7F
        length = int.from_bytes(header[1:4], "big")
        body = data[pos + 4:pos + 4 + length]
        if len(body) != length:
            return False
        pos += 4 + length
        # 旧的评论块和图片块由我们的替换，其余块原样保留。
        if block_type not in (4, 6):
            kept.append((block_type, body))
        if last:
            break
    if not kept or kept[0][0] != 0:
        return False
    comments = [("TITLE", title), ("ARTIST", artist), ("ALBUM", album)]
    new_blocks = [_flac_vorbis_block(comments)]
    if cover is not None:
        new_blocks.append(_flac_picture_block(cover))
    all_blocks = kept[:1] + new_blocks + kept[1:]
    out = bytearray(b"fLaC")
    for index, (block_type, body) in enumerate(all_blocks):
        out.append((0x80 if index == len(all_blocks) - 1 else 0) | block_type)
        out += len(body).to_bytes(3, "big")
        out += body
    out += data[pos:]
    with open(path, "wb") as handle:
        handle.write(out)
    return True


def tag_audio(path, extension, title, artist, album, cover):
    """尽力写入元数据：失败只记日志，绝不影响下载本身。"""
    if not (title or artist or album or cover):
        return False
    cover_data = fetch_cover(cover) if cover else None
    try:
        if extension == ".mp3":
            return write_id3_tag(path, title, artist, album, cover_data)
        if extension == ".flac":
            return write_flac_tags(path, title, artist, album, cover_data)
        print(f"[NEMusic] Tagging skipped for {extension}", file=sys.stderr, flush=True)
        return False
    except (OSError, ValueError) as error:
        print(f"[NEMusic] Tagging failed: {error}", file=sys.stderr, flush=True)
        return False


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
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
  </interface>
</node>"""


class MprisService:
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.command_ready = threading.Condition(self.lock)
        self.state = {}
        self.position_anchor = None
        self.reanchor_position_until = 0.0
        self.commands = []
        self.download = None
        self.recognition = RecognitionService()
        self.notify_mode = "system"
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
        self.server = MprisHttpServer(("127.0.0.1", 0), self.make_handler())
        self.server.daemon_threads = True

    def make_handler(self):
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, code, payload):
                body = b"" if code == 204 else json.dumps(payload).encode("utf-8")
                try:
                    self.send_response(code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Allow-Headers", "X-NEMusic-Token, Content-Type")
                    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    self.send_header("Access-Control-Allow-Private-Network", "true")
                    self.send_header("Access-Control-Max-Age", "600")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                except CLIENT_GONE_ERRORS:
                    # /commands 的长轮询经常在调用方已经离开后才返回（页面刷新、
                    # HMR、fetch 被中断）。让连接安静地关掉，而不是抛出一堆回溯。
                    self.close_connection = True

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
                if self.path in ("/recognition", "/recognition/engine"):
                    with service.lock:
                        service.last_seen = time.monotonic()
                    try:
                        payload = {"source": service.recognition.engine()} if self.path.endswith("/engine") else service.recognition.snapshot()
                        self.reply(200, payload)
                    except Exception as error:
                        self.reply(502, {"error": "识曲引擎加载失败：" + str(error)})
                    return
                if self.path in ("/commands", "/commands?wait=1"):
                    with service.command_ready:
                        service.last_seen = time.monotonic()
                        if self.path == "/commands?wait=1":
                            service.command_ready.wait_for(lambda: bool(service.commands), timeout=10)
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
                if self.path in ("/recognition/start", "/recognition/match", "/recognition/cancel"):
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    with service.lock:
                        service.last_seen = time.monotonic()
                    try:
                        if self.path.endswith("/start"):
                            self.reply(202, {"id": service.recognition.start(payload.get("source"))})
                        elif not isinstance(payload.get("id"), str) or not payload["id"]:
                            self.reply(400, {"error": "缺少识曲任务编号"})
                        elif self.path.endswith("/match"):
                            service.recognition.submit(payload["id"], payload.get("fingerprint"))
                            self.reply(202, {})
                        else:
                            service.recognition.cancel(payload["id"])
                            self.reply(200, {})
                    except ValueError as error:
                        self.reply(400, {"error": str(error)})
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
                        job = service.start_download(payload.get("url"), payload.get("filename"), payload.get("directory"), payload.get("type"), payload)
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
                    incoming = state
                    state = dict(previous)
                    state.update(incoming)
                    # 通知渠道由前端选择；"steam"/"none" 时不能再叠加这里发的桌面通知。
                    if incoming.get("notify") in ("system", "steam", "none"):
                        service.notify_mode = incoming["notify"]
                    if incoming.get("volume") is None:
                        state["volume"] = previous.get("volume")
                    now = time.monotonic()
                    state["position"], seeked = service.track_position(previous, state, now)
                    service.state = state
                    service.last_seen = now
                    if seeked:
                        GLib.idle_add(service.emit_seeked, int(state["position"] * 1000000))
                    if service.notify_mode == "system" and state.get("active") and state.get("playbackStatus") == "Playing" and state.get("title"):
                        track = (state.get("trackId"), state.get("title"), state.get("artist"))
                        if track != service.last_notified_track:
                            service.last_notified_track = track
                            GLib.idle_add(service.notify_track, str(state["title"]), str(state.get("artist") or "未知歌手"), str(state.get("artUrl") or ""))
                changed = []
                if any(previous.get(key) != state.get(key) for key in ("active", "playbackStatus")):
                    changed.append("PlaybackStatus")
                if any(previous.get(key) != state.get(key) for key in ("active", "title", "artist", "album", "artUrl", "trackId", "duration", "lyrics")):
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
                for property_name, state_key in (("LoopStatus", "loopStatus"), ("Shuffle", "shuffle"), ("Rate", "rate")):
                    if previous.get(state_key) != state.get(state_key):
                        changed.append(property_name)
                if state.get("active"):
                    changed.append("Position")
                if changed:
                    GLib.idle_add(service.emit_changed, changed)
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
        with self.command_ready:
            self.commands.append(command)
            self.command_ready.notify()

    def allow_position_reanchor(self):
        with self.lock:
            self.reanchor_position_until = time.monotonic() + SEEK_REANCHOR_WINDOW

    def interpolated_position(self, now, duration=None):
        anchor = self.position_anchor
        position = 0.0 if anchor is None else max(0.0, anchor[1] + max(0.0, now - anchor[2]) * anchor[3])
        if isinstance(duration, (int, float)) and duration > 0:
            position = min(position, float(duration))
        return max(0.0, position)

    def track_position(self, previous, state, now):
        # 页面上报的 Position 是粗粒度的，但每次推送都是一次 PropertiesChanged，
        # 会让 plasma-lyrics 这类客户端把插值重新锚定到拿到的数值上。原样发布粗
        # 粒度采样，就会在两次上报之间把客户端往回拖，表现为歌词倒退到上一句。
        # 因此除非页面确实超前、播放停止、发生了 seek 或刚下发 seek 命令，否则
        # 一律从单调递增的锚点继续推进。
        track = state.get("trackId")
        playing = bool(state.get("active")) and state.get("playbackStatus") == "Playing"
        incoming = max(0.0, float(state.get("position") or 0))
        rate = state.get("rate")
        rate = float(rate) if isinstance(rate, (int, float)) and 0.1 <= float(rate) <= 4 else 1.0
        anchor = self.position_anchor
        duration = state.get("duration")
        same_track = anchor is not None and anchor[0] == track
        expected = self.interpolated_position(now, duration) if same_track else incoming
        drifted = same_track and abs(incoming - expected) > POSITION_SEEK_THRESHOLD
        commanded = same_track and playing and now < self.reanchor_position_until and incoming != anchor[1]
        if not same_track or drifted or not playing or incoming >= expected or commanded:
            self.position_anchor = (track, incoming, now, rate if playing else 0.0)
            self.reanchor_position_until = 0.0
        seeked = drifted and bool(state.get("active")) and bool(previous.get("active"))
        return self.interpolated_position(now, duration), seeked

    def on_method(self, _connection, _sender, _path, interface, method, parameters, invocation):
        if interface == "org.mpris.MediaPlayer2":
            if method == "Raise":
                self.queue({"action": "open"})
        elif method in ("Next", "Previous", "Pause", "PlayPause", "Stop", "Play"):
            self.queue({"action": method.lower()})
        elif method == "Seek":
            self.allow_position_reanchor()
            self.queue({"action": "seek", "value": parameters.unpack()[0]})
        elif method == "SetPosition":
            track_id, position = parameters.unpack()
            with self.lock:
                current = self.metadata(self.state).get("mpris:trackid")
            if current is not None and current.unpack() == track_id:
                self.allow_position_reanchor()
                self.queue({"action": "setposition", "value": position})
        invocation.return_value(None)

    def on_set_property(self, _connection, _sender, _path, interface, name, value):
        if interface != "org.mpris.MediaPlayer2.Player" or name != "Volume":
            if interface != "org.mpris.MediaPlayer2.Player" or name not in ("LoopStatus", "Shuffle", "Rate"):
                return False
        if name == "Volume":
            self.queue({"action": "volume", "value": max(0.0, min(1.0, float(value.unpack())))})
        elif name == "LoopStatus":
            status = str(value.unpack())
            if status not in ("None", "Track", "Playlist"):
                return False
            self.queue({"action": "loop", "value": status})
        elif name == "Shuffle":
            self.queue({"action": "shuffle", "value": bool(value.unpack())})
        else:
            rate = float(value.unpack())
            if rate <= 0 or rate > 4:
                return False
            self.queue({"action": "rate", "value": rate})
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
        lyrics = str(state.get("lyrics") or "").strip()
        if lyrics:
            result["xesam:asText"] = GLib.Variant("s", lyrics)
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
            "Position": GLib.Variant("x", int(self.interpolated_position(time.monotonic(), state.get("duration")) * 1000000)),
            "CanGoNext": GLib.Variant("b", active and bool(state.get("canGoNext"))),
            "CanGoPrevious": GLib.Variant("b", active and bool(state.get("canGoPrevious"))),
            "CanPlay": GLib.Variant("b", active),
            "CanPause": GLib.Variant("b", active),
            "CanSeek": GLib.Variant("b", active and bool(state.get("canSeek"))),
            "CanControl": GLib.Variant("b", active),
            "Volume": GLib.Variant("d", max(0.0, min(1.0, float(state.get("volume") if state.get("volume") is not None else 1.0)))),
            "LoopStatus": GLib.Variant("s", state.get("loopStatus") or "None"),
            "Shuffle": GLib.Variant("b", bool(state.get("shuffle"))),
            "Rate": GLib.Variant("d", max(0.1, min(4.0, float(state.get("rate") or 1.0)))),
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

    def start_download(self, url, filename, directory, declared, meta=None):
        meta = meta if isinstance(meta, dict) else {}
        cover = str(meta.get("cover") or "")
        if cover:
            # 封面由本进程下载，所以要和音频一样经过 SSRF 校验。
            validate_download_url(cover)
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
        tags = {key: str(meta.get(key) or "") for key in ("title", "artist", "album")}
        tags["cover"] = cover
        tags["notify"] = str(meta.get("notify") or "system")
        worker = threading.Thread(target=self.run_download, args=(job, str(url), destination, str(filename or ""), declared, tags), daemon=True)
        worker.start()
        return job

    def run_download(self, job, url, destination, filename, declared, meta=None):
        meta = meta if isinstance(meta, dict) else {}
        # 早于 notify 字段的前端一直是发桌面通知的。
        notify_system = str(meta.get("notify") or "system") == "system"
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
                tag_audio(path, extension, meta.get("title") or "", meta.get("artist") or "", meta.get("album") or "", meta.get("cover") or "")
                if notify_system:
                    GLib.idle_add(self.send_notification, "下载完成", f"{os.path.basename(path)} 已保存到 {os.path.dirname(path)}", "folder-download")
        except (OSError, ValueError, HTTPException) as error:
            if path is not None:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            failure = str(error) or error.__class__.__name__
            with self.lock:
                job["error"] = failure
            if notify_system:
                GLib.idle_add(self.send_notification, "下载失败", failure, "dialog-error")
        finally:
            with self.lock:
                job["active"] = False
                self.last_seen = time.monotonic()

    def check_idle(self):
        self.recognition.expire()
        with self.lock:
            downloading = self.download is not None and self.download.get("active")
            # 前端每 500ms 轮询一次，15s 的阈值意味着 Steam 客户端任何一次卡顿
            # 都会干掉辅助进程并重新启动 python3；这里留出足够的余量。
            expired = time.monotonic() - self.last_seen > 60
        if downloading or self.recognition.active():
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
            self.recognition.cancel()
            self.server.shutdown()
            Gio.bus_unown_name(self.owner)
            self.cover_directory.cleanup()
            # 没有别的东西会删除这个运行目录，所以过去每次插件重载、每次 Steam
            # 启动都会遗留一个。端口文件还在，正是插件判断辅助进程仍存活的依据。
            if os.path.basename(os.path.normpath(self.runtime_dir)).startswith("nemusic-mpris-"):
                shutil.rmtree(self.runtime_dir, ignore_errors=True)


if __name__ == "__main__":
    with open(os.path.join(sys.argv[1], "token"), encoding="ascii") as token_file:
        MprisService(sys.argv[1], token_file.read()).run()
