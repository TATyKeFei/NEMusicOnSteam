import { DEFAULT_DOWNLOAD_QUALITY, isDownloadQuality } from "./download-player.ts";

export type LauncherPosition = { left: number; bottom: number } | { left: number; top: number };

export type PlayerSettings = {
  openOnStart: boolean;
  keepAliveWhenCollapsed: boolean;
  disableBackgroundThrottling: boolean;
  launcher: LauncherPosition;
  downloadDirectory: string;
  downloadQuality: number;
};

export const SETTINGS_KEY = "nemusic.onsteam.settings.v1";

export const defaultSettings: PlayerSettings = {
  openOnStart: false,
  keepAliveWhenCollapsed: true,
  disableBackgroundThrottling: true,
  launcher: { left: 16, bottom: 16 },
  downloadDirectory: "",
  downloadQuality: DEFAULT_DOWNLOAD_QUALITY,
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

export function sanitizeLauncher(value: unknown): LauncherPosition {
  if (value == null || typeof value !== "object") return { ...defaultSettings.launcher };
  const record = value as Record<string, unknown>;
  if (!finiteNumber(record.left)) return { ...defaultSettings.launcher };
  if (finiteNumber(record.top)) return { left: record.left, top: record.top };
  if (finiteNumber(record.bottom)) return { left: record.left, bottom: record.bottom };
  return { ...defaultSettings.launcher };
}

export function sanitizeSettings(value: unknown): PlayerSettings {
  const record = value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    openOnStart: booleanOr(record.openOnStart, defaultSettings.openOnStart),
    keepAliveWhenCollapsed: booleanOr(record.keepAliveWhenCollapsed, defaultSettings.keepAliveWhenCollapsed),
    disableBackgroundThrottling: booleanOr(record.disableBackgroundThrottling, defaultSettings.disableBackgroundThrottling),
    launcher: sanitizeLauncher(record.launcher),
    downloadDirectory: directoryOr(record.downloadDirectory, defaultSettings.downloadDirectory),
    downloadQuality: isDownloadQuality(record.downloadQuality) ? record.downloadQuality : defaultSettings.downloadQuality,
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

export function clampLauncher(
  position: LauncherPosition,
  viewportWidth: number,
  viewportHeight: number,
  boxWidth: number,
  boxHeight: number,
): LauncherPosition {
  const maxLeft = Math.max(0, viewportWidth - boxWidth);
  const left = Math.min(Math.max(0, position.left), maxLeft);
  if ("top" in position) {
    const maxTop = Math.max(0, viewportHeight - boxHeight);
    return { left, top: Math.min(Math.max(0, position.top), maxTop) };
  }
  const maxBottom = Math.max(0, viewportHeight - boxHeight);
  return { left, bottom: Math.min(Math.max(0, position.bottom), maxBottom) };
}
