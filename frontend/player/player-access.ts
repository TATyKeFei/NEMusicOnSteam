/**
 * 只读脚本，用来查看网易云播放器的页面状态：沿 React fiber 树找到 Redux store、
 * 按标签定位播放控制按钮，以及 MPRIS 桥轮询的完整状态快照。所有需要知道页面在播什么的
 * 桥都会内嵌这些脚本，所以它们和 CDP 通道放在一起，而不是塞在 MPRIS 模块里。
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
  // playingMode 是字符串枚举：playOrder、playRandom、playOneCycle、playCycle、playAi、playFm。
  // 这个播放器里循环和随机并不是两个独立开关，所以它们都映射到这一个值上。
  const MODE_ORDER = 'playOrder';
  const MODE_RANDOM = 'playRandom';
  const MODE_SINGLE = 'playOneCycle';
  const MODE_CYCLE = 'playCycle';
  const currentMode = () => playerStore?.getState()?.playing?.playingMode || '';
  // 模式按钮只能循环切换，所以改用应用自己派发的 action 来切换模式，之后等 store 确认
  // 结果，而不是直接相信请求已经生效。
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

// st/webplayer 的播放控制按钮由 React 组件渲染：上一首和下一首都没有 id，旧的
// .m-playbar 结构也已经不存在了。唯一稳定的抓手是图标的 title 属性，里面带着中文标签
// 和一段快捷键后缀。标签用码点拼写，因为插件打包器会破坏产物中的原始非 ASCII 字符和
// 反斜杠转义。
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
