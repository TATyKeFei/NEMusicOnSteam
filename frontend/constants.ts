export const PLAYER_URL = "https://music.163.com/st/webplayer";
export const PLAYER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

export function isPlayerDocument(url: unknown): boolean {
  return typeof url === "string" && (url.startsWith(PLAYER_URL) || url.includes("/st/webplayer"));
}

export const MPRIS_PLAYER_NAME = "NEMusicOnSteam";

/**
 * The command a desktop shortcut should run. `-p` is not optional: without it playerctl
 * targets whichever MPRIS player was active last, which is usually a browser tab.
 */
export function mprisCommand(action: string): string {
  return `playerctl -p ${MPRIS_PLAYER_NAME} ${action}`;
}

export const CONTROL_BAR_HEIGHT = 36;
export const PARKED_SIZE = 4;
export const DEFAULT_HEADER_HEIGHT = 48;
export const ROOT_ID = "nemusic-root";
