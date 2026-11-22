import { sanitizeSettings } from "../settings/settings.ts";
import type { DownloadTask } from "./download.ts";

export const DOWNLOAD_TASKS_KEY = "nemusic.onsteam.download-tasks.v1";
const PAUSED_KEY = "nemusic.onsteam.download-paused.v1";
export type TaskStorage = Pick<Storage, "getItem" | "setItem">;
const STATES = new Set(["queued", "resolving", "downloading", "completed", "failed", "cancelled", "skipped"]);
export function readDownloadPaused(storage?: TaskStorage | null): boolean {
  try { return storage?.getItem(PAUSED_KEY) === "true"; } catch { return false; }
}
export function saveDownloadPaused(storage: TaskStorage | null | undefined, paused: boolean): boolean {
  try { storage?.setItem(PAUSED_KEY, String(paused)); return true; } catch { return false; }
}

/** 只持久化歌曲与下载选项，音频 URL 每次执行任务时重新解析。 */
export function readDownloadTasks(storage?: TaskStorage | null): DownloadTask[] {
  try {
    const raw = storage?.getItem(DOWNLOAD_TASKS_KEY) || "[]";
    if (raw.length > 2_000_000) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 5000) return [];
    const ids = new Set<string>();
    return data.flatMap(item => {
      if (!item || typeof item.id !== "string" || item.id.length > 100 || ids.has(item.id)
        || !Number.isSafeInteger(item.songId) || item.songId <= 0 || !STATES.has(item.state)) return [];
      ids.add(item.id);
      const text = (value: unknown) => typeof value === "string" ? value.slice(0, 4096) : "";
      const saved = sanitizeSettings(item.options);
      const options = { quality: saved.downloadQuality, directory: saved.downloadDirectory,
        nameTemplate: saved.downloadNameTemplate, notificationMode: saved.notificationMode, skipDuplicates: saved.skipDuplicateDownloads };
      const state = ["resolving", "downloading"].includes(item.state) ? "queued" : item.state;
      const title = text(item.title), artist = text(item.artist);
      return [{ id: item.id, songId: item.songId, title, artist, state, options,
        song: { id: item.songId, name: title, artist, album: text(item.album) },
        key: `${item.songId}:${options.quality}:${options.directory}`, path: text(item.path), error: text(item.error) }];
    });
  } catch { return []; }
}

export function saveDownloadTasks(storage: TaskStorage | null | undefined, tasks: readonly DownloadTask[]): boolean {
  if (!storage) return true;
  try {
    const data = tasks.filter(task => task.songId > 0).slice(-5000).map(task => ({
      id: task.id, songId: task.songId, title: task.title, artist: task.artist, album: task.song?.album,
      state: task.state, path: task.path, error: task.error.replace(/https?:\/\/\S+/gi, "[地址已隐藏]"),
      options: { downloadQuality: task.options.quality, downloadDirectory: task.options.directory,
        downloadNameTemplate: task.options.nameTemplate, notificationMode: task.options.notificationMode,
        skipDuplicateDownloads: task.options.skipDuplicates !== false },
    }));
    const raw = JSON.stringify(data);
    if (raw.length > 2_000_000) return false;
    storage.setItem(DOWNLOAD_TASKS_KEY, raw);
    return true;
  } catch { return false; }
}
