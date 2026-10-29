"""MPD 协议适配：连接现有守护进程，仅管理插件自己的队列条目。"""
import math
import os
import shutil
import socket
import sys
import threading
from urllib.parse import urlsplit

from playback_http import PlaybackHttpService


def quote(value):
    value = str(value)
    if any(character in value for character in "\r\n\x00"):
        raise ValueError("MPD 参数不能包含换行或 NUL")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def number(value, fallback=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (ValueError, TypeError):
        return fallback


class MpdClient:
    def __init__(self, settings):
        self.host = str(settings.get("host") or "127.0.0.1").strip()
        self.port = int(settings.get("port", 6600))
        self.path = os.path.expanduser(str(settings.get("socket") or "").strip())
        self.password = str(settings.get("password") or "")
        if not 1 <= self.port <= 65535:
            raise ValueError("MPD 端口应在 1–65535 之间")
        for value in (self.host, self.path, self.password):
            quote(value)

    def session(self):
        return MpdSession(self)


class MpdSession:
    def __init__(self, client):
        self.client = client

    def __enter__(self):
        client = self.client
        self.connection = None
        self.reader = None
        try:
            if client.path:
                self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.connection.settimeout(3)
                self.connection.connect(client.path)
            else:
                self.connection = socket.create_connection((client.host, client.port), timeout=3)
            self.connection.settimeout(3)
            self.reader = self.connection.makefile("rb")
            if not self.line().startswith("OK MPD "):
                raise RuntimeError("连接目标不是 MPD 服务")
            if client.password:
                self.command("password", client.password)
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_args):
        if self.reader is not None:
            self.reader.close()
        if self.connection is not None:
            self.connection.close()

    def line(self):
        raw = self.reader.readline(65537)
        if not raw:
            raise RuntimeError("MPD 连接已断开")
        if len(raw) > 65536 or not raw.endswith(b"\n"):
            raise RuntimeError("MPD 响应过长")
        return raw.decode("utf-8", errors="replace").rstrip("\r\n")

    def command(self, name, *arguments):
        if not name.isalpha():
            raise ValueError("无效的 MPD 命令")
        request = " ".join([name, *(quote(value) for value in arguments)]) + "\n"
        self.connection.sendall(request.encode("utf-8"))
        result = {}
        for _ in range(10000):
            line = self.line()
            if line == "OK":
                return result
            if line.startswith("ACK "):
                # password 的错误不回显服务端消息，避免实现不同导致密码进入日志。
                if name == "password":
                    raise RuntimeError("MPD 密码认证失败或缺少权限")
                raise RuntimeError("MPD: " + line)
            key, separator, value = line.partition(": ")
            if separator:
                result[key] = value
        raise RuntimeError("MPD 响应条目过多")


class MpdService(PlaybackHttpService):
    def __init__(self, runtime_dir, token):
        self.runtime_dir = runtime_dir
        self.token = token
        self.lock = threading.Lock()
        self.operations = threading.RLock()
        self.client = None
        self.track = {}
        self.song_id = None
        self.original_modes = None
        self.loop_status = "None"
        self.shuffle = False
        self.start_http()

    def configure(self, settings):
        client = MpdClient(settings)
        with self.operations:
            with client.session() as session:
                session.command("status")
            if self.client is not None and vars(self.client) == vars(client):
                return
            self.release()
            self.client = client

    def session(self):
        if self.client is None:
            raise RuntimeError("尚未配置 MPD 连接")
        return self.client.session()

    def release(self):
        if self.client is None:
            return
        try:
            with self.session() as session:
                status = session.command("status")
                owns_player = self.owns_current(session, status)
                if owns_player:
                    session.command("stop")
                    self.restore_modes(session)
                if self.song_id is not None:
                    self.delete_song(session)
        finally:
            self.song_id = None
            self.original_modes = None
            self.track = {}

    def restore_modes(self, session):
        for key, value in (self.original_modes or {}).items():
            session.command(key, value)

    def delete_song(self, session):
        # 条目可能已被外部 MPD 客户端删除，先查询避免 ACK 打断清理。
        if session.command("playlistid", self.song_id):
            session.command("deleteid", self.song_id)

    def owns_current(self, session, status):
        if self.song_id is None:
            return False
        if status.get("songid") == self.song_id:
            return True
        # single 模式自然播完会清掉当前 songid，条目仍在队列中，需继续报告结束。
        return not status.get("songid") and status.get("state") == "stop" and bool(session.command("playlistid", self.song_id))

    def load(self, payload):
        url = str(payload.get("url") or "")
        if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
            raise ValueError("网易云没有返回有效的音频地址")
        quote(url)
        title = str(payload.get("title") or "").strip()
        if not title:
            raise ValueError("缺少歌曲标题")
        with self.operations, self.session() as session:
            status = session.command("status")
            if self.original_modes is None:
                self.original_modes = {key: status[key] for key in ("single", "repeat", "random", "consume") if key in status}
            if self.song_id is not None:
                if self.owns_current(session, status):
                    session.command("stop")
                self.delete_song(session)
                self.song_id = None
            song_id = session.command("addid", url).get("Id")
            if song_id is None or not song_id.isdecimal():
                raise RuntimeError("MPD 未返回歌曲 ID")
            self.song_id = song_id
            self.track = {key: str(payload.get(key) or "") for key in ("title", "artist", "album", "artUrl", "trackId")}
            # 单曲模式阻止 MPD 跳到用户原队列，下一首始终由网易云网页决定。
            if payload.get("loopStatus") in ("None", "Track", "Playlist"):
                self.loop_status = payload["loopStatus"]
            session.command("single", 1)
            session.command("repeat", int(self.loop_status == "Track"))
            session.command("random", 0)
            session.command("consume", 0)
            volume = payload.get("volume")
            if volume is not None and number(status.get("volume"), -1) >= 0:
                session.command("setvol", round(max(0, min(1, number(volume, 1))) * 100))
            # seekid 会直接开始播放，随后 playid 会重置到开头，所以不能再发 playid。
            position = max(0, number(payload.get("position")))
            session.command("seekid", song_id, position)
            if not payload.get("autoplay", True):
                session.command("pause", 1)
            return self.snapshot()

    def command(self, payload):
        action = payload.get("action")
        with self.operations, self.session() as session:
            status = session.command("status")
            if not self.owns_current(session, status):
                return False
            value = payload.get("value")
            if action == "play":
                if status.get("state") == "stop":
                    session.command("playid", self.song_id)
                else:
                    session.command("pause", 0)
            elif action == "pause":
                session.command("pause", 1)
            elif action == "playpause":
                if status.get("state") == "stop":
                    session.command("playid", self.song_id)
                else:
                    session.command("pause", int(status.get("state") == "play"))
            elif action == "stop":
                session.command("stop")
            elif action == "volume":
                if number(status.get("volume"), -1) < 0:
                    return False
                session.command("setvol", round(max(0, min(1, number(value, 1))) * 100))
            elif action in ("seek", "setposition"):
                target = number(value) / 1000000
                if action == "seek":
                    target += number(status.get("elapsed"))
                session.command("seekid", self.song_id, max(0, target))
            elif action == "loop":
                self.loop_status = value if value in ("Track", "Playlist") else "None"
                session.command("repeat", int(value == "Track"))
            elif action == "shuffle":
                self.shuffle = bool(value)
            else:
                # MPD 无倍速接口；不能假报成功或把网页倍速当实际输出倍速。
                return False
            return True

    def snapshot(self):
        with self.operations, self.session() as session:
            status = session.command("status")
            error = status.get("error")
            if error:
                raise RuntimeError("MPD 播放失败：" + error)
            active = self.owns_current(session, status)
            if not active and self.song_id is not None:
                raise RuntimeError("MPD 的当前歌曲已被其他客户端切换；请切歌或重新连接")
            state = status.get("state", "stop")
            duration = max(0, number(status.get("duration")))
            if not duration and active:
                duration = max(0, number(session.command("currentsong").get("Time")))
            volume = number(status.get("volume"), -1)
            return {
                "active": active,
                "playbackStatus": {"play": "Playing", "pause": "Paused"}.get(state, "Stopped"),
                **self.track,
                "duration": duration,
                "position": max(0, number(status.get("elapsed"))),
                "canSeek": active and duration > 0,
                "volume": max(0, min(1, volume / 100)) if volume >= 0 else None,
                "loopStatus": self.loop_status,
                "shuffle": self.shuffle,
                "rate": 1,
            }

    def close(self):
        with self.operations:
            try:
                self.release()
            except (OSError, RuntimeError):
                pass


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: mpd_helper.py RUNTIME_DIR")
    runtime_dir = sys.argv[1]
    try:
        with open(os.path.join(runtime_dir, "token"), encoding="utf-8") as handle:
            service = MpdService(runtime_dir, handle.read().strip())
        service.run()
    except Exception:
        shutil.rmtree(runtime_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    main()
