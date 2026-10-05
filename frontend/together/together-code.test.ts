import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTogetherCode } from "./together-code.ts";

describe("一起听房间信息解析", () => {
  it("裸房间码只给 roomId", () => {
    assert.deepEqual(parseTogetherCode("123456"), { roomId: "123456", inviterId: "" });
  });

  it("房间码:房主uid 两半都拆出来", () => {
    assert.deepEqual(parseTogetherCode("123456:10001"), { roomId: "123456", inviterId: "10001" });
  });

  it("完整邀请链接从 query 里取", () => {
    assert.deepEqual(
      parseTogetherCode("https://music.163.com/st/webplayer?roomId=123456&inviterId=10001"),
      { roomId: "123456", inviterId: "10001" },
    );
  });

  it("网易云官方手机分享链接也能直接加入", () => {
    assert.deepEqual(
      parseTogetherCode("https://st.music.163.com/listen-together/share/?songId=1900172235&roomId=123456&inviterId=10001"),
      { roomId: "123456", inviterId: "10001" },
    );
  });

  it("裸 query 也认", () => {
    assert.deepEqual(parseTogetherCode("roomId=123456&inviterId=10001"), { roomId: "123456", inviterId: "10001" });
  });

  it("链接里没有 inviterId 就只给 roomId", () => {
    assert.deepEqual(parseTogetherCode("https://music.163.com/st/webplayer?roomId=123456"), {
      roomId: "123456",
      inviterId: "",
    });
  });

  it("前后空白去掉，URL 编码解开", () => {
    assert.deepEqual(parseTogetherCode("  123456:10001  "), { roomId: "123456", inviterId: "10001" });
    assert.deepEqual(parseTogetherCode("roomId=123456%3A&inviterId=10001"), { roomId: "123456:", inviterId: "10001" });
  });

  it("空串和纯空白给空结果", () => {
    for (const value of ["", "   ", "\n"]) {
      assert.deepEqual(parseTogetherCode(value), { roomId: "", inviterId: "" }, JSON.stringify(value));
    }
  });

  it("跟一起听无关的网址不误拆", () => {
    assert.deepEqual(parseTogetherCode("https://example.com/song/123456"), { roomId: "", inviterId: "" });
  });
});
