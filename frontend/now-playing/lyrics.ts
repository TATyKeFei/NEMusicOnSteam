import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

export type LyricLine = { at: number; text: string; translation: string };
export type SongLyrics = { lines: LyricLine[]; text: string; instrumental: boolean };

export function parseLyrics(original: string, translated = ""): LyricLine[] {
  const parse = (value: string): { at: number; text: string }[] => {
    const lines: { at: number; text: string }[] = [];
    const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(value)?.[1] ?? 0) / 1000;
    for (const row of value.split(/\r?\n/)) {
      const stamps = [...row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
      const text = row.replace(/\[[^\]]*\]/g, "").trim();
      if (!text) continue;
      for (const stamp of stamps) {
        const fraction = Number(`0.${stamp[3] || "0"}`);
        lines.push({ at: Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) + fraction + offset), text });
      }
    }
    return lines.sort((left, right) => left.at - right.at);
  };
  const translations = new Map(parse(translated).map(line => [Math.round(line.at * 1000), line.text]));
  const lines: LyricLine[] = [];
  for (const line of parse(original)) {
    const previous = lines[lines.length - 1];
    if (previous?.at === line.at) {
      if (previous.text !== line.text) previous.text += ` / ${line.text}`;
      continue;
    }
    lines.push({ ...line, translation: translations.get(Math.round(line.at * 1000)) ?? "" });
  }
  return lines;
}

export function activeLyric(lines: LyricLine[], position: number): number {
  let low = 0, high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].at <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** 只在歌曲面板打开时按歌曲读取，开始与结束都校验 ID，避免串到下一首。 */
export function songLyricsScript(trackId: string): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    const id = ${JSON.stringify(trackId)};
    const currentId = () => String(playerStore?.getState()?.playing?.resourceTrackId || '');
    if (!/^\\d+$/.test(id) || currentId() !== id) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&tv=-1&os=pc', {
        credentials: 'include', signal: controller.signal,
      });
      if (!response.ok) throw new Error('歌词暂时无法加载');
      const payload = await response.json();
      if (currentId() !== id) return null;
      if (payload?.code !== 200) throw new Error('歌词暂时无法加载');
      return { original: String(payload?.lrc?.lyric || '').slice(0, 100000),
        translated: String(payload?.tlyric?.lyric || '').slice(0, 100000), instrumental: payload?.nolyric === true };
    } finally { clearTimeout(timeout); }
  })()`;
}

export function playbackTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
