import { PLAYER_ACCESS_SCRIPT, SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { CROSSFADE_QUEUE_SCRIPT } from "./crossfade-player.ts";

export const WEB_PRELOAD_CLEAR_SCRIPT = `(() => {
  globalThis.__NEMusicOnSteamWebPreload?.restore();
  return true;
})()`;

/** 缓冲音频，并让网页自己的下一次 URL 请求复用同一地址，以便命中浏览器媒体缓存。 */
export function webPreloadScript(enabled: boolean): string {
  if (!enabled) return WEB_PRELOAD_CLEAR_SCRIPT;
  return `(() => {
    ${PLAYER_ACCESS_SCRIPT}
    const key = '__NEMusicOnSteamWebPreload';
    let api = globalThis[key];
    if (api && api.store !== playerStore) { api.restore(); api = null; }
    if (!playerStore) return false;
    if (!api) {
      let loader = globalThis.__NEMusicOnSteamWebpackRequire;
      if (!loader?.m && globalThis.webpackJsonp?.push) {
        const id = 'nemusic-preload-' + Math.random().toString(36).slice(2);
        globalThis.webpackJsonp.push([[id], { [id]: (module, exports, require) => { loader = require; } }, [[id]]]);
        if (loader?.m) delete loader.m[id];
        if (loader?.c) delete loader.c[id];
      }
      const moduleId = Object.keys(loader?.m || {}).find(id => {
        const source = String(loader.m[id]);
        return source.includes('rawFetch') && source.includes('FetchWithRPC');
      });
      const network = moduleId == null ? null : loader(moduleId);
      if (typeof network?.default !== 'function') return false;
      const original = network.default;
      api = { store: playerStore, active: true, revision: 0, cache: null, media: null, pending: '', retryAt: 0, status: '等待预载时机' };
      const requestKey = (raw, options) => {
        try {
          const url = new URL(raw, location.href);
          if (!/\\/(?:api|weapi|eapi)\\/song\\/enhance\\/player\\/url\\/v1$/.test(url.pathname)) return '';
          const data = options?.data;
          const params = typeof data === 'string' ? new URLSearchParams(data) : null;
          const value = name => params?.get(name) || data?.[name] || url.searchParams.get(name);
          const rawIds = value('ids');
          const ids = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
          if (!Array.isArray(ids) || ids.length !== 1) return '';
          return String(ids[0]) + ':' + String(value('level') || '') + ':' + String(value('encodeType') || '');
        } catch { return ''; }
      };
      const hooked = async function(raw, options) {
        const cached = api.cache;
        if (api.active && cached && cached.expires > Date.now() && cached.request === requestKey(raw, options)) {
          return new Response(JSON.stringify(cached.payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return original.apply(this, arguments);
      };
      Object.assign(hooked, original);
      network.default = hooked;
      api.clear = () => {
        api.revision++;
        api.controller?.abort();
        api.controller = null;
        api.pending = '';
        api.cache = null;
        if (api.media) {
          api.media.onerror = null;
          api.media.oncanplay = null;
          api.media.pause();
          api.media.removeAttribute('src');
          api.media.load();
          api.media = null;
        }
      };
      api.restore = () => {
        api.active = false;
        api.clear();
        if (network.default === hooked) network.default = original;
        if (globalThis[key] === api) delete globalThis[key];
      };
      api.preload = (candidate, snapshot, quality) => {
        const levels = { 128: 'standard', 192: 'higher', 320: 'exhigh', 999: 'lossless', 1999: 'hires',
          3999: 'jyeffect', 4999: 'jymaster', 5999: 'sky' };
        const level = levels[quality] || 'exhigh';
        const encodeType = quality >= 999 ? 'flac' : 'mp3';
        const song = candidate?.song;
        const cacheKey = candidate?.from + ':' + song?.id + ':' + level + ':' + encodeType;
        const eligible = candidate?.eligible && song && candidate.from === snapshot.trackId
          && snapshot.duration > 0 && snapshot.duration - snapshot.position <= 45
          && snapshot.playbackStatus === 'Playing';
        if (!eligible) {
          api.status = !candidate?.eligible ? '当前播放模式不支持预载' : !song ? '没有可预载的下一首'
            : snapshot.playbackStatus !== 'Playing' ? '播放暂停，等待继续' : '等待歌曲剩余 45 秒时预载';
          api.clear(); return;
        }
        if (api.pending === cacheKey || (api.cache?.key === cacheKey && api.cache.expires > Date.now())) return;
        api.clear();
        if (Date.now() < api.retryAt) return;
        api.pending = cacheKey;
        api.status = '正在解析下一首：' + song.name;
        const revision = api.revision;
        const controller = api.controller = new AbortController();
        const path = '/api/song/enhance/player/url/v1';
        const options = { method: 'POST', data: { ids: JSON.stringify([song.id]), level, encodeType }, signal: controller.signal };
        void (async () => {
          const response = await network.default(path, options);
          const payload = await response.json();
          if (!api.active || revision !== api.revision) return;
          const item = payload?.data?.[0];
          if (payload?.code !== 200 || String(item?.id) !== String(song.id) || !/^https?:\\/\\//.test(item?.url || '')
            || item.freeTrialInfo) throw new Error('next track unavailable');
          const media = new Audio();
          media.preload = 'auto';
          media.muted = true;
          api.media = media;
          api.status = '正在缓冲下一首：' + song.name;
          media.oncanplay = () => { if (api.media === media) api.status = '下一首已有可播放缓冲：' + song.name; };
          api.cache = { key: cacheKey, request: requestKey(path, options), payload,
            expires: Date.now() + Math.min(Number(item.expi) || 300, 300) * 1000 };
          media.onerror = () => {
            if (api.media !== media) return;
            api.clear();
            api.retryAt = Date.now() + 5000;
            api.status = '音频缓冲失败，5 秒后重试';
          };
          media.src = item.url;
          media.load();
        })().catch(() => {
          if (api.active && revision === api.revision) { api.clear(); api.retryAt = Date.now() + 5000; api.status = '下一首暂不可用，5 秒后重试'; }
        }).finally(() => {
          if (revision === api.revision) api.pending = '';
        });
      };
      api.update = () => {
        if (api.store !== findPlayerStore()) { api.restore(); return false; }
        const state = playerStore.getState();
        const quality = state?.host?.isAnonymous ? state?.setting?.quantity?.listenAnon : state?.setting?.quantity?.listenReg;
        api.preload(${CROSSFADE_QUEUE_SCRIPT}, ${SNAPSHOT_SCRIPT}, quality || 320);
        return true;
      };
      globalThis[key] = api;
    }
    return api.update();
  })()`;
}

export const WEB_PRELOAD_UPDATE_SCRIPT = `(() => {
  const api = globalThis.__NEMusicOnSteamWebPreload;
  return { installed: Boolean(api?.update?.()), status: api?.status || '' };
})()`;
