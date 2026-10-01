import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

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
  album: string;
  cover: string;
  source: "api" | "player";
};

/** 从列表行里选中的歌曲，而不是当前恰好在播的那一首。 */
export type DownloadSong = { id: number; name: string; artist: string; album?: string; cover?: string };

export const DEFAULT_DOWNLOAD_NAME_TEMPLATE = "{artist} - {title}";

/** 替换 {title} {artist} {album} 占位符；无法识别的占位符原样保留，让用户自己去改。 */
export function formatDownloadName(template: string, parts: { title: string; artist: string; album: string }): string {
  return template
    .split("{title}").join(parts.title)
    .split("{artist}").join(parts.artist)
    .split("{album}").join(parts.album);
}

export function isDownloadQuality(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Object.prototype.hasOwnProperty.call(DOWNLOAD_LEVELS, value);
}

/** 无损及以上的档位向网易云指定 flac；有损档位让它自己挑。 */
export function downloadLevel(value: number): { level: string; encodeType: string | null } | null {
  const level = DOWNLOAD_LEVELS[value];
  if (level == null) return null;
  return { level, encodeType: value >= 999 ? "flac" : null };
}

/**
 * 保存文件的基础名，不含扩展名：真实的扩展名由 Python 在嗅探字节后补上。
 * 分隔符和长度限制都在 Python 那边处理，这里只负责规整空白字符。
 */
export function songFileName(template: string, parts: { title: unknown; artist: unknown; album?: unknown }): string {
  const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return formatDownloadName(template, {
    title: clean(parts.title) || "未知歌曲",
    artist: clean(parts.artist) || "未知歌手",
    album: clean(parts.album),
  });
}

export function downloadScript(value: number, song?: DownloadSong): string {
  const requested = downloadLevel(value);
  if (requested == null) throw new Error(`不支持的下载音质: ${value}`);
  const target =
    song == null
      ? null
      : {
          id: Number(song.id),
          name: String(song.name ?? "").trim(),
          artist: String(song.artist ?? "").trim(),
          album: String(song.album ?? "").trim(),
          cover: String(song.cover ?? "").trim(),
        };
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
    const album = String(track?.album?.name || track?.albumName || track?.album || '').trim();
    const metadata = navigator.mediaSession?.metadata;
    const cover = String(track?.album?.picUrl || track?.al?.picUrl || track?.picUrl || track?.cover || playingState?.resourceCoverUrl || metadata?.artwork?.at(-1)?.src || '').trim();
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
        album: String(target?.album || album || metadata?.album || '').trim(),
        cover: String(target?.cover || cover || '').trim(),
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
      return { url: playingStream, type: '', size: 0, br: 0, level: '', name, artist, album: String(target?.album || album || '').trim(), cover: String(target?.cover || cover || '').trim(), source: 'player' };
    }
    if (Number.isFinite(code) && code !== 200) throw new Error('网易云接口返回 code ' + code + '，可能已下架或需要在播放器里重新登录');
    throw new Error('网易云没有返回可下载地址，可能是无版权、需要 VIP 或账号未登录');
  })()`;
}

/**
 * 从 Redux store 里读播放器自己的播放列表。这个状态键在网易云的历次更新中挪过位置，
 * 所以这里把所有合理的候选都探测一遍，并且只接受带有真实 id 和名称的条目——猜错最多
 * 得到一个空列表，绝不会下到错误的文件。
 */
export const PLAYING_LIST_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  const state = playerStore?.getState() || {};
  const playing = state.playing || {};
  const candidates = [playing.playingList, playing.playList, playing.list, state.playingList];
  const raw = candidates.find(item => Array.isArray(item) && item.length > 0) || [];
  const seen = new Set();
  const songs = [];
  for (const entry of raw) {
    const track = entry && typeof entry === 'object' ? (entry.songInfo ?? entry.song ?? entry.track ?? entry) : null;
    if (!track || typeof track !== 'object') continue;
    const id = Number(track.id ?? track.resourceId ?? track.songId);
    const name = String(track.name ?? track.songName ?? '').trim();
    if (!Number.isFinite(id) || id <= 0 || !name || seen.has(id)) continue;
    seen.add(id);
    const artistList = Array.isArray(track.artists) ? track.artists : Array.isArray(track.ar) ? track.ar : [];
    songs.push({
      id,
      name,
      artist: artistList.map(item => item?.name).filter(Boolean).join(', '),
      album: String(track.album?.name ?? track.al?.name ?? track.albumName ?? '').trim(),
      cover: String(track.album?.picUrl ?? track.al?.picUrl ?? track.picUrl ?? track.cover ?? '').trim(),
    });
  }
  return songs;
})()`;
