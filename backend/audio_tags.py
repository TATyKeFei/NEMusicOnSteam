"""MP3/FLAC 标签与封面写入，不依赖媒体控制服务。"""

import os
import shutil
import sys
import tempfile
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
    temporary = None
    try:
        with open(path, "rb") as source:
            header = source.read(10)
            audio_start = 0
            if header.startswith(b"ID3") and len(header) == 10:
                old_size = ((header[6] & 0x7F) << 21 | (header[7] & 0x7F) << 14
                            | (header[8] & 0x7F) << 7 | header[9] & 0x7F)
                candidate = 10 + old_size
                source.seek(0, os.SEEK_END)
                if candidate <= source.tell():
                    audio_start = candidate
            source.seek(audio_start)
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(path) or ".", delete=False) as output:
                temporary = output.name
                os.fchmod(output.fileno(), os.fstat(source.fileno()).st_mode & 0o777)
                output.write(build_id3_tag(title, artist, album, cover))
                shutil.copyfileobj(source, output, length=1024 * 1024)
        os.replace(temporary, path)
        temporary = None
        return True
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


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
    temporary = None
    try:
        with open(path, "rb") as source:
            if source.read(4) != b"fLaC":
                return False
            size = os.fstat(source.fileno()).st_size
            kept = []
            while True:
                header = source.read(4)
                if len(header) != 4:
                    return False
                last = bool(header[0] & 0x80)
                block_type = header[0] & 0x7F
                length = int.from_bytes(header[1:4], "big")
                offset = source.tell()
                if offset + length > size:
                    return False
                if not kept and (block_type != 0 or length != 34):
                    return False
                # 只记保留块的位置；封面、旧评论和音频都不整段载入内存。
                if block_type not in (4, 6):
                    kept.append((block_type, offset, length))
                source.seek(length, os.SEEK_CUR)
                if last:
                    break
            audio_start = source.tell()
            comments = [("TITLE", title), ("ARTIST", artist), ("ALBUM", album)]
            new_blocks = [_flac_vorbis_block(comments)]
            if cover is not None:
                new_blocks.append(_flac_picture_block(cover))
            blocks = kept[:1] + new_blocks + kept[1:]
            with tempfile.NamedTemporaryFile(
                dir=os.path.dirname(path) or ".", delete=False,
            ) as output:
                temporary = output.name
                os.fchmod(output.fileno(), os.fstat(source.fileno()).st_mode & 0o777)
                output.write(b"fLaC")
                for index, block in enumerate(blocks):
                    block_type = block[0]
                    length = block[2] if len(block) == 3 else len(block[1])
                    last = index == len(blocks) - 1
                    output.write(bytes([(0x80 if last else 0) | block_type]))
                    output.write(length.to_bytes(3, "big"))
                    if len(block) == 2:
                        output.write(block[1])
                    else:
                        source.seek(block[1])
                        remaining = length
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise OSError("FLAC 元数据读取中断")
                            output.write(chunk)
                            remaining -= len(chunk)
                source.seek(audio_start)
                shutil.copyfileobj(source, output, length=1024 * 1024)
        os.replace(temporary, path)
        temporary = None
        return True
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


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


