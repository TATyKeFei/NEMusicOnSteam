import { PLAYER_ACCESS_SCRIPT } from "./player-access.ts";

export type PlayerRecoverySnapshot = {
  href: string;
  current: Record<string, unknown> | null;
  queue: unknown[];
  position: number;
  playing: boolean;
  volume: number;
  mode: string;
};

const PLAYER_READY_ACCESS_SCRIPT = `
  const waitForPlayerReady = async () => {
    const required = ['playing', 'playingList', 'download', 'async:listenTogetherPlayList', 'async:listenTogetherPlayStatus', 'async:cloudList'];
    for (let attempt = 0; attempt < 50; attempt++) {
      const store = findPlayerStore();
      const state = store?.getState();
      if (document.querySelector('#page_pc_mini_bar') && document.querySelector('#btn_pc_minibar_play')
        && state && required.every(key => state[key] != null)) return store;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  };
`;

export const PLAYER_READY_SCRIPT = `(async () => {
  ${PLAYER_ACCESS_SCRIPT}
  ${PLAYER_READY_ACCESS_SCRIPT}
  return Boolean(await waitForPlayerReady());
})()`;

export const PLAYER_RECOVERY_SCRIPT = `(() => {
  const owned = new URL(location.href).searchParams.has('nemusic_view')
    || Boolean(globalThis.__NEMusicOnSteamViewToken || globalThis.__nemusicFullscreenButton || globalThis.__NEMusicOnSteamPlayerStore);
  if (!owned) return null;
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { owned: true, snapshot: null };
  const media = Array.from(document.querySelectorAll('audio, video'));
  for (const howl of globalThis.Howler?._howls || []) {
    for (const sound of howl._sounds || []) {
      if (sound._node) media.push(sound._node);
    }
  }
  for (const element of globalThis.__NEMusicOnSteamMpvMedia?.saved?.keys?.() || []) media.push(element);
  const active = media.find(element => !element.paused && !element.ended)
    || media.find(element => Number(element.currentTime) > 0);
  const progress = document.querySelector('[role="slider"][aria-label="播放进度调节"]');
  const state = playerStore.getState();
  const position = active?.currentTime ?? playing?.restoreResource?.current ?? progress?.getAttribute('aria-valuenow') ?? 0;
  return { owned: true, snapshot: {
    href: location.href,
    current: playing?.curPlaying || null,
    queue: Array.isArray(state.playingList?.curPlayingList) ? state.playingList.curPlayingList : [],
    position: Math.max(0, Number(position) || 0),
    playing: playing?.playingState === 2,
    volume: Number.isFinite(playing?.playingVolume) ? playing.playingVolume : 1,
    mode: playing?.playingMode || 'playOrder',
  } };
})()`;

export const PLAYER_RETIRE_SCRIPT = `(async () => {
  ${PLAYER_ACCESS_SCRIPT}
  globalThis.__NEMusicOnSteamRetired = true;
  if (typeof HTMLMediaElement !== 'undefined') {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (globalThis.__NEMusicOnSteamRetired) return Promise.resolve();
      return play.apply(this, arguments);
    };
  }
  const silence = element => {
    element.muted = true;
    element.volume = 0;
    element.pause?.();
  };
  for (const element of document.querySelectorAll('audio, video')) silence(element);
  for (const howl of globalThis.Howler?._howls || []) {
    for (const sound of howl._sounds || []) {
      if (sound._node) silence(sound._node);
    }
    howl.stop?.();
  }
  for (const element of globalThis.__NEMusicOnSteamMpvMedia?.saved?.keys?.() || []) silence(element);
  if (playerStore) playerStore.dispatch({ type: 'playing/pause' });
  return true;
})()`;

export function playerRestoreScript(snapshot: PlayerRecoverySnapshot): string {
  return `(async () => {
    const snapshot = ${JSON.stringify(snapshot)};
    ${PLAYER_ACCESS_SCRIPT}
    ${PLAYER_READY_ACCESS_SCRIPT}
    const store = await waitForPlayerReady();
    if (!store) throw new Error('网易云页面尚未完成初始化，未恢复播放');
    if (!snapshot.current) return true;
    await store.dispatch({ type: 'playingList/onUpdate', payload: { curPlayingList: snapshot.queue } });
    await store.dispatch({ type: 'playing/onUpdate', payload: { playingMode: snapshot.mode } });
    await store.dispatch({ type: 'playing/setVolume', payload: { volume: snapshot.volume } });
    await store.dispatch({ type: 'playing/setPlaying', payload: {
      trackIn: snapshot.current,
      playingState: snapshot.playing ? 2 : 1,
      noAddToHistory: true,
      isForceSetPlaying: true,
    } });
    const trackId = String(snapshot.current.resourceId || snapshot.current.trackId || snapshot.current.track?.id || '');
    let restored = !snapshot.playing;
    if (!snapshot.playing) await store.dispatch({ type: 'playing/onUpdate', payload: {
      restoreResource: { trackId, current: snapshot.position },
    } });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!snapshot.playing) break;
      const state = store.getState().playing;
      if (String(state.resourceTrackId || '') === trackId && state.resourceDuration > 0) {
        const trialStart = Number(state.freeTrialInfo?.start) || 0;
        await store.dispatch({ type: 'playing/setPlayingPosition', payload: { duration: Math.max(0, snapshot.position - trialStart) } });
        restored = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!restored) throw new Error('网易云未恢复原歌曲，请手动继续播放');
    if (!snapshot.playing) await store.dispatch({ type: 'playing/pause' });
    return true;
  })()`;
}

export const PLAYER_RECOVERY_CHECKPOINT_SCRIPT = `(() => {
  const key = 'nemusic.onsteam.recovery.v1';
  const checkpoint = JSON.parse(localStorage.getItem(key) || 'null');
  if (!checkpoint || Date.now() - checkpoint.savedAt > 300000) return null;
  return checkpoint.snapshot || null;
})()`;

export const PLAYER_RECOVERY_CLEAR_SCRIPT = `(() => {
  localStorage.removeItem('nemusic.onsteam.recovery.v1');
  return true;
})()`;
