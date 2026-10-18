import { DEFAULT_DOWNLOAD_NAME_TEMPLATE, DEFAULT_DOWNLOAD_QUALITY, isDownloadQuality } from "./download/download-player.ts";
import { DEFAULT_UNBLOCK_SOURCES, sanitizeUnblockSources, type UnblockSource } from "./unblock/sources.ts";

export type NotificationMode = "system" | "steam" | "none";
export type PlaybackBackend = "web" | "mpv" | "mpd";
export type TransitionMode = "off" | "normal" | "smart";
/** 智能分析不可靠时的回退方式：普通过渡 / 不做混音 / 尽力拍点混音（放宽判定再试）。 */
export type TransitionFallback = "normal" | "none" | "force";
export type MpdSettings = { host: string; port: number; password: string; socket: string };
export const DEFAULT_MPD_SETTINGS: MpdSettings = { host: "127.0.0.1", port: 6600, password: "", socket: "" };
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;

export type PlayerSettings = {
  playbackBackend: PlaybackBackend;
  mpvTransitionMode: TransitionMode;
  mpvTransitionSeconds: number;
  mpvTransitionFallback: TransitionFallback;
  mpd: MpdSettings;
  unblockEnabled: boolean;
  unblockSources: UnblockSource[];
  uiScale: number;
  openOnStart: boolean;
  keepAliveWhenCollapsed: boolean;
  disableBackgroundThrottling: boolean;
  downloadDirectory: string;
  downloadQuality: number;
  notificationMode: NotificationMode;
  downloadNameTemplate: string;
};

export const SETTINGS_KEY = "nemusic.onsteam.settings.v1";

export const defaultSettings: PlayerSettings = {
  playbackBackend: "web",
  mpvTransitionMode: "off",
  mpvTransitionSeconds: 6,
  mpvTransitionFallback: "normal",
  mpd: DEFAULT_MPD_SETTINGS,
  unblockEnabled: false,
  unblockSources: DEFAULT_UNBLOCK_SOURCES,
  uiScale: 1,
  openOnStart: false,
  keepAliveWhenCollapsed: true,
  disableBackgroundThrottling: true,
  downloadDirectory: "",
  downloadQuality: DEFAULT_DOWNLOAD_QUALITY,
  notificationMode: "system",
  downloadNameTemplate: DEFAULT_DOWNLOAD_NAME_TEMPLATE,
};
type StorageLike = Pick<Storage, "getItem" | "setItem">;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function directoryOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim().slice(0, 4096) : fallback;
}

function notificationModeOr(value: unknown, fallback: NotificationMode): NotificationMode {
  return value === "system" || value === "steam" || value === "none" ? value : fallback;
}

function playbackBackendOr(value: unknown, fallback: PlaybackBackend): PlaybackBackend {
  return value === "web" || value === "mpv" || value === "mpd" ? value : fallback;
}

export function sanitizeMpdSettings(value: unknown): MpdSettings {
  const record = value != null && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (value: unknown, fallback: string) => typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 4096) : fallback;
  return {
    host: text(record.host, DEFAULT_MPD_SETTINGS.host) || DEFAULT_MPD_SETTINGS.host,
    port: typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
      ? record.port : DEFAULT_MPD_SETTINGS.port,
    password: typeof record.password === "string" ? record.password.replace(/[\r\n\x00]/g, "").slice(0, 4096) : "",
    socket: text(record.socket, ""),
  };
}

export function uiScaleOr(value: unknown, fallback: number): number {
  if (!finiteNumber(value)) return fallback;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

function templateOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
  return cleaned === "" ? fallback : cleaned;
}

export function sanitizeSettings(value: unknown): PlayerSettings {
  const record = value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const notificationMode = notificationModeOr(
    record.notificationMode,
    notificationModeOr(record.downloadNotificationMode, defaultSettings.notificationMode),
  );
  return {
    playbackBackend: playbackBackendOr(record.playbackBackend, defaultSettings.playbackBackend),
    mpvTransitionMode: ["off", "normal", "smart"].includes(String(record.mpvTransitionMode))
      ? record.mpvTransitionMode as TransitionMode : record.mpvTransition === true ? "normal" : "off",
    mpvTransitionSeconds: finiteNumber(record.mpvTransitionSeconds)
      ? Math.round(Math.max(1, Math.min(12, record.mpvTransitionSeconds))) : defaultSettings.mpvTransitionSeconds,
    mpvTransitionFallback: record.mpvTransitionFallback === "none" || record.mpvTransitionFallback === "force"
      ? record.mpvTransitionFallback : defaultSettings.mpvTransitionFallback,
    mpd: sanitizeMpdSettings(record.mpd),
    unblockEnabled: booleanOr(record.unblockEnabled, defaultSettings.unblockEnabled),
    unblockSources: sanitizeUnblockSources(record.unblockSources),
    uiScale: uiScaleOr(record.uiScale, defaultSettings.uiScale),
    openOnStart: booleanOr(record.openOnStart, defaultSettings.openOnStart),
    keepAliveWhenCollapsed: booleanOr(record.keepAliveWhenCollapsed, defaultSettings.keepAliveWhenCollapsed),
    disableBackgroundThrottling: booleanOr(record.disableBackgroundThrottling, defaultSettings.disableBackgroundThrottling),
    downloadDirectory: directoryOr(record.downloadDirectory, defaultSettings.downloadDirectory),
    downloadQuality: isDownloadQuality(record.downloadQuality) ? record.downloadQuality : defaultSettings.downloadQuality,
    notificationMode,
    downloadNameTemplate: templateOr(record.downloadNameTemplate, defaultSettings.downloadNameTemplate),
  };
}

export function readSettings(storage: Pick<Storage, "getItem"> | null): PlayerSettings {
  if (storage == null) return sanitizeSettings(null);
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw == null || raw === "") return sanitizeSettings(null);
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return sanitizeSettings(null);
  }
}

export function writeSettings(storage: StorageLike | null, settings: PlayerSettings): void {
  if (storage == null) return;
  storage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
