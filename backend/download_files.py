"""下载文件名、格式和目标地址校验，不依赖 D-Bus。"""

import ipaddress
import json
import os
import socket
import tempfile
from urllib.parse import urlsplit

DEFAULT_DOWNLOAD_DIRECTORY = "~/Music/网易云音乐"
DOWNLOAD_CHUNK = 64 * 1024
DOWNLOAD_TIMEOUT = 30
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
FILENAME_BYTE_LIMIT = 180
DECLARED_AUDIO_TYPES = ("mp3", "flac", "m4a", "wav", "aac", "ape", "ogg")
AUDIO_SUFFIXES = tuple("." + kind for kind in DECLARED_AUDIO_TYPES)
CONTROL_CHARACTERS = frozenset(chr(code) for code in range(32)) | {"\x7f"}
MP3_MAGIC = (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa", b"\xff\xf9")


def recorded_download(directory, key, filename=None):
    """按歌曲 ID/音质记录已有下载；只记录文件名，不保存地址或账号信息。"""
    manifest = os.path.join(directory, ".nemusic-downloads.json")
    try:
        with open(manifest, encoding="utf-8") as handle:
            contents = handle.read(4_000_001)
            records = json.loads(contents) if len(contents) <= 4_000_000 else {}
        if not isinstance(records, dict):
            records = {}
    except (OSError, ValueError):
        records = {}
    if filename is None:
        name = records.get(key)
        if isinstance(name, str) and name == os.path.basename(name) and os.path.isfile(os.path.join(directory, name)):
            return os.path.join(directory, name)
        return None
    records[key] = os.path.basename(filename)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as handle:
            temporary = handle.name
            json.dump(dict(list(records.items())[-10000:]), handle, ensure_ascii=False)
        os.replace(temporary, manifest)
    except OSError:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    return None


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


