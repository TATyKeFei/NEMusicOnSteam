import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

export function sleepGuardScript(trackId: string | null): string {
  return `(() => {
    const key = '__NEMusicOnSteamSleepGuard';
    globalThis[key]?.destroy();
    if (${JSON.stringify(trackId)} === null || typeof HTMLMediaElement === 'undefined') return true;
    ${PLAYER_ACCESS_SCRIPT}
    if (!playerStore) return false;
    const original = HTMLMediaElement.prototype.play;
    const api = { active: true, finished: false, nodes: new Set() };
    const ended = () => { api.finished = true; playerStore?.dispatch({ type: 'playing/pause' }); };
    const watch = node => { if (!api.nodes.has(node)) { api.nodes.add(node); node.addEventListener('ended', ended, true); } };
    const guarded = function() {
      if (!api.active) return original.apply(this, arguments);
      const current = String(playerStore?.getState()?.playing?.resourceTrackId || '');
      if (api.finished || current !== ${JSON.stringify(trackId)}) {
        playerStore?.dispatch({ type: 'playing/pause' });
        return Promise.resolve();
      }
      watch(this);
      return original.apply(this, arguments);
    };
    HTMLMediaElement.prototype.play = guarded;
    for (const node of document.querySelectorAll('audio, video')) watch(node);
    for (const howl of globalThis.Howler?._howls || []) for (const sound of howl._sounds || []) if (sound._node) watch(sound._node);
    api.destroy = () => {
      api.active = false;
      if (HTMLMediaElement.prototype.play === guarded) HTMLMediaElement.prototype.play = original;
      for (const node of api.nodes) node.removeEventListener('ended', ended, true);
      delete globalThis[key];
    };
    globalThis[key] = api;
    return true;
  })()`;
}
