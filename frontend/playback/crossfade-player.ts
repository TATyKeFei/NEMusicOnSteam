import { PLAYER_ACCESS_SCRIPT, TRANSPORT_SCRIPT } from "../player/player-access.ts";
import type { DownloadSong } from "../download/download-player.ts";

export type CrossfadeCandidate = { eligible: boolean; from: string; song: (DownloadSong & { duration: number }) | null };

const QUEUE_ACCESS = `
  const state = playerStore?.getState() || {};
  const current = state.playing || {};
  const room = state['async:listenTogether'] || {};
  const eligible = ['playOrder', 'playCycle'].includes(current.playingMode)
    && !['together', 'togetherOwner'].includes(room.status) && !room.roomInfo?.roomId;
  const from = String(current.resourceTrackId || current.curPlaying?.resourceId || '');
  const list = Array.isArray(state.playingList?.curPlayingList) ? state.playingList.curPlayingList : [];
  const idOf = entry => String(entry?.resourceId || entry?.trackId || entry?.track?.id || entry?.id || '');
  const index = list.findIndex(entry => idOf(entry) === from);
  const nextIndex = index + 1 < list.length ? index + 1 : current.playingMode === 'playCycle' && list.length > 1 ? 0 : -1;
  const entry = eligible && index >= 0 && nextIndex >= 0 ? list[nextIndex] : null;
  const nextId = idOf(entry);
`;

export const CROSSFADE_QUEUE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  ${QUEUE_ACCESS}
  const track = entry?.track || entry?.songInfo || entry?.song || entry;
  const artists = track?.artists || track?.ar || [];
  const album = track?.album || track?.al || {};
  const durationMs = Number(track?.dt || track?.duration || entry?.duration || 0);
  const song = entry && nextId !== from && Number.isSafeInteger(Number(nextId)) && Number(nextId) > 0
    && (!entry.resourceType || entry.resourceType === 'track') && track?.name && durationMs > 0
    ? { id: Number(nextId), name: String(track.name),
        artist: Array.isArray(artists) ? artists.map(item => item?.name).filter(Boolean).join(', ') : '',
        album: String(album.name || ''), cover: String(album.picUrl || ''), duration: durationMs / 1000 }
    : null;
  return { eligible, from, song };
})()`;

export function crossfadeAdoptScript(from: string, to: string): string {
  return `(() => {
    ${PLAYER_ACCESS_SCRIPT}
    ${TRANSPORT_SCRIPT}
    ${QUEUE_ACCESS}
    if (from === ${JSON.stringify(to)}) return true;
    if (from !== ${JSON.stringify(from)} || nextId !== ${JSON.stringify(to)}) return false;
    const bridge = globalThis.__NEMusicOnSteamMpvControls;
    if (bridge) bridge.allowAction = 'next';
    const handled = clickControl(NEXT_LABELS);
    if (bridge) bridge.allowAction = '';
    return handled;
  })()`;
}

export function crossfadeClockScript(trackId: string, position: number, isPlaying: boolean): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    if (String(playing?.resourceTrackId || '') !== ${JSON.stringify(trackId)}) return false;
    const key = '__NEMusicOnSteamPcmUi';
    let ui = globalThis[key];
    if (!ui || ui.store !== playerStore) ui = globalThis[key] = { store: playerStore };
    if (!ui.progress) {
      let loader = globalThis.__NEMusicOnSteamWebpackRequire;
      if (!loader?.m && globalThis.webpackJsonp?.push) {
        const id = 'nemusic-pcm-ui-' + Math.random().toString(36).slice(2);
        globalThis.webpackJsonp.push([[id], { [id]: (module, exports, require) => { loader = require; } }, [[id]]]);
        if (loader?.m) delete loader.m[id];
        if (loader?.c) delete loader.c[id];
      }
      const moduleId = Object.keys(loader?.m || {}).find(id => {
        const source = String(loader.m[id]);
        return source.includes('inSeek') && source.includes('BehaviorSubject') && source.includes('asObservable');
      });
      if (moduleId != null) {
        const exports = loader(moduleId);
        if (typeof exports.d?.next === 'function' && typeof exports.c?.getValue === 'function'
          && typeof exports.b?.getValue === 'function' && typeof exports.b?.next === 'function') {
          ui.progress = exports.d;
          ui.seeking = exports.c;
          ui.loading = exports.b;
        }
      }
    }
    const playingState = ${isPlaying ? "2" : "1"};
    if (playing.playingState !== playingState) {
      await playerStore.dispatch({ type: 'playing/onUpdate', payload: { playingState } });
    }
    const current = playerStore.getState()?.playing;
    if (String(current?.resourceTrackId || '') !== ${JSON.stringify(trackId)}) return false;
    if (!ui.progress || ui.seeking.getValue()?.inSeek) return false;
    const duration = Number(current.resourceDuration) || 0;
    const position = Math.max(0, ${JSON.stringify(position)});
    const target = duration > 0 ? Math.min(duration, position) : position;
    ui.trackId = ${JSON.stringify(trackId)};
    ui.position = target;
    ui.trialStart = Number(current.freeTrialInfo?.start) || 0;
    if (ui.loading.getValue()) ui.loading.next(false);
    ui.progress.next({ current: target - ui.trialStart, cacheProgress: 1, force: true,
      playId: current.playId || ui.trackId + '_nemusic-pcm' });
    return true;
  })()`;
}
