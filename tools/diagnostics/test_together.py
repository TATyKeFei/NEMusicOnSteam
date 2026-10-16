import base64
import hashlib
import json
import unittest
from unittest.mock import patch
from urllib.parse import unquote_plus

import together

FIXED_HEADER = {"osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
                "deviceId": "0123456789abcdef", "os": "pc", "appver": "3.1.17.204416",
                "versioncode": "140", "mobilename": "", "buildver": "1759000000",
                "resolution": "1920x1080", "__csrf": "", "channel": "netease",
                "requestId": "1759000000123_0042"}
ROOM = "/api/listen/together/room/create"

# 每个接口最少要带的参数，用来遍历所有操作时不用逐个手写。
MINIMAL_ARGS = {
    "create": {},
    "check": {"roomId": "1234567890"},
    "join": {"roomId": "1234567890"},
    "snapshot": {"roomId": "1234567890"},
    "end": {"roomId": "1234567890"},
    "heartbeat": {"roomId": "1234567890", "songId": 1900172235, "playing": True, "progressMs": 0},
    "reportPlaylist": {"roomId": "1234567890", "accountId": 10001, "version": 1, "songIds": [1900172235]},
    "reportCommand": {"roomId": "1234567890", "type": "GOTO", "formerSongId": 0,
                      "targetSongId": 1900172235, "progressMs": 0, "playing": True, "sequence": 1},
    "status": {},
}


def signed_plaintext(path, payload):
    """测试侧独立复算一遍签名原文，这样格式被改动时测试会立刻炸掉。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.md5(("nobody" + path + "use" + text + "md5forencrypt").encode("utf-8")).hexdigest()
    return "%s-36cd479b6b5-%s-36cd479b6b5-%s" % (path, text, digest)


def form_fields(body):
    return dict(part.split("=", 1) for part in body.split("&"))


def capture(operation, **kwargs):
    """跑一次请求构造，同时把签名里那份明文取回来。"""
    seen = {}
    original = together.eapi_params

    def spy(path, payload):
        seen["path"] = path
        seen["payload"] = payload
        return original(path, payload)

    with patch.object(together, "eapi_params", side_effect=spy), \
            patch.object(together, "eapi_header", return_value=FIXED_HEADER):
        together.listen_together_request(operation, **kwargs)
    return seen


class AesTests(unittest.TestCase):
    """S 盒、分组变换和填充都对着 FIPS-197 与 SP 800-38A 的公开测试向量核。"""

    def test_sbox_matches_the_published_table(self):
        self.assertEqual(bytes(together.SBOX[:16]).hex(), "637c777bf26b6fc53001672bfed7ab76")
        self.assertEqual(bytes(together.SBOX[16:32]).hex(), "ca82c97dfa5947f0add4a2af9ca472c0")
        self.assertEqual(together.SBOX[0x53], 0xED)
        self.assertEqual(together.SBOX[0xFF], 0x16)

    def test_sbox_is_a_permutation(self):
        self.assertEqual(sorted(together.SBOX), list(range(256)))

    def test_ecb_matches_the_fips197_block_vectors(self):
        block = bytes.fromhex("00112233445566778899aabbccddeeff")
        for key, expected in (
                ("000102030405060708090a0b0c0d0e0f", "69c4e0d86a7b0430d8cdb78070b4c55a"),
                ("000102030405060708090a0b0c0d0e0f1011121314151617", "dda97ca4864cdfe06eaf70a0ec0d7191"),
                ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
                 "8ea2b7ca516745bfeafc49904b496089")):
            with self.subTest(bits=len(key) * 4):
                # 补足到 32 字节再加密，第一个分组就是向量里的密文。
                out = together.aes_ecb_encrypt(block * 2, bytes.fromhex(key))
                self.assertEqual(out[:32], expected)

    def test_cbc_matches_sp800_38a_f_2_1(self):
        out = together.aes_cbc_encrypt(
            bytes.fromhex("6bc1bee22e409f96e93d7e117393172a" * 2),
            bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c"),
            bytes.fromhex("000102030405060708090a0b0c0d0e0f"))
        self.assertEqual(base64.b64decode(out).hex()[:32], "7649abac8119b246cee98e9b12e9197d")

    def test_padding_always_completes_the_block(self):
        for length in range(1, 33):
            with self.subTest(length=length):
                padded = together._pad(b"\x00" * length)
                self.assertEqual(len(padded) % 16, 0)
                self.assertTrue(1 <= len(padded) - length <= 16)
                self.assertEqual(set(padded[length:]), {len(padded) - length})

    def test_keys_of_the_wrong_length_are_rejected(self):
        for length in (0, 8, 15, 17, 20, 33):
            with self.subTest(length=length):
                with self.assertRaises(ValueError):
                    together.aes_ecb_encrypt(b"data", b"\x00" * length)


class EapiTests(unittest.TestCase):
    def test_envelope_is_md5_then_salt_then_ecb(self):
        payload = {"refer": "songplay_more", "e_r": False, "header": FIXED_HEADER}
        want = together.aes_ecb_encrypt(
            signed_plaintext(ROOM, payload).encode("utf-8"), together.EAPI_KEY.encode("utf-8")).upper()
        self.assertEqual(together.eapi_params(ROOM, payload), want)

    def test_params_are_uppercase_hex(self):
        params = together.eapi_params(ROOM, {"refer": "songplay_more", "e_r": False, "header": FIXED_HEADER})
        self.assertEqual(params, params.upper())
        int(params, 16)
        self.assertEqual(len(params) % 32, 0)

    def test_signature_uses_the_api_path_while_the_url_drops_it(self):
        # 签名里的路径必须带着 /api/，而请求要打到 /eapi/ 下面，两边不一样是网易云自己的规矩。
        request = together.eapi_request(ROOM, {"refer": "songplay_more"}, header=FIXED_HEADER)
        self.assertEqual(request["url"], "https://interface.music.163.com/eapi/listen/together/room/create")
        self.assertEqual(signed_plaintext(ROOM, {"refer": "songplay_more", "e_r": False,
                                                 "header": FIXED_HEADER}).split("-36cd479b6b5-")[0], ROOM)

    def test_body_is_urlencoded_and_posted_as_a_form(self):
        request = together.eapi_request(ROOM, {"refer": "songplay_more"}, header=FIXED_HEADER)
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["contentType"], "application/x-www-form-urlencoded")
        fields = form_fields(request["body"])
        self.assertEqual(set(fields), {"params"})
        self.assertEqual(fields["params"], together.eapi_params(
            ROOM, {"refer": "songplay_more", "e_r": False, "header": FIXED_HEADER}))

    def test_e_r_false_keeps_the_response_in_plain_json(self):
        seen = capture("create")
        self.assertIs(seen["payload"]["e_r"], False)

    def test_header_carries_a_full_client_identity(self):
        header = together.eapi_header()
        for field in ("osver", "deviceId", "os", "appver", "versioncode", "mobilename",
                      "buildver", "resolution", "__csrf", "channel", "requestId"):
            self.assertIn(field, header)
        self.assertEqual(header["os"], "pc")
        self.assertEqual(header["versioncode"], "140")
        self.assertRegex(header["requestId"], r"^\d+_\d{4}$")

    def test_device_id_is_stable_within_a_session(self):
        self.assertEqual(together.eapi_header()["deviceId"], together.eapi_header()["deviceId"])

    def test_payload_is_serialized_like_json_stringify(self):
        # 控制字符和引号该转义还是要转义（JSON.stringify 也一样），但非 ASCII 必须原样保留：
        # 一旦变成 \uXXXX，服务端算出来的 md5 就和我们的对不上。
        text = together._dump({"note": '引号" 反斜杠\\ 换行\n 制表\t 颜文字'})
        self.assertIn("颜文字", text)
        self.assertNotIn("\\u", text)
        self.assertEqual(text, '{"note":"引号\\" 反斜杠\\\\ 换行\\n 制表\\t 颜文字"}')
        self.assertEqual(text, json.dumps(json.loads(text), ensure_ascii=False, separators=(",", ":")))

    def test_stringification_matches_json_stringify_byte_for_byte(self):
        cases = ["", "songplay_more", '引号"x"', "a\\b", "line\nbreak", "emoji 🎵", "中文房间", "a,b"]
        for value in cases:
            with self.subTest(value=value):
                text = together._dump({"v": value})
                self.assertEqual(json.loads(text), {"v": value})
                self.assertNotIn(", ", text)
                self.assertNotIn('": ', text)
                self.assertNotIn("\\u", text)


class WeapiTests(unittest.TestCase):
    STATUS = "/api/listen/together/status/get"

    def test_body_carries_params_and_a_full_width_rsa_block(self):
        request = together.weapi_request(self.STATUS, {})
        self.assertEqual(request["url"], "https://music.163.com/weapi/listen/together/status/get")
        fields = form_fields(request["body"])
        self.assertEqual(set(fields), {"params", "encSecKey"})
        # 1024 位模数就是 128 字节；少一个字节服务端会当签名不存在，直接回空 body。
        self.assertEqual(len(bytes.fromhex(fields["encSecKey"])), 128)

    def test_enc_sec_key_reverses_the_secret_exactly_once(self):
        # 这里曾经多反转了一次，密钥转回原样，服务端静默返回空 body，很难查。
        with patch.object(together, "_secret_key", return_value="abcdefghijklmnop"):
            request = together.weapi_request(self.STATUS, {})
        block = int.from_bytes(bytes.fromhex(form_fields(request["body"])["encSecKey"]), "big")
        expected = pow(int.from_bytes(b"abcdefghijklmnop"[::-1], "big"),
                       together.WEAPI_EXPONENT, together.WEAPI_MODULUS)
        self.assertEqual(block, expected)

    def test_params_are_two_layers_of_cbc_with_the_secret_on_the_outside(self):
        # 两层顺序错了服务端不会报错，只会静默返回空 body，所以把「哪一层用哪个密钥、
        # 哪一层吃谁的输出」钉死在这里。密钥本身的对错由 AES 向量测试和实测探针保证。
        with patch.object(together, "_secret_key", return_value="abcdefghijklmnop"):
            request = together.weapi_request(self.STATUS, {})
        text = json.dumps({"csrf_token": ""}, separators=(",", ":"))
        inner = together.aes_cbc_encrypt(text.encode("utf-8"),
                                        together.WEAPI_KEY.encode("utf-8"),
                                        together.WEAPI_IV.encode("utf-8"))
        expected = together.aes_cbc_encrypt(inner.encode("utf-8"), b"abcdefghijklmnop",
                                            together.WEAPI_IV.encode("utf-8"))
        self.assertEqual(base64.b64decode(unquote_plus(form_fields(request["body"])["params"])).hex(),
                         base64.b64decode(expected).hex())
        # 内层：16 字节明文补到 32 字节后加密，得到 44 个字符的 base64；
        # 外层再吃掉这 44 个字符，补到 48 字节。
        self.assertEqual(len(base64.b64decode(inner)), 32)
        self.assertEqual(len(inner), 44)
        self.assertEqual(len(base64.b64decode(expected)), 48)

    def test_secret_is_sixteen_base62_characters(self):
        for _ in range(20):
            secret = together._secret_key()
            self.assertEqual(len(secret), 16)
            self.assertTrue(all(char in together.BASE62 for char in secret))

    def test_repeated_calls_differ_because_the_secret_is_random(self):
        self.assertNotEqual(together.weapi_request(self.STATUS, {})["body"],
                            together.weapi_request(self.STATUS, {})["body"])


class OperationTests(unittest.TestCase):
    def test_create_uses_the_songplay_referer(self):
        seen = capture("create")
        self.assertEqual(seen["path"], "/api/listen/together/room/create")
        self.assertEqual(seen["payload"]["refer"], "songplay_more")

    def test_room_operations_carry_the_room_id(self):
        for operation, path in (("check", "/api/listen/together/room/check"),
                                ("snapshot", "/api/listen/together/sync/playlist/get"),
                                ("end", "/api/listen/together/end/v2")):
            with self.subTest(operation=operation):
                seen = capture(operation, roomId="1234567890")
                self.assertEqual(seen["path"], path)
                self.assertEqual(seen["payload"], {"roomId": "1234567890", "e_r": False,
                                                   "header": FIXED_HEADER})

    def test_join_carries_the_refer_and_inviter(self):
        seen = capture("join", roomId="1234567890")
        self.assertEqual(seen["path"], "/api/listen/together/play/invitation/accept")
        self.assertEqual(seen["payload"]["refer"], "inbox_invite")
        self.assertEqual(seen["payload"]["inviterId"], "0")
        self.assertEqual(capture("join", roomId="1", inviterId="555")["payload"]["inviterId"], "555")

    def test_report_command_builds_the_official_envelope(self):
        seen = capture("reportCommand", roomId="1234567890", type="goto", formerSongId=0,
                       targetSongId=1900172235, progressMs=4321, playing=True, sequence=1759000000123)
        self.assertEqual(seen["path"], "/api/listen/together/play/command/report")
        self.assertEqual(json.loads(seen["payload"]["commandInfo"]),
                         {"commandType": "GOTO", "progress": 4321, "playStatus": "PLAY",
                          "formerSongId": "0", "targetSongId": "1900172235",
                          "clientSeq": 1759000000123})

    def test_report_command_normalises_the_type(self):
        seen = capture("reportCommand", roomId="1", type="progress", formerSongId=1, targetSongId=1,
                       progressMs=0, playing=False, sequence=1)
        info = json.loads(seen["payload"]["commandInfo"])
        self.assertEqual(info["commandType"], "PROGRESS")
        self.assertEqual(info["playStatus"], "PAUSE")

    def test_negative_progress_is_rejected_rather_than_clamped(self):
        # 悄悄改成 0 会把调用方的 bug 藏起来，进度倒退这种事宁可当场报错。
        with self.assertRaisesRegex(ValueError, "播放进度"):
            together.listen_together_request("reportCommand", roomId="1", type="PROGRESS",
                                              formerSongId=1, targetSongId=1, progressMs=-50,
                                              playing=False, sequence=1)

    def test_report_playlist_sends_one_version_entry_per_user(self):
        seen = capture("reportPlaylist", roomId="1234567890", accountId=10001, version=3,
                       songIds=[1900172235, 1900172236])
        self.assertEqual(seen["path"], "/api/listen/together/sync/list/command/report")
        playlist = json.loads(seen["payload"]["playlistParam"])
        self.assertEqual(playlist["commandType"], "REPLACE")
        self.assertEqual(playlist["version"], [{"userId": 10001, "version": 3}])
        self.assertEqual(playlist["anchorSongId"], "")
        self.assertEqual(playlist["anchorPosition"], -1)
        self.assertEqual(playlist["randomList"], [1900172235, 1900172236])
        self.assertEqual(playlist["displayList"], playlist["randomList"])

    def test_heartbeat_reports_song_and_position(self):
        seen = capture("heartbeat", roomId="1234567890", songId=1900172235, playing=True, progressMs=88)
        self.assertEqual(seen["path"], "/api/listen/together/heartbeat")
        self.assertEqual(seen["payload"], {"roomId": "1234567890", "songId": "1900172235",
                                           "playStatus": "PLAY", "progress": 88, "e_r": False,
                                           "header": FIXED_HEADER})

    def test_status_is_the_only_weapi_operation(self):
        self.assertTrue(together.listen_together_request("status")["url"].startswith(
            "https://music.163.com/weapi/"))
        for operation in together.OPERATIONS:
            if operation == "status":
                continue
            with self.subTest(operation=operation):
                request = together.listen_together_request(operation, **MINIMAL_ARGS[operation])
                self.assertTrue(request["url"].startswith("https://interface.music.163.com/eapi/"),
                                request["url"])

    def test_every_operation_is_reachable(self):
        self.assertEqual(set(together.OPERATIONS), set(MINIMAL_ARGS))
        for operation, kwargs in MINIMAL_ARGS.items():
            with self.subTest(operation=operation):
                self.assertEqual(together.listen_together_request(operation, **kwargs)["method"], "POST")

    def test_unknown_operation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "未知一起听操作"):
            together.listen_together_request("dropTables")

    def test_room_ids_are_validated(self):
        for room_id in ("", "   ", "abc/../../etc", "房间", "a" * 129, "rm -rf x"):
            with self.subTest(room_id=room_id):
                with self.assertRaises(ValueError):
                    together.listen_together_request("check", roomId=room_id)
        self.assertTrue(together.listen_together_request("check", roomId=" abc_-123 ")["body"])

    def test_song_ids_must_be_positive_integers(self):
        for song_ids in ([0], [-1], ["abc"], [None]):
            with self.subTest(song_ids=song_ids):
                with self.assertRaises(ValueError):
                    together.listen_together_request("reportPlaylist", roomId="1", accountId=1,
                                                      version=1, songIds=song_ids)

    def test_report_playlist_requires_a_version(self):
        with self.assertRaisesRegex(ValueError, "播放列表版本号"):
            together.listen_together_request("reportPlaylist", roomId="1", accountId=1,
                                              version=0, songIds=[1])

    def test_numeric_fields_reject_junk_with_value_error(self):
        # int(None) 抛的是 TypeError，漏出去会变成 500 而不是可读的参数错误。
        cases = [
            ("reportPlaylist", {"version": 1, "accountId": "abc", "songIds": [1]}),
            ("reportPlaylist", {"version": 1, "accountId": 1, "songIds": ["1.5"]}),
            ("reportCommand", {"type": "GOTO", "formerSongId": "x", "targetSongId": 1,
                               "progressMs": 0, "playing": True, "sequence": 1}),
            ("reportCommand", {"type": "GOTO", "formerSongId": 0, "targetSongId": 1,
                               "progressMs": 0, "playing": True, "sequence": "later"}),
            ("join", {"inviterId": "not-a-number"}),
        ]
        for operation, kwargs in cases:
            with self.subTest(operation=operation, kwargs=sorted(kwargs.items(), key=str)):
                with self.assertRaises(ValueError):
                    together.listen_together_request(operation, roomId="1", **kwargs)

    def test_missing_progress_is_reported_as_zero(self):
        # 空值按「没有进度」处理，和网易云客户端的 Number(x || 0) 一个意思，不算错误。
        seen = capture("heartbeat", roomId="1", songId=None, playing=False, progressMs=None)
        self.assertEqual(seen["payload"]["songId"], "0")
        self.assertEqual(seen["payload"]["progress"], 0)
        self.assertEqual(seen["payload"]["playStatus"], "PAUSE")

    def test_unknown_command_type_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "未知播放指令"):
            together.listen_together_request("reportCommand", roomId="1", type="SELF_DESTRUCT",
                                              formerSongId=1, targetSongId=1, progressMs=0,
                                              playing=True, sequence=1)


class ResponseTests(unittest.TestCase):
    def test_accepted_codes_pass_through(self):
        for code in together.ACCEPTED_CODES:
            self.assertEqual(together.check_response({"code": code, "data": {"ok": 1}}), (code, {"ok": 1}))

    def test_other_codes_raise_with_the_server_message(self):
        # 400 是网易云的成功码之一（缓存命中），所以这里要挑一个真的被拒绝的。
        self.assertIn(400, together.ACCEPTED_CODES)
        with self.assertRaisesRegex(ValueError, "未登录"):
            together.check_response({"code": 301, "message": "未登录"})
        with self.assertRaisesRegex(ValueError, "参数错误"):
            together.check_response({"code": -460, "message": "参数错误"})
        with self.assertRaisesRegex(ValueError, "一起听接口错误 500"):
            together.check_response({"code": 500})
        with self.assertRaises(ValueError):
            together.check_response("not a dict")

    def test_missing_code_defaults_to_success(self):
        self.assertEqual(together.check_response({"data": {"roomId": "1"}}), (200, {"roomId": "1"}))

    def test_room_is_read_from_either_shape(self):
        payload = {"roomId": "123", "ownerId": "9", "status": "PLAYING", "joinedCount": 3}
        expected = {"roomId": "123", "ownerId": "9", "status": "PLAYING", "joinedCount": 3}
        self.assertEqual(together.parse_room(payload), expected)
        self.assertEqual(together.parse_room({"roomInfo": payload}), expected)

    def test_room_falls_back_to_the_requested_id(self):
        self.assertEqual(together.parse_room({}, "999")["roomId"], "999")
        self.assertIsNone(together.parse_room({}))
        self.assertIsNone(together.parse_room(None))

    def test_status_reports_membership(self):
        self.assertTrue(together.parse_status({"inRoom": True, "roomInfo": {"roomId": "7"}})["inRoom"])
        self.assertEqual(together.parse_status({}), {"inRoom": False, "room": None})

    def test_snapshot_reads_the_ordered_list(self):
        snapshot = together.parse_snapshot({"playlist": {"playMode": "ORDER",
                                                         "displayList": {"result": [1, 2, 3]},
                                                         "randomList": {"result": [3, 2]}}})
        self.assertEqual(snapshot["songIds"], [1, 2, 3])
        self.assertIsNone(snapshot["command"])

    def test_snapshot_follows_random_mode(self):
        snapshot = together.parse_snapshot({"playlist": {"playMode": "RANDOM",
                                                         "displayList": {"result": [1, 2, 3]},
                                                         "randomList": {"result": [3, 2]}}})
        self.assertEqual(snapshot["songIds"], [3, 2])

    def test_snapshot_decodes_the_last_command(self):
        snapshot = together.parse_snapshot({"playCommand": {
            "commandType": "GOTO", "userId": 10001, "formerSongId": "0",
            "targetSongId": "1900172235", "progress": 4321, "playStatus": "PLAY", "serverSeq": 12}})
        self.assertEqual(snapshot["command"], {"accountId": "10001", "type": "GOTO",
                                               "formerSongId": "0", "targetSongId": "1900172235",
                                               "progressMs": 4321, "playing": True, "sequence": 12})

    def test_pause_command_is_not_playing(self):
        snapshot = together.parse_snapshot({"commandInfo": {"commandType": "PAUSE", "playStatus": "PAUSE",
                                                            "targetSongId": "5", "progress": "10"}})
        self.assertFalse(snapshot["command"]["playing"])
        self.assertEqual(snapshot["command"]["progressMs"], 10)

    def test_snapshot_ignores_junk_list_entries(self):
        self.assertEqual(together.parse_snapshot(
            {"playlist": {"displayList": {"result": [1, "x", None, 2]}}})["songIds"], [1, 2])

    def test_snapshot_survives_garbage(self):
        self.assertEqual(together.parse_snapshot(None), {"songIds": [], "command": None})
        self.assertEqual(together.parse_snapshot({"playlist": "nope"}), {"songIds": [], "command": None})
        self.assertEqual(together.parse_snapshot({"playCommand": {"progress": 1}}),
                         {"songIds": [], "command": None})


if __name__ == "__main__":
    unittest.main()
