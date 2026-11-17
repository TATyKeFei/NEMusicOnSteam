import { PLAYER_ACCESS_SCRIPT, TRANSPORT_SCRIPT } from "./player-access.ts";

export type PlayerCapabilities = {
  playback: boolean; queue: boolean; quality: boolean; together: boolean | null; download: boolean;
};
export const CAPABILITY_LABELS: Record<keyof PlayerCapabilities, string> = {
  playback: "播放控制", queue: "播放队列", quality: "音质", together: "一起听", download: "下载解析",
};
export const CAPABILITIES_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  ${TRANSPORT_SCRIPT}
  if (!playerStore || !playing) return null;
  const state = playerStore.getState();
  return {
    playback: typeof playerStore.dispatch === 'function' && 'playingVolume' in playing,
    queue: Array.isArray(state.playingList?.curPlayingList) || [playing.playingList, playing.playList, playing.list].some(Array.isArray),
    quality: Boolean(state.setting?.quantity && state.host),
    together: state['async:listenTogether'] ? true : null,
    download: typeof fetch === 'function' && typeof playerStore.dispatch === 'function',
  };
})()`;
