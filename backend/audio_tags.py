"""MP3/FLAC 标签与封面写入，不依赖媒体控制服务。"""

import sys
from http.client import HTTPException
from urllib.request import Request, urlopen
from download_files import validate_download_url

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


