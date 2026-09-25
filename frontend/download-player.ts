import { PLAYER_ACCESS_SCRIPT } from "./mpris-player.ts";

const DOWNLOAD_LEVELS: Record<number, string> = {
  128: "standard",
  192: "higher",
  320: "exhigh",
  999: "lossless",
  1999: "hires",
  3999: "jyeffect",
  4999: "jymaster",
  5999: "sky",
};

export const DEFAULT_DOWNLOAD_QUALITY = 320;

export type DownloadTrack = {
  url: string;
  type: string;
  size: number;
  br: number;
  level: string;
  name: string;
  artist: string;
  source: "api" | "player";
};

/** A song picked from a list row instead of whatever happens to be playing. */
export type DownloadSong = { id: number; name: string; artist: string };

export function isDownloadQuality(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Object.prototype.hasOwnProperty.call(DOWNLOAD_LEVELS, value);
}

/** Lossless levels and above ask NetEase for flac; lossy levels let it pick. */
export function downloadLevel(value: number): { level: string; encodeType: string | null } | null {
  const level = DOWNLOAD_LEVELS[value];
  if (level == null) return null;
  return { level, encodeType: value >= 999 ? "flac" : null };
}

/**
 * Base name for the saved file, without an extension: Python appends the real one after sniffing the bytes.
 * Separators and length are enforced on the Python side; this only normalizes whitespace.
 */
export function songFileName(artist: unknown, title: unknown): string {
  const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean(artist) || "未知歌手"} - ${clean(title) || "未知歌曲"}`;
}

export function downloadScript(value: number, song?: DownloadSong): string {
  const requested = downloadLevel(value);
  if (requested == null) throw new Error(`不支持的下载音质: ${value}`);
  const target =
    song == null
      ? null
      : { id: Number(song.id), name: String(song.name ?? "").trim(), artist: String(song.artist ?? "").trim() };
  if (target != null && (!Number.isFinite(target.id) || target.id <= 0 || target.name === "")) {
    throw new Error("没有认出要下载的歌曲，只能先播放它再用设置页下载");
  }
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    const requested = ${JSON.stringify({ ...requested, data: value })};
    const target = ${JSON.stringify(target)};
    const playingState = playerStore?.getState()?.playing;
    const track = playingState?.curPlaying && typeof playingState.curPlaying === 'object' ? playingState.curPlaying : null;
    const id = target?.id || [playingState?.resourceTrackId, track?.resourceId, track?.id]
      .map(candidate => Number(candidate))
      .find(candidate => Number.isFinite(candidate) && candidate > 0) || 0;
    const artists = Array.isArray(track?.artists) ? track.artists.map(entry => entry?.name).filter(Boolean).join(', ') : '';
    const metadata = navigator.mediaSession?.metadata;
    const name = String(target?.name || track?.name || metadata?.title || '').trim();
    const artist = String(target?.artist || artists || metadata?.artist || '').trim();
    if (!id) throw new Error('没有正在播放的歌曲，请先在播放器里播放一首歌');
    let code = null;
    let item = null;
    try {
      const query = 'ids=' + encodeURIComponent(JSON.stringify([id]))
        + '&level=' + encodeURIComponent(requested.level)
        + (requested.encodeType ? '&encodeType=' + encodeURIComponent(requested.encodeType) : '');
      const response = await fetch('/api/song/enhance/player/url/v1?' + query, { credentials: 'include' });
      if (!response.ok) throw new Error('网易云接口返回 ' + response.status);
      const payload = await response.json();
      code = Number(payload?.code);
      item = Array.isArray(payload?.data) ? payload.data[0] : null;
    } catch (error) {
      code = null;
      item = null;
    }
    const url = typeof item?.url === 'string' && item.url.startsWith('http') ? item.url : '';
    if (url) {
      return {
        url,
        type: String(item.type || ''),
        size: Number(item.size) || 0,
        br: Number(item.br) || 0,
        level: String(item.level || requested.level),
        name,
        artist,
        source: 'api',
      };
    }
    if (target) {
      if (Number.isFinite(code) && code !== 200) throw new Error('网易云接口返回 code ' + code + '，可能已下架或需要在播放器里重新登录');
      throw new Error('网易云没有返回可下载地址，可能是无版权、需要 VIP 或账号未登录');
    }
    const mediaCandidates = Array.from(document.querySelectorAll('audio, video'));
    const mediaScore = element => {
      const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
      const position = Number.isFinite(element.currentTime) && element.currentTime > 0 ? element.currentTime : 0;
      return (element.paused ? 0 : 1000000000) + (position > 0 ? 100000000 : 0) + (element.readyState > 0 ? 10000000 : 0) + duration;
    };
    const media = mediaCandidates.sort((left, right) => mediaScore(right) - mediaScore(left))[0] || null;
    const playingStream = String(media?.currentSrc || media?.src || '');
    if (playingStream.startsWith('http')) {
      return { url: playingStream, type: '', size: 0, br: 0, level: '', name, artist, source: 'player' };
    }
    if (Number.isFinite(code) && code !== 200) throw new Error('网易云接口返回 code ' + code + '，可能已下架或需要在播放器里重新登录');
    throw new Error('网易云没有返回可下载地址，可能是无版权、需要 VIP 或账号未登录');
  })()`;
}
