export type Command = { action: string; value?: number };

export const PLAYER_ACCESS_SCRIPT = `
  const findPlayerStore = () => {
    const seeds = document.querySelectorAll('#btn_pc_minibar_play, [aria-label="播放进度调节"], #root > *');
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
          if (playing && ('playingVolume' in playing || 'resourceDuration' in playing)) return store;
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
`;

export const SNAPSHOT_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
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
  const position = progress?.max ? Math.max(0, Math.min(duration, progress.value)) : Number.isFinite(media?.currentTime) ? media.currentTime : pagePosition;
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="next"], [class*="prev"], [class*="ply"], [class*="prv"], [class*="nxt"]')).map(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.className].filter(value => typeof value === 'string').join(' ').toLowerCase());
  const volumeSlider = slider('音量调节');
  const volumeState = sliderValue(sliderHandle('音量调节')) || sliderValue(volumeSlider);
  const volume = Number.isFinite(playing?.playingVolume) ? Math.max(0, Math.min(1, playing.playingVolume)) : volumeState?.max ? Math.max(0, Math.min(1, volumeState.value / volumeState.max)) : null;
  const sessionState = navigator.mediaSession?.playbackState;
  const playControl = visible('#btn_pc_minibar_play, .m-playbar .ply, .m-playbar .pas');
  const controlClass = String(playControl?.className || '');
  const isPlayingButton = playControl?.classList.contains('play-pause-btn') || /\\bpas\\b/.test(controlClass) || /暂停|pause/.test(playControl?.querySelector('[title]')?.getAttribute('title') || '');
  const playbackStatus = media ? (media.ended ? 'Stopped' : media.paused ? 'Paused' : 'Playing') : playControl ? (isPlayingButton ? 'Playing' : 'Paused') : sessionState === 'playing' ? 'Playing' : sessionState === 'paused' ? 'Paused' : title ? 'Playing' : 'Stopped';
  return { active: Boolean(title || artist || media || progressSlider), playbackStatus, title, artist, album, artUrl, trackId: [title, artist, album].join('|'), duration, position, canSeek: Boolean(playerStore && playing?.resourceTrackId && duration > 0), canGoNext: Boolean(visible('#btn_pc_next')) || controls.some(label => /下一首|下一曲|next|\\bnxt\\b/.test(label)), canGoPrevious: Boolean(visible('#btn_pc_previous')) || controls.some(label => /上一首|上一曲|prev|\\bprv\\b/.test(label)), volume };
})()`;

export function commandScript(command: Command): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    const command = ${JSON.stringify(command)};
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
    const playButton = visible('#btn_pc_minibar_play');
    const playButtonIsPlaying = playButton?.classList.contains('play-pause-btn') || /暂停|pause/.test(playButton?.querySelector('[title]')?.getAttribute('title') || '');
    const mediaCandidates = Array.from(document.querySelectorAll('audio, video'));
    const mediaScore = media => {
      const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      const position = Number.isFinite(media.currentTime) && media.currentTime > 0 ? media.currentTime : 0;
      return (media.paused ? 0 : 1000000000) + (position > 0 ? 100000000 : 0) + (media.readyState > 0 ? 10000000 : 0) + duration;
    };
    const media = mediaCandidates.sort((left, right) => mediaScore(right) - mediaScore(left))[0] || null;
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="next"], [class*="prev"], [class*="ply"], [class*="prv"], [class*="nxt"]'));
    const button = (words, excluded = []) => controls.find(element => {
      const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.className].filter(value => typeof value === 'string').join(' ').toLowerCase();
      return words.some(word => label.includes(word)) && !excluded.some(word => label.includes(word));
    });
    const click = (words, excluded = []) => { const element = button(words, excluded); if (element) element.click(); return !!element; };
    const clickSelector = selector => { const element = visible(selector); if (element) { element.click(); return true; } return false; };
    const pageClocks = () => Array.from(document.querySelectorAll('.m-pbar .time em, .m-pbar .time span')).flatMap(element => Array.from(String(element.textContent || '').matchAll(/(\\d{1,3}):([0-5]\\d)/g)).map(match => Number(match[1]) * 60 + Number(match[2])));
    const pagePosition = pageClocks()[0] || 0;
    const progressSlider = slider('播放进度调节');
    const progress = sliderValue(sliderHandle('播放进度调节')) || sliderValue(progressSlider);
    const currentPosition = progress?.max ? progress.value : Number.isFinite(media?.currentTime) ? media.currentTime : pagePosition;
    switch (command.action) {
      case 'play': if (playButton && !playButtonIsPlaying) return clickSelector('#btn_pc_minibar_play'); if (!playButton && click(['播放', 'play', 'ply'], ['下一', 'next', 'nxt', 'pas'])) return true; if (!playButton && media?.paused) { media.play(); return true; } return false;
      case 'pause': if (playButton && playButtonIsPlaying) return clickSelector('#btn_pc_minibar_play'); if (!playButton && click(['暂停', 'pause', 'pas'], ['下一', 'next', 'nxt', 'ply'])) return true; if (!playButton && media && !media.paused) { media.pause(); return true; } return false;
      case 'playpause': if (playButton) return clickSelector('#btn_pc_minibar_play'); if (media && !media.paused) { media.pause(); return true; } if (media?.paused) { media.play(); return true; } return click(['播放', '暂停', 'play', 'pause']);
      case 'stop': { const paused = playButton && playButtonIsPlaying ? clickSelector('#btn_pc_minibar_play') : !playButton && media ? (media.pause(), true) : false; if (await playerControl.seek(0)) return true; return paused; }
      case 'next': return clickSelector('#btn_pc_next') || click(['下一首', '下一曲', 'next', 'nxt']);
      case 'previous': return clickSelector('#btn_pc_previous') || click(['上一首', '上一曲', 'previous', 'prev', 'prv']);
      case 'volume': return Number.isFinite(command.value) && playerControl.volume(command.value);
      case 'seek': return Number.isFinite(command.value) && playerControl.seek(currentPosition + command.value / 1000000);
      case 'setposition': return Number.isFinite(command.value) && playerControl.seek(command.value / 1000000);
    }
    return false;
  })()`;
}
