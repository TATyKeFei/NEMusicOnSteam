/**
 * Read-only scripts for inspecting the NetEase player page: finding the Redux store through
 * the React fiber tree, locating the transport buttons by their labels, and the full state
 * snapshot the MPRIS bridge polls. Every bridge that needs to see what the page is playing
 * embeds these, so they live beside the CDP channel instead of inside the MPRIS module.
 */
export const PLAYER_ACCESS_SCRIPT = `
  const findPlayerStore = () => {
    const seeds = document.querySelectorAll('#btn_pc_minibar_play, [aria-label="播放进度调节"], #root > *');
    const cached = globalThis.__NEMusicOnSteamPlayerStore;
    if (seeds.length && cached && typeof cached.getState === 'function' && typeof cached.dispatch === 'function') {
      const playing = cached.getState()?.playing;
      if (playing && ('playingVolume' in playing || 'resourceDuration' in playing)) return cached;
    }
    for (const element of seeds) {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      let fiber = key ? element[key] : null;
      const visited = new Set();
      while (fiber && !visited.has(fiber)) {
        visited.add(fiber);
        const candidates = [fiber.memoizedProps?.store, fiber.memoizedProps?.value?.store];
        let context = fiber.dependencies?.firstContext;
        while (context) {
          candidates.push(context.memoizedValue?.store);
          context = context.next;
        }
        for (const store of candidates) {
          if (typeof store?.getState !== 'function' || typeof store?.dispatch !== 'function') continue;
          const playing = store.getState()?.playing;
          if (playing && ('playingVolume' in playing || 'resourceDuration' in playing)) {
            globalThis.__NEMusicOnSteamPlayerStore = store;
            return store;
          }
        }
        fiber = fiber.return;
      }
    }
    return null;
  };
  const playerStore = findPlayerStore();
  const playing = playerStore?.getState()?.playing;
  const playerControl = {
    async volume(value) {
      if (!playerStore || !Number.isFinite(value)) return false;
      await playerStore.dispatch({ type: 'playing/setVolume', payload: { volume: Math.max(0, Math.min(1, value)) } });
      return true;
    },
    async seek(position) {
      const state = playerStore?.getState()?.playing;
      if (!state?.resourceTrackId || !Number.isFinite(position) || !(state.resourceDuration > 0)) return false;
      const trialStart = Number(state.freeTrialInfo?.start) || 0;
      const trialEnd = Number(state.freeTrialInfo?.end);
      const upper = Number.isFinite(trialEnd) && trialEnd > trialStart ? Math.min(state.resourceDuration, trialEnd) : state.resourceDuration;
      const target = Math.max(trialStart, Math.min(upper, position));
      await playerStore.dispatch({ type: 'playing/setPlayingPosition', payload: { duration: target - trialStart } });
      return true;
    },
  };
  // playingMode is a string enum: playOrder, playRandom, playOneCycle, playCycle, playAi, playFm.
  // Loop and shuffle are not separate switches in this player, so they all map onto that one value.
  const MODE_ORDER = 'playOrder';
  const MODE_RANDOM = 'playRandom';
  const MODE_SINGLE = 'playOneCycle';
  const MODE_CYCLE = 'playCycle';
  const currentMode = () => playerStore?.getState()?.playing?.playingMode || '';
  // The mode button only cycles, so switch modes through the action the application itself
  // dispatches, then wait for the store to confirm rather than trusting the request.
  const setPlayingMode = async mode => {
    if (!playerStore || !mode) return false;
    if (currentMode() === mode) return true;
    playerStore.dispatch({ type: 'playing/switchPlayingMode', payload: { playingMode: mode, triggerScene: 'miniBar', HeartBeatFlage: false } });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (currentMode() === mode) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
`;

// The st/webplayer transport buttons render from React components: neither previous nor next has
// an id, and the old .m-playbar markup is gone. The stable hook left is the icon's title
// attribute, which carries the Chinese label plus a shortcut suffix. Labels are spelled as code
// points because the plugin packer corrupts raw non-ASCII and backslash escapes in the bundle.
export const TRANSPORT_SCRIPT = `
  const NEXT_LABELS = [String.fromCharCode(0x4e0b, 0x4e00, 0x9996), String.fromCharCode(0x4e0b, 0x4e00, 0x66f2)];
  const PREV_LABELS = [String.fromCharCode(0x4e0a, 0x4e00, 0x9996), String.fromCharCode(0x4e0a, 0x4e00, 0x66f2)];
  const findControl = labels => {
    for (const root of [document.querySelector('#page_pc_mini_bar'), document]) {
      if (!root) continue;
      for (const prefix of labels) {
        const match = root.querySelector('[title^="' + prefix + '"]');
        if (match) return match;
      }
    }
    return null;
  };
  const isDisabled = element => {
    for (let node = element; node; node = node.parentElement) {
      if (node.getAttribute?.('aria-disabled') === 'true') return true;
      if ('disabled' in node && node.disabled) return true;
      if (/\\bdisabled\\b/.test(String(node.className || ''))) return true;
    }
    return false;
  };
  const clickControl = labels => {
    const control = findControl(labels);
    if (!control || isDisabled(control)) return false;
    control.click();
    return true;
  };
`;

export const SNAPSHOT_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  ${TRANSPORT_SCRIPT}
  const visible = selector => Array.from(document.querySelectorAll(selector)).find(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }) || null;
  const slider = label => visible('[aria-label="' + label + '"], [aria-label*="' + label + '"]');
  const sliderHandle = label => visible('[role="slider"][aria-label="' + label + '"], [role="slider"][aria-label*="' + label + '"]');
  const sliderValue = element => {
    const input = element?.matches('input') ? element : element?.querySelector('input');
    const source = input || element;
    const value = Number(source?.getAttribute('aria-valuenow') ?? source?.value);
    const max = Number(source?.getAttribute('aria-valuemax') ?? source?.max);
    return Number.isFinite(value) ? { value, max: Number.isFinite(max) && max > 0 ? max : null } : null;
  };
  const mediaCandidates = Array.from(document.querySelectorAll('audio, video'));
  const mediaScore = media => {
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    const position = Number.isFinite(media.currentTime) && media.currentTime > 0 ? media.currentTime : 0;
    return (media.paused ? 0 : 1000000000) + (position > 0 ? 100000000 : 0) + (media.readyState > 0 ? 10000000 : 0) + duration;
  };
  const media = mediaCandidates.sort((left, right) => mediaScore(right) - mediaScore(left))[0] || null;
  const metadata = navigator.mediaSession?.metadata;
  const text = selectors => document.querySelector(selectors)?.textContent?.trim() || '';
  const title = metadata?.title || text('.m-playbar .words .name, [class*="song-name"], [class*="songName"], [class*="SongName"]');
  const artist = metadata?.artist || text('.m-playbar .words .by a, [class*="artist-name"], [class*="artistName"]');
  const album = metadata?.album || '';
  const artUrl = metadata?.artwork?.at(-1)?.src || playing?.resourceCoverUrl || document.querySelector('.m-playbar .head img')?.src || '';
  const progressSlider = slider('播放进度调节');
  const progress = sliderValue(sliderHandle('播放进度调节')) || sliderValue(progressSlider);
  const mediaDuration = Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : 0;
  const parseClocks = value => Array.from(String(value || '').matchAll(/(\\d{1,3}):([0-5]\\d)/g)).map(match => Number(match[1]) * 60 + Number(match[2]));
  const timeValues = Array.from(document.querySelectorAll('.m-pbar .time em, .m-pbar .time span')).flatMap(element => parseClocks(element.textContent));
  const pagePosition = timeValues[0] || 0;
  const pageDuration = timeValues.at(-1) || 0;
  const duration = playing?.resourceDuration || progress?.max || pageDuration || mediaDuration;
  const mediaPosition = Number.isFinite(media?.currentTime) && (media?.readyState || 0) > 0 ? media.currentTime : null;
  const position = mediaPosition !== null ? Math.max(0, Math.min(duration, mediaPosition)) : progress?.max ? Math.max(0, Math.min(duration, progress.value)) : pagePosition;
  const mode = currentMode();
  const loopStatus = mode === MODE_SINGLE ? 'Track' : mode === MODE_CYCLE ? 'Playlist' : 'None';
  const shuffle = mode === MODE_RANDOM;
  const rate = Number(media?.playbackRate) > 0 ? Number(media.playbackRate) : 1;
  const volumeSlider = slider('音量调节');
  const volumeState = sliderValue(sliderHandle('音量调节')) || sliderValue(volumeSlider);
  const volume = Number.isFinite(playing?.playingVolume) ? Math.max(0, Math.min(1, playing.playingVolume)) : volumeState?.max ? Math.max(0, Math.min(1, volumeState.value / volumeState.max)) : null;
  const sessionState = navigator.mediaSession?.playbackState;
  const playControl = visible('#btn_pc_minibar_play, .m-playbar .ply, .m-playbar .pas');
  const controlClass = String(playControl?.className || '');
  const isPlayingButton = playControl?.classList.contains('play-pause-btn') || /\\bpas\\b/.test(controlClass) || /暂停|pause/.test(playControl?.querySelector('[title]')?.getAttribute('title') || '');
  const playbackStatus = media ? (media.ended ? 'Stopped' : media.paused ? 'Paused' : 'Playing') : playControl ? (isPlayingButton ? 'Playing' : 'Paused') : sessionState === 'playing' ? 'Playing' : sessionState === 'paused' ? 'Paused' : title ? 'Playing' : 'Stopped';
  const nextControl = findControl(NEXT_LABELS);
  const previousControl = findControl(PREV_LABELS);
  return { active: Boolean(title || artist || media || progressSlider), playbackStatus, title, artist, album, artUrl, trackId: [title, artist, album].join('|'), duration, position, canSeek: Boolean(playerStore && playing?.resourceTrackId && duration > 0), canGoNext: Boolean(nextControl) && !isDisabled(nextControl), canGoPrevious: Boolean(previousControl) && !isDisabled(previousControl), volume, loopStatus, shuffle, rate };
})()`;
