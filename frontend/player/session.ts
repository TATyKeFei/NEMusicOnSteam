import type { PlayerRecoverySnapshot } from "./player-recovery-player.ts";

const KEY = "nemusic.onsteam.last-session.v1";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function saveSession(storage: SessionStorage | null, snapshot: PlayerRecoverySnapshot): void {
  if (!snapshot.current || snapshot.queue.length > 5000) return;
  try {
    const data = JSON.stringify({ savedAt: Date.now(), snapshot });
    if (data.length <= 2_000_000) storage?.setItem(KEY, data);
  } catch {}
}

export function readSession(storage: SessionStorage | null): PlayerRecoverySnapshot | null {
  try {
    const raw = storage?.getItem(KEY) || "null";
    if (raw.length > 2_000_000) return null;
    const data = JSON.parse(raw);
    const item = data?.snapshot;
    if (!Number.isFinite(data?.savedAt) || Date.now() - data.savedAt > MAX_AGE || data.savedAt > Date.now() + 60000
      || !item?.current || typeof item.current !== "object" || Array.isArray(item.current) || !Array.isArray(item.queue) || item.queue.length > 5000
      || !Number.isFinite(item.position) || item.position < 0 || !Number.isFinite(item.volume) || item.volume < 0 || item.volume > 1
      || typeof item.href !== "string" || typeof item.mode !== "string" || item.mode.length > 40 || typeof item.playing !== "boolean"
      || (item.accountId !== undefined && (typeof item.accountId !== "string" || !/^\d*$/.test(item.accountId)))) return null;
    return item;
  } catch { return null; }
}

export function clearSession(storage: SessionStorage | null): void {
  try { storage?.removeItem(KEY); } catch {}
}
