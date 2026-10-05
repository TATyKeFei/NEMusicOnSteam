/**
 * 加入一起听要的「房间信息」解析。
 *
 * 加入接口 play/invitation/accept 必须同时带 roomId 和房主 uid（inviterId），而网页版没有任何
 * 「roomId → 房主 uid」的接口。所以复制端（房主）把自己的 uid 一起编进链接里；用户粘贴的既可能是
 * 网易云官方手机分享链接，也可能是我们自己约定的 `房间码:房主uid`，也可能只是裸房间码（这种只能再去 room/check
 * 碰运气，见 TOGETHER_JOIN_SCRIPT）。这里只负责把这几种形状统一拆成 {roomId, inviterId}。
 */

export type TogetherCode = { roomId: string; inviterId: string };

const EMPTY: TogetherCode = { roomId: "", inviterId: "" };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 从完整链接或裸 query 里取一个参数。`&`、`?`、`#` 都算分隔符。 */
function pickQuery(text: string, key: string): string {
  const match = new RegExp(`(?:^|[?&#])${key}=([^&#]*)`).exec(text);
  return match ? safeDecode(match[1]).trim() : "";
}

export function parseTogetherCode(raw: string): TogetherCode {
  const text = String(raw ?? "").trim();
  if (!text) return EMPTY;
  // 带 roomId= 的当成链接/query 解析。inviterId 可能缺（裸房间码拼的链接）。
  if (text.includes("roomId=")) {
    return { roomId: pickQuery(text, "roomId"), inviterId: pickQuery(text, "inviterId") };
  }
  // 只有 http(s) 开头、又没有 roomId 参数的，是别的链接，别去按 `:` 拆（那会拆出 "https"）。
  if (/^https?:\/\//i.test(text)) return EMPTY;
  const sep = text.indexOf(":");
  if (sep >= 0) {
    return { roomId: text.slice(0, sep).trim(), inviterId: text.slice(sep + 1).trim() };
  }
  return { roomId: text, inviterId: "" };
}
