/**
 * 代表 MPRIS 操作网易云播放器的页面脚本：抓取歌词、下发播放指令。
 * 只读的状态脚本（store 访问、播放控件定位、快照）在 ../player/player-access.ts。
 */
import { PLAYER_ACCESS_SCRIPT, TRANSPORT_SCRIPT } from "../player/player-access.ts";

export type Command = { action: string; value?: number | string | boolean };

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
        // 关闭随机播放不能顺带取消客户端之前要求的循环模式。
        if (command.value !== true && currentMode() !== MODE_RANDOM) return true;
        return setPlayingMode(command.value === true ? MODE_RANDOM : MODE_ORDER);
      }
      case 'loop': {
        const target = command.value === 'Track' ? MODE_SINGLE : command.value === 'Playlist' ? MODE_CYCLE : command.value === 'None' ? MODE_ORDER : null;
        if (!target) return false;
        // LoopStatus 为 None 只是清除循环模式；顺序和随机播放本来就不算循环。
        if (target === MODE_ORDER && currentMode() !== MODE_SINGLE && currentMode() !== MODE_CYCLE) return true;
        return setPlayingMode(target);
      }
      case 'seek': return Number.isFinite(command.value) && playerControl.seek(currentPosition + command.value / 1000000);
      case 'setposition': return Number.isFinite(command.value) && playerControl.seek(command.value / 1000000);
    }
    return false;
  })()`;
}
