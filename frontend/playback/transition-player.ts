import { PLAYER_ACCESS_SCRIPT, TRANSPORT_SCRIPT } from "../player/player-access.ts";
import type { DownloadSong } from "../download/download-player.ts";

export type TransitionCandidate = { from: string; song: DownloadSong };

const CANDIDATE_ACCESS = `
  ${PLAYER_ACCESS_SCRIPT}
  const transitionAllowed = () => {
    const state = playerStore?.getState() || {};
    const current = state.playing || {};
    const room = state['async:listenTogether'] || {};
    return !(['together', 'togetherOwner'].includes(room.status) || room.roomInfo?.roomId)
      && ['playOrder', 'playCycle'].includes(current.playingMode) && !current.freeTrialInfo
      && (!current.resourceType || current.resourceType === 'track');
  };
  const transitionCandidate = () => {
    if (!transitionAllowed()) return null;
    const state = playerStore.getState();
    const current = state.playing;
    const list = state.playingList?.curPlayingList;
    if (!Array.isArray(list) || list.length < 2) return null;
    const idOf = entry => String(entry?.resourceId || entry?.trackId || entry?.track?.id || entry?.id || '');
    const from = String(current.resourceTrackId || '');
    const index = list.findIndex(entry => idOf(entry) === from);
    if (index < 0 || (index === list.length - 1 && current.playingMode !== 'playCycle')) return null;
    const entry = list[(index + 1) % list.length];
    if (entry?.resourceType && entry.resourceType !== 'track') return null;
    const track = entry?.track || entry;
    const id = Number(idOf(entry));
    const name = String(track?.name || entry?.name || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || String(id) === from || !name) return null;
    const artists = track.artists || track.ar || [];
    return { from, song: { id, name,
      artist: Array.isArray(artists) ? artists.map(item => item?.name).filter(Boolean).join(', ') : '',
      album: String(track.album?.name || track.al?.name || ''),
      cover: String(track.album?.picUrl || track.al?.picUrl || track.picUrl || ''),
    } };
  };
`;

export const TRANSITION_CANDIDATE_SCRIPT = `(() => {
  ${CANDIDATE_ACCESS}
  return transitionAllowed() ? transitionCandidate() : { blocked: true };
})()`;

// 过渡时网页会异步更新进度。只有真正的 setPlayingPosition action 才表示用户拖动，
// 不能把刚切歌留下的旧滑块读数当成 seek，送回 mpv 中断淡化。
const TRANSITION_CLOCK_ACCESS = `
  const clockKey = '__NEMusicOnSteamTransitionClock';
  let clock = globalThis[clockKey];
  if (playerStore && clock?.store !== playerStore) {
    clock = globalThis[clockKey] = { store: playerStore, aligning: false, pending: null };
    const dispatch = playerStore.dispatch.bind(playerStore);
    playerStore.dispatch = action => {
      if (!clock.aligning && action?.type === 'playing/setPlayingPosition') {
        const value = Number(action.payload?.duration);
        const fresh = playerStore.getState()?.playing;
        if (Number.isFinite(value) && value >= 0) clock.pending = {
          trackId: String(fresh?.resourceTrackId || ''),
          position: value + (Number(fresh?.freeTrialInfo?.start) || 0),
        };
      }
      return dispatch(action);
    };
  }
`;

export function transitionClockScript(trackId: string, position: number, align: boolean): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    ${TRANSITION_CLOCK_ACCESS}
    const trackId = ${JSON.stringify(trackId)};
    if (!clock) return null;
    const pending = clock.pending;
    clock.pending = null;
    if (pending?.trackId === trackId) return { seek: pending.position };
    if (${align ? "true" : "false"} && String(playing?.resourceTrackId || '') === trackId) {
      clock.aligning = true;
      try { await playerControl.seek(${JSON.stringify(position)}); }
      finally { clock.aligning = false; }
    }
    return { seek: null };
  })()`;
}

/** 让网页执行自己的下一首，保留播放历史等行为；队列已变更时绝不按旧预加载跳歌。 */
export function transitionCommitScript(candidate: TransitionCandidate): string {
  return `(async () => {
    ${CANDIDATE_ACCESS}
    ${TRANSPORT_SCRIPT}
    const expected = ${JSON.stringify(candidate)};
    const actual = transitionCandidate();
    if (!actual || actual.from !== expected.from || actual.song.id !== expected.song.id) return false;
    ${TRANSITION_CLOCK_ACCESS}
    if (clock) clock.pending = null;
    const controls = globalThis.__NEMusicOnSteamMpvControls;
    if (controls) controls.allowAction = 'next';
    let clicked = false;
    try { clicked = clickControl(NEXT_LABELS); }
    finally { if (controls) controls.allowAction = ''; }
    if (!clicked) return false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = playerStore.getState()?.playing;
      if (String(current?.resourceTrackId || '') === String(expected.song.id)) return true;
      const selected = String(current?.curPlaying?.resourceId || current?.curPlaying?.track?.id || expected.from);
      if (selected !== expected.from && selected !== String(expected.song.id)) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`;
}
