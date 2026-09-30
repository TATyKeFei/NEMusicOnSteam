export type Command = { action: string; value?: number | string | boolean };

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

export const LYRICS_SCRIPT = `(async () => {
  ${PLAYER_ACCESS_SCRIPT}
  const limitBytes = text => {
    const value = String(text || '').trim();
    const encoder = new TextEncoder();
    let bytes = 0;
    let end = 0;
    for (const character of value) {
      const size = encoder.encode(character).length;
      if (bytes + size > 32768) break;
      bytes += size;
      end += character.length;
    }
    return value.slice(0, end);
  };
  const timestampPattern = /^\\[(\\d{1,3}):([0-5]\\d)(?:[.:](\\d{1,3}))?\\](.*)$/;
  const parseLrc = value => {
    const lines = [];
    for (const raw of String(value || '').split('\\n')) {
      const match = timestampPattern.exec(raw.trim());
      if (!match) continue;
      const text = match[4].replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      lines.push({
        at: Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || '0').padEnd(3, '0').slice(0, 3)),
        text,
      });
    }
    return lines;
  };
  const mergeLyrics = (original, translation) => {
    const translated = new Map();
    for (const line of parseLrc(translation)) {
      if (!translated.has(line.at)) translated.set(line.at, line.text);
    }
    const output = [];
    const push = text => { if (output[output.length - 1] !== text) output.push(text); };
    for (const line of parseLrc(original)) {
      push(line.text);
      const second = translated.get(line.at);
      if (second) push(second);
    }
    return output.join('\\n');
  };
  const fromDom = () => {
    const visible = element => {
      if (!element || element.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll('.m-lycifo__content, .lyric-content, [class*="lyric-content"], [class*="lyricContent"]'))
      .filter(visible)
      .sort((left, right) => (right.textContent || '').length - (left.textContent || '').length);
    const root = roots[0];
    if (!root) return '';
    const lineNodes = Array.from(root.querySelectorAll('li, p, [data-time]')).filter(visible);
    const source = lineNodes.length > 1 ? lineNodes.map(node => node.textContent || '') : [root.textContent || ''];
    const lines = [];
    for (const value of source) {
      const line = value.replace(/\\s+/g, ' ').trim();
      if (line && lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines.join('\\n');
  };
  const rawId = playing?.resourceTrackId || playing?.curPlaying?.resourceId;
  const songId = String(rawId || '').match(/\\d+/)?.[0];
  let answered = false;
  let lyric = '';
  if (songId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch('/api/song/lyric?id=' + encodeURIComponent(songId) + '&lv=-1&tv=-1&os=pc', {
        credentials: 'include',
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        answered = true;
        if (!payload?.uncollected && !payload?.nolyric) lyric = mergeLyrics(payload?.lrc?.lyric, payload?.tlyric?.lyric);
      }
    } catch {}
    finally { clearTimeout(timeout); }
  }
  if (lyric.trim()) return { lyric: limitBytes(lyric), resolved: true };
  const fallback = fromDom();
  if (fallback.trim()) return { lyric: limitBytes(fallback), resolved: true };
  return { lyric: '', resolved: answered };
})()`;

export function commandScript(command: Command): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    ${TRANSPORT_SCRIPT}
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
      case 'next': return clickControl(NEXT_LABELS) || clickSelector('#btn_pc_next');
      case 'previous': return clickControl(PREV_LABELS) || clickSelector('#btn_pc_previous');
      case 'volume': return Number.isFinite(command.value) && playerControl.volume(command.value);
      case 'rate': if (media && Number.isFinite(command.value) && command.value > 0) { media.playbackRate = command.value; return true; } return false;
      case 'shuffle': {
        // Clearing shuffle must not undo a loop the client asked for earlier.
        if (command.value !== true && currentMode() !== MODE_RANDOM) return true;
        return setPlayingMode(command.value === true ? MODE_RANDOM : MODE_ORDER);
      }
      case 'loop': {
        const target = command.value === 'Track' ? MODE_SINGLE : command.value === 'Playlist' ? MODE_CYCLE : command.value === 'None' ? MODE_ORDER : null;
        if (!target) return false;
        // LoopStatus None only clears a loop mode; order and random playback are already unlooped.
        if (target === MODE_ORDER && currentMode() !== MODE_SINGLE && currentMode() !== MODE_CYCLE) return true;
        return setPlayingMode(target);
      }
      case 'seek': return Number.isFinite(command.value) && playerControl.seek(currentPosition + command.value / 1000000);
      case 'setposition': return Number.isFinite(command.value) && playerControl.seek(command.value / 1000000);
    }
    return false;
  })()`;
}
