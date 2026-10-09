export const PLAYER_URL = "https://music.163.com/st/webplayer";
export const PLAYER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

export function isPlayerDocument(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://music.163.com" && parsed.pathname === "/st/webplayer";
  } catch {
    return false;
  }
}

export const MPRIS_PLAYER_NAME = "NEMusicOnSteam";

/**
 * 桌面快捷方式应该执行的命令。-p 不是可选项：少了它，playerctl 会作用于上一次活跃的
 * 那个 MPRIS 播放器，而那通常是个浏览器标签页。
 */
export function mprisCommand(action: string): string {
  return `playerctl -p ${MPRIS_PLAYER_NAME} ${action}`;
}

export const CONTROL_BAR_HEIGHT = 36;
export const PARKED_SIZE = 4;
export const DEFAULT_HEADER_HEIGHT = 48;
export const ROOT_ID = "nemusic-root";
