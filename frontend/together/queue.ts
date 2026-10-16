/** 此工厂会编译成页面脚本，保持自包含，便于同时测试普通 TS 和 CDP 中的实际代码。 */
export function roomQueueTools() {
  const songIds = (raw: unknown): string[] => {
    const ids = new Set<string>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      const wrapped = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      const track = (wrapped?.track || wrapped?.songInfo || wrapped?.song || wrapped) as Record<string, unknown> | null;
      const id = Number(track?.id ?? track?.trackId ?? track?.resourceId ?? track?.songId ?? (wrapped ? null : entry));
      if (Number.isSafeInteger(id) && id > 0) ids.add(String(id));
    }
    return [...ids];
  };
  const roomQueueOf = (slice: unknown): string[] => {
    const list = (slice || {}) as Record<string, unknown>;
    for (const name of [
      "displayTrackIds", "playingList", "curPlayingList", "list", "queue", "roomPlayingList", "tracks",
      "randomTrackIds", "displayList", "randomList",
    ]) {
      const ids = songIds(list[name]);
      if (ids.length) return ids;
    }
    return [];
  };
  return { songIds, roomQueueOf };
}

export const ROOM_QUEUE_HELPER = `const { songIds, roomQueueOf } = (${roomQueueTools.toString()})();`;
