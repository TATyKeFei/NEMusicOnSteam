import { DEFAULT_DOWNLOAD_NAME_TEMPLATE, DEFAULT_DOWNLOAD_QUALITY, isDownloadQuality } from "./download/download-player.ts";
import { DEFAULT_UNBLOCK_SOURCES, sanitizeUnblockSources, type UnblockSource } from "./unblock/sources.ts";

export type NotificationMode = "system" | "steam" | "none";
export type NotificationSettingsMode = "unified" | "independent";
export type PlaybackBackend = "web" | "mpv" | "mpd";
export type CrossfadeMode = "off" | "conservative" | "standard" | "eager";
export type TransitionMode = "none" | "auto" | "crossfade";
export type LoudnessMode = "off" | "replaygain" | "dynamic";
export type MpdSettings = { host: string; port: number; password: string; socket: string };
export const DEFAULT_MPD_SETTINGS: MpdSettings = { host: "127.0.0.1", port: 6600, password: "", socket: "" };
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;

export type PlayerSettings = {
  playbackBackend: PlaybackBackend;
  mpvCrossfade: CrossfadeMode;
  mpvTransitionMode: TransitionMode;
  mpvCrossfadeSeconds: number;
  preloadNext: boolean;
  mpvLoudness: LoudnessMode;
  audioOutputDevice: string;
  restoreSession: boolean;
  resumeOnRestore: boolean;
  skipDuplicateDownloads: boolean;
  sleepFadeSeconds: number;
  notificationSettingsMode: NotificationSettingsMode;
  trackNotificationMode: NotificationMode;
  downloadNotificationMode: NotificationMode;
  trackNotifyOnlyCollapsed: boolean;
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
  mpvCrossfade: "off",
  mpvTransitionMode: "none",
  mpvCrossfadeSeconds: 4,
  preloadNext: false,
  mpvLoudness: "off",
  audioOutputDevice: "auto",
  restoreSession: true,
  resumeOnRestore: false,
  skipDuplicateDownloads: true,
  sleepFadeSeconds: 10,
  notificationSettingsMode: "unified",
  trackNotificationMode: "system",
  downloadNotificationMode: "system",
  trackNotifyOnlyCollapsed: false,
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
  const legacyNotificationMode = notificationModeOr(
    record.notificationMode,
    notificationModeOr(record.downloadNotificationMode, defaultSettings.notificationMode),
  );
  const trackNotificationMode = notificationModeOr(record.trackNotificationMode, legacyNotificationMode);
  const downloadNotificationMode = notificationModeOr(record.downloadNotificationMode, legacyNotificationMode);
  const hasNotificationSettingsMode = record.notificationSettingsMode === "unified" || record.notificationSettingsMode === "independent";
  // 旧设置的两个渠道不同时保留独立模式；相同时直接作为统一通知方式。
  const notificationSettingsMode = hasNotificationSettingsMode ? record.notificationSettingsMode as NotificationSettingsMode
    : trackNotificationMode === downloadNotificationMode ? "unified" : "independent";
  const notificationMode = hasNotificationSettingsMode ? legacyNotificationMode : trackNotificationMode;
  const crossfade = record.mpvCrossfade === "conservative" || record.mpvCrossfade === "standard" || record.mpvCrossfade === "eager"
    ? record.mpvCrossfade : "off";
  // 旧版用“关闭”档位控制启停；迁移后由过渡模式统一控制。
  const transitionMode = record.mpvTransitionMode === "none" || record.mpvTransitionMode === "crossfade"
    ? record.mpvTransitionMode
    : record.mpvTransitionMode === "auto" && record.mpvCrossfade !== "off" ? "auto"
      : crossfade !== "off" ? "auto" : "none";
  return {
    playbackBackend: playbackBackendOr(record.playbackBackend, defaultSettings.playbackBackend),
    mpvCrossfade: transitionMode === "auto" && crossfade === "off" ? "standard" : crossfade,
    mpvTransitionMode: transitionMode,
    mpvCrossfadeSeconds: finiteNumber(record.mpvCrossfadeSeconds)
      ? Math.max(1, Math.min(12, Math.round(record.mpvCrossfadeSeconds))) : defaultSettings.mpvCrossfadeSeconds,
    preloadNext: booleanOr(record.preloadNext, defaultSettings.preloadNext),
    mpvLoudness: record.mpvLoudness === "replaygain" || record.mpvLoudness === "dynamic" ? record.mpvLoudness : "off",
    audioOutputDevice: typeof record.audioOutputDevice === "string" ? record.audioOutputDevice.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 512) || "auto" : "auto",
    restoreSession: booleanOr(record.restoreSession, true),
    resumeOnRestore: booleanOr(record.resumeOnRestore, false),
    skipDuplicateDownloads: booleanOr(record.skipDuplicateDownloads, true),
    sleepFadeSeconds: finiteNumber(record.sleepFadeSeconds) ? Math.max(0, Math.min(30, Math.round(record.sleepFadeSeconds))) : 10,
    notificationSettingsMode,
    trackNotificationMode,
    downloadNotificationMode,
    trackNotifyOnlyCollapsed: booleanOr(record.trackNotifyOnlyCollapsed, false),
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

export function notificationModeFor(settings: Pick<PlayerSettings, "notificationSettingsMode" | "notificationMode" | "trackNotificationMode" | "downloadNotificationMode">,
  channel: "track" | "download"): NotificationMode {
  return settings.notificationSettingsMode === "unified" ? settings.notificationMode
    : channel === "track" ? settings.trackNotificationMode : settings.downloadNotificationMode;
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
