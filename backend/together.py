"""网易云「一起听」的签名与请求构造（独立模块，目前没有接进插件运行时）。

**先读这一段再决定要不要用它。** st/webplayer 页面自带官方一起听，redux 里有
``async:listenTogether`` 等一整套模块，页面自己接了聊天房间的实时通道，还带着会员
权限和「该资源是否支持一起听」的校验。插件要控制一起听，直接派发页面自己的 action 就
够了，``frontend/together/`` 现在就是这么做的。所以这个模块**没有**被 helper 加载，
也不在 ``millennium.toml`` 的资源列表里。

保留它的理由：签名本身是逐字节验证过的纯计算，可以用来做只读诊断（比如脚本里查房间
成员、房间号，排查同步问题时和页面显示对账），也可以在没有页面模块的场合退回到官方
接口。接入方式见文末的 ``listen_together_request``。

这一层只做纯计算：把「接口路径 + 参数」变成可以直接发出去的 URL 和表单 body，
真正的网络请求交给内嵌播放器页面里的 fetch 完成。这样 MUSIC_U 这类登录 cookie
始终由浏览器自己带上，辅助进程从头到尾看不到登录态，也不碰网易云的 cookie 罐子。

网易云对外只有两种加密。一起听这两种都用得上：

* ``eapi`` —— 固定密钥的 AES-128-ECB，密钥 ``e82ckenh8dichen8`` 是公开的，没有
  RSA、没有动态密钥注册，也不需要反爬 token。只有 :func:`room_check` 这类探测请求
  能在完全不带 cookie 的情况下验证签名是否正确。
* ``weapi`` —— AES-128-CBC 两层加密加一段 RSA，只有 ``status/get`` 用到。密钥同样
  是写死在客户端里的公开常量。

签名的输入路径是完整的 ``/api/...``，而请求要打到 ``/eapi/`` 下面并且去掉
``/api/`` 前缀，这个不一致是网易云自己的历史包袱，不是这里写错了。
"""

import base64
import binascii
import hashlib
import json
import os
import random
import time
from urllib.parse import quote

EAPI_DOMAIN = "https://interface.music.163.com"
WEB_HOST = "https://music.163.com"
EAPI_KEY = "e82ckenh8dichen8"
EAPI_SALT = "36cd479b6b5"
EAPI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
WEAPI_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0")

WEAPI_KEY = "0CoJUm6Qyw8W8jud"
WEAPI_IV = "0102030405060708"
# 网易云客户端里写死的 1024 位 RSA 公钥，从 SPKI 里取出模数即可：只用公钥做一次模幂，
# 私钥那半边在这里完全用不到。
WEAPI_MODULUS = int(
    "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b72"
    "5152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e03"
    "12ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b"
    "424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a"
    "22b8e7", 16)
WEAPI_EXPONENT = 0x10001
BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

# 请求会从 music.163.com 的页面里发出去，所以这里报的是 PC 网页版的身份。deviceId
# 只在一次插件会话内保持稳定：网易云用它做风控画像，跨启动复用同一份更保守，但辅助
# 进程每次都会重建运行目录，要持久化得挪到插件设置里，先不在这上面花代价。
_DEVICE_ID = binascii.hexlify(os.urandom(8)).decode("ascii")


# --------------------------------------------------------------------------- AES

def _build_sbox():
    """按 AES 的定义推导 S 盒，而不是抄一张 256 项的常量表。"""
    sbox = [0] * 256
    p = q = 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        value = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
        sbox[p] = (value ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


SBOX = _build_sbox()
RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _xtime(value):
    value <<= 1
    return (value ^ 0x1B) & 0xFF if value & 0x100 else value


def _expand_key(key):
    if len(key) not in (16, 24, 32):
        raise ValueError("AES 密钥长度必须是 16/24/32 字节")
    nk = len(key) // 4
    rounds = nk + 6
    words = [list(key[i * 4:i * 4 + 4]) for i in range(nk)]
    for index in range(nk, 4 * (rounds + 1)):
        temp = list(words[index - 1])
        if index % nk == 0:
            temp = temp[1:] + temp[:1]
            temp = [SBOX[byte] for byte in temp]
            temp[0] ^= RCON[index // nk - 1]
        elif nk > 6 and index % nk == 4:
            temp = [SBOX[byte] for byte in temp]
        previous = words[index - nk]
        words.append([previous[i] ^ temp[i] for i in range(4)])
    return words, rounds


def _encrypt_block(block, words, rounds):
    # 状态按列主序摊平成 16 字节：下标 col * 4 + row，也就是 AES 读入明文的顺序。
    state = list(block)
    for rnd in range(rounds + 1):
        if rnd:
            state = [SBOX[byte] for byte in state]
            # ShiftRows：第 row 行的每一列各左移 row 格。
            shifted = [0] * 16
            for col in range(4):
                for row in range(4):
                    shifted[col * 4 + row] = state[((col + row) % 4) * 4 + row]
            state = shifted
            if rnd != rounds:
                mixed = []
                for col in range(4):
                    a0, a1, a2, a3 = state[col * 4:col * 4 + 4]
                    total = a0 ^ a1 ^ a2 ^ a3
                    mixed.extend([
                        a0 ^ total ^ _xtime(a0 ^ a1),
                        a1 ^ total ^ _xtime(a1 ^ a2),
                        a2 ^ total ^ _xtime(a2 ^ a3),
                        a3 ^ total ^ _xtime(a3 ^ a0),
                    ])
                state = mixed
        round_key = words[rnd * 4:rnd * 4 + 4]
        state = [state[index] ^ round_key[index // 4][index % 4] for index in range(16)]
    return bytes(state)


def _pad(data):
    fill = 16 - len(data) % 16
    return data + bytes([fill]) * fill


def aes_ecb_encrypt(data, key):
    """AES-128/192/256-ECB + PKCS#7，输出小写 hex（eapi 用）。"""
    words, rounds = _expand_key(key.encode("utf-8") if isinstance(key, str) else key)
    padded = _pad(data)
    out = bytearray()
    for offset in range(0, len(padded), 16):
        out += _encrypt_block(padded[offset:offset + 16], words, rounds)
    return out.hex()


def aes_cbc_encrypt(data, key, iv):
    """AES-CBC + PKCS#7，输出 base64（weapi 用）。"""
    words, rounds = _expand_key(key.encode("utf-8") if isinstance(key, str) else key)
    padded = _pad(data)
    previous = iv.encode("utf-8") if isinstance(iv, str) else iv
    out = bytearray()
    for offset in range(0, len(padded), 16):
        block = bytes(a ^ b for a, b in zip(padded[offset:offset + 16], previous))
        previous = _encrypt_block(block, words, rounds)
        out += previous
    return base64.b64encode(bytes(out)).decode("ascii")


# ------------------------------------------------------------------------- eapi

def _dump(payload):
    # JSON.stringify 的等价物：紧凑分隔符、不转义非 ASCII、保持插入顺序。
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def eapi_header(csrf=""):
    """组装签名里要带的 header。MUSIC_U 之类的字段不写：认证靠浏览器自带的 cookie。"""
    return {
        "osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
        "deviceId": _DEVICE_ID,
        "os": "pc",
        "appver": "3.1.17.204416",
        "versioncode": "140",
        "mobilename": "",
        "buildver": str(int(time.time()))[:10],
        "resolution": "1920x1080",
        "__csrf": csrf,
        "channel": "netease",
        "requestId": "%d_%04d" % (int(time.time() * 1000), random.randrange(10000)),
    }


def eapi_params(path, payload):
    """算出 eapi 的 params 表单值（大写 hex）。

    ``path`` 是带 ``/api/`` 前缀的完整路径，签名和实际请求 URL 用的是同一个字符串。
    """
    text = _dump(payload)
    digest = hashlib.md5(("nobody" + path + "use" + text + "md5forencrypt").encode("utf-8")).hexdigest()
    signed = "%s-%s-%s-%s-%s" % (path, EAPI_SALT, text, EAPI_SALT, digest)
    return aes_ecb_encrypt(signed.encode("utf-8"), EAPI_KEY.encode("utf-8")).upper()


def _endpoint_url(host, prefix, path):
    """签名用完整的 /api/...，请求打到 /eapi/ 或 /weapi/ 下面并去掉 /api/ 前缀。"""
    if path.startswith("/api/"):
        return host + "/" + prefix + "/" + path[len("/api/"):]
    return host + "/" + prefix + "/" + path


def eapi_request(path, data=None, csrf="", header=None):
    payload = dict(data or {})
    payload["e_r"] = False
    payload["header"] = header if header is not None else eapi_header(csrf)
    return {
        "method": "POST",
        "url": _endpoint_url(EAPI_DOMAIN, "eapi", path),
        "body": "params=" + quote(eapi_params(path, payload), safe=""),
        "contentType": "application/x-www-form-urlencoded",
        "referer": WEB_HOST + "/",
    }


# ------------------------------------------------------------------------ weapi

def _secret_key():
    return "".join(BASE62[random.randrange(62)] for _ in range(16))


def _rsa_encrypt(secret):
    """只用公钥做一次模幂。网易云客户端发的是倒序后的密钥，所以这里也要倒过来编码。"""
    size = (WEAPI_MODULUS.bit_length() + 7) // 8
    value = pow(int.from_bytes(secret.encode("utf-8")[::-1], "big"), WEAPI_EXPONENT, WEAPI_MODULUS)
    return binascii.hexlify(value.to_bytes(size, "big")).decode("ascii")


def weapi_request(path, data=None, csrf=""):
    payload = dict(data or {})
    payload["csrf_token"] = csrf
    iv = WEAPI_IV.encode("utf-8")
    inner = aes_cbc_encrypt(_dump(payload).encode("utf-8"), WEAPI_KEY.encode("utf-8"), iv)
    secret = _secret_key()
    outer = aes_cbc_encrypt(inner.encode("utf-8"), secret.encode("utf-8"), iv)
    return {
        "method": "POST",
        "url": _endpoint_url(WEB_HOST, "weapi", path),
        "body": "params=" + quote(outer, safe="") + "&encSecKey=" + quote(_rsa_encrypt(secret), safe=""),
        "contentType": "application/x-www-form-urlencoded",
        "referer": WEB_HOST + "/",
    }


# ------------------------------------------------------------------- 一起听接口

# 网易云客户端把 status/get 走 weapi，其余一起听接口走 eapi，这里照抄同样的划分。
COMMAND_TYPES = ("GOTO", "NEXT", "PREV", "PROGRESS", "PLAY", "PAUSE")

OPERATIONS = {
    "create": ("/api/listen/together/room/create", "eapi"),
    "check": ("/api/listen/together/room/check", "eapi"),
    "join": ("/api/listen/together/play/invitation/accept", "eapi"),
    "snapshot": ("/api/listen/together/sync/playlist/get", "eapi"),
    "reportPlaylist": ("/api/listen/together/sync/list/command/report", "eapi"),
    "reportCommand": ("/api/listen/together/play/command/report", "eapi"),
    "heartbeat": ("/api/listen/together/heartbeat", "eapi"),
    "end": ("/api/listen/together/end/v2", "eapi"),
    "status": ("/api/listen/together/status/get", "weapi"),
}


def _room_id(value):
    room_id = str(value or "").strip()
    if not room_id:
        raise ValueError("缺少房间号")
    # 网易云的房间号是 ASCII 字母数字加下划线连字符。注意 str.isalnum() 对中文也返回
    # 真，所以必须显式挡掉非 ASCII，否则什么 Unicode 都能被当成房间号塞进请求。
    if len(room_id) > 128 or not all(
            (char.isascii() and char.isalnum()) or char in "_-" for char in room_id):
        raise ValueError("房间号格式无效")
    return room_id


def _int_field(value, name, minimum=0):
    """所有数值字段都走这里。int(None) 抛的是 TypeError，混在参数校验里会变成 500。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(name + "无效") from None
    if number < minimum:
        raise ValueError(name + "无效")
    return number


def _song_ids(values):
    return [_int_field(value, "歌曲 ID", 1) for value in values or []]


def listen_together_request(operation, csrf="", **kwargs):
    """把一次一起听调用变成可以直接发出去的请求描述。"""
    if operation not in OPERATIONS:
        raise ValueError("未知一起听操作")
    path, scheme = OPERATIONS[operation]
    data = {}
    if operation == "create":
        data = {"refer": "songplay_more"}
    elif operation == "check":
        data = {"roomId": _room_id(kwargs.get("roomId"))}
    elif operation == "join":
        data = {"refer": "inbox_invite", "roomId": _room_id(kwargs.get("roomId")),
                "inviterId": str(_int_field(kwargs.get("inviterId") or 0, "邀请者 ID"))}
    elif operation in ("snapshot", "end"):
        data = {"roomId": _room_id(kwargs.get("roomId"))}
    elif operation == "reportPlaylist":
        version = _int_field(kwargs.get("version"), "播放列表版本号", 1)
        account = _int_field(kwargs.get("accountId"), "用户 ID")
        song_ids = _song_ids(kwargs.get("songIds"))
        playlist = {"commandType": "REPLACE",
                    "version": [{"userId": account, "version": version}],
                    "anchorSongId": "", "anchorPosition": -1,
                    "randomList": song_ids, "displayList": song_ids}
        data = {"roomId": _room_id(kwargs.get("roomId")), "playlistParam": _dump(playlist)}
    elif operation == "reportCommand":
        command_type = str(kwargs.get("type") or "").upper()
        if command_type not in COMMAND_TYPES:
            raise ValueError("未知播放指令")
        command = {"commandType": command_type,
                   "progress": _int_field(kwargs.get("progressMs") or 0, "播放进度"),
                   "playStatus": "PLAY" if kwargs.get("playing") else "PAUSE",
                   "formerSongId": str(_int_field(kwargs.get("formerSongId") or 0, "上一首 ID")),
                   "targetSongId": str(_int_field(kwargs.get("targetSongId") or 0, "目标歌曲 ID")),
                   "clientSeq": _int_field(kwargs.get("sequence") or 0, "指令序号")}
        data = {"roomId": _room_id(kwargs.get("roomId")), "commandInfo": _dump(command)}
    elif operation == "heartbeat":
        data = {"roomId": _room_id(kwargs.get("roomId")),
                "songId": str(_int_field(kwargs.get("songId") or 0, "歌曲 ID")),
                "playStatus": "PLAY" if kwargs.get("playing") else "PAUSE",
                "progress": _int_field(kwargs.get("progressMs") or 0, "播放进度")}
    if scheme == "weapi":
        return weapi_request(path, data, csrf)
    return eapi_request(path, data, csrf)


# ------------------------------------------------------------------- 响应解析

ACCEPTED_CODES = (200, 201, 302, 400, 502, 800, 801, 802, 803)


def check_response(body):
    """把网易云的响应翻成 ``(code, data)``，非成功码直接抛错。"""
    if not isinstance(body, dict):
        raise ValueError("一起听接口返回了无法解析的内容")
    code = body.get("code")
    if code is not None and int(code) not in ACCEPTED_CODES:
        raise ValueError(str(body.get("message") or body.get("msg") or ("一起听接口错误 " + str(code))))
    return int(code or 200), body.get("data")


def _text(value):
    return str(value).strip() if value not in (None, "") else ""


def parse_room(data, fallback_id=""):
    """房间信息。网易云有时把字段直接摊在 data 上，有时裹一层 roomInfo，两种都要认。"""
    if not isinstance(data, dict):
        return None
    room = data.get("roomInfo") if isinstance(data.get("roomInfo"), dict) else data
    room_id = _text(room.get("roomId")) or _text(fallback_id)
    if not room_id:
        return None
    return {"roomId": room_id,
            "ownerId": _text(room.get("ownerId") or room.get("userId")),
            "status": _text(room.get("status")),
            "joinedCount": int(room.get("joinedCount") or 0)}


def parse_status(data):
    if not isinstance(data, dict):
        return {"inRoom": False, "room": None}
    return {"inRoom": bool(data.get("inRoom")), "room": parse_room(data)}


def parse_snapshot(data):
    """房间快照：当前歌单 + 最后一条播放指令。同步的全部依据就是这两个字段。"""
    if not isinstance(data, dict):
        return {"songIds": [], "command": None}
    playlist = data.get("playlist") if isinstance(data.get("playlist"), dict) else {}
    mode = _text(playlist.get("playMode")).upper()
    chosen = playlist.get("randomList") if "RANDOM" in mode or "SHUFFLE" in mode else playlist.get("displayList")
    if not isinstance(chosen, dict):
        chosen = playlist.get("displayList")
    if not isinstance(chosen, dict):
        chosen = {}
    raw = data.get("playCommand") or data.get("commandInfo")
    command = None
    if isinstance(raw, dict) and _text(raw.get("commandType")):
        kind = _text(raw.get("commandType")).upper()
        status = _text(raw.get("playStatus")).upper()
        target = _text(raw.get("targetSongId"))
        command = {
            "accountId": _text(raw.get("userId")),
            "type": kind,
            "formerSongId": _text(raw.get("formerSongId")),
            "targetSongId": target,
            "progressMs": max(0, int(raw.get("progress") or 0)),
            "playing": kind in ("PLAY", "GOTO", "NEXT", "PREV") or status in ("PLAY", "PLAYING"),
            "sequence": int(raw.get("serverSeq") or 0),
        }
    return {"songIds": [int(song) for song in (chosen.get("result") or []) if str(song).isdigit()],
            "command": command}


if __name__ == "__main__":
    # 无需登录态的探针：房间号是现编的，所以只要签名过了就一定是业务错误（房间不存在），
    # 签名错了则会返回 -460 之类的参数错误。两者能分得开，就说明 eapi 这段算对了。
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else "check"
    kwargs = {}
    if target in ("check", "snapshot", "end"):
        kwargs["roomId"] = sys.argv[2] if len(sys.argv) > 2 else "0000000000"
    print(json.dumps(listen_together_request(target, **kwargs), ensure_ascii=False, indent=2))
