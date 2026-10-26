/**
 * 歌单智能排序的页内脚本：安装排序按钮、读待播队列、批量取音频地址、按排序结果
 * 重排 Redux 里的 curPlayingList。重排沿用播放器自己的 playingList/onUpdate，
 * 当前正在播的那首永远不动；列表循环停在最后一首时，回绕的开头段按同一次排序重排。
 */
import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

const BUTTON_API_VERSION = 1;
const ICON = '<svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3 5h12v1.8H3V5zm0 6h9v1.8H3V11zm0 6h12v1.8H3V17zm14.6-7.4 3.4 3.4-3.4 3.4-1.27-1.27 1.23-1.23H13v-1.8h5.56l-1.23-1.23 1.27-1.27z"/></svg>';

/** 排序的前提：顺序/列表循环、不在一起听。 */
const QUEUE_GATE = `
  const readQueueGate = () => {
    const state = playerStore?.getState() || {};
    const current = state.playing || {};
    const room = state['async:listenTogether'] || {};
    if (['together', 'togetherOwner'].includes(room.status) || room.roomInfo?.roomId) {
      return { ok: false, reason: '一起听中不能重排播放列表' };
    }
    if (!['playOrder', 'playCycle'].includes(current.playingMode)) {
      return { ok: false, reason: '请先切到顺序或列表循环再排序' };
    }
    return { ok: true };
  };
  const queueIdOf = entry => String(entry?.resourceId || entry?.trackId || entry?.track?.id || entry?.id || '');
  const queueTail = () => {
    const state = playerStore.getState();
    const list = Array.isArray(state.playingList?.curPlayingList) ? state.playingList.curPlayingList : [];
    const current = state.playing || {};
    const from = String(current.resourceTrackId || current.curPlaying?.resourceId || '');
    const index = list.findIndex(entry => queueIdOf(entry) === from);
    // 列表循环停在最后一首时，接下来要听的是列表开头那批（播放器自己会回绕），
    // 它们同样属于待播；其余情况待播只有当前曲之后的部分。
    const wrap = String(current.playingMode || '') === 'playCycle' && list.length > 1 && index === list.length - 1;
    const positions = [];
    for (let position = index + 1; position < list.length; position++) positions.push(position);
    if (wrap) for (let position = 0; position < index; position++) positions.push(position);
    return { list, from, index, wrap, positions };
  };
`;

/** 读待播列表：待播的每一首都带上是否可分析（本地/非歌曲条目保持原位），并回带排队诊断。 */
export const QUEUE_TRACKS_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  ${QUEUE_GATE}
  const gate = readQueueGate();
  if (!gate.ok) return gate;
  const { list, index, wrap, positions } = queueTail();
  const tracks = [];
  for (const position of positions) {
    const entry = list[position];
    if (entry == null || typeof entry !== 'object') continue;
    const track = entry.track || entry.songInfo || entry.song || entry;
    const id = queueIdOf(entry);
    const name = String(track?.name || entry.name || '').trim();
    const artists = track.artists || track.ar || [];
    tracks.push({
      id, name,
      artist: Array.isArray(artists) ? artists.map(item => item?.name).filter(Boolean).join(', ') : '',
      sortable: Boolean(id) && Boolean(name) && (!entry.resourceType || entry.resourceType === 'track'),
    });
  }
  return { ok: true, tracks, index, total: list.length, wrap };
})()`;

/** 一次问网易云要一批歌曲的播放地址（标准音质足够做特征分析）。 */
export function queueUrlsScript(ids: readonly string[]): string {
  return `(async () => {
    const ids = ${JSON.stringify(ids.map(Number).filter(Number.isSafeInteger))};
    if (!ids.length) return {};
    try {
      const query = 'ids=' + encodeURIComponent(JSON.stringify(ids)) + '&level=standard';
      const response = await fetch('/api/song/enhance/player/url/v1?' + query, { credentials: 'include' });
      if (!response.ok) return {};
      const payload = await response.json();
      const urls = {};
      for (const item of payload?.data || []) {
        if (item && typeof item.url === 'string' && item.url.startsWith('http')) urls[String(item.id)] = item.url;
      }
      return urls;
    } catch (error) {
      return {};
    }
  })()`;
}

/** 按给定 id 序列重排待播范围（列表循环回绕时含开头段）；队列中途有变化就放弃，绝不按旧结果硬套。 */
export function queueApplyScript(order: readonly string[], wrap: boolean): string {
  return `(async () => {
    ${PLAYER_ACCESS_SCRIPT}
    ${QUEUE_GATE}
    const gate = readQueueGate();
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const order = ${JSON.stringify(order)};
    const expectedWrap = ${wrap ? "true" : "false"};
    const { list, wrap, positions } = queueTail();
    if (wrap !== expectedWrap) return { ok: false, reason: '播放列表已经变化，请重试' };
    const isObject = item => item != null && typeof item === 'object';
    const tail = positions.map(position => list[position]).filter(isObject);
    if (tail.length !== order.length) return { ok: false, reason: '播放列表已经变化，请重试' };
    const pool = tail.map(entry => ({ entry, id: queueIdOf(entry) }));
    const rebuilt = [];
    for (const id of order) {
      const match = pool.findIndex(item => item.id === id);
      if (match < 0) return { ok: false, reason: '播放列表已经变化，请重试' };
      rebuilt.push(pool.splice(match, 1)[0].entry);
    }
    // 非对象条目（理论上不存在）保留原位，其余按新顺序写回原来的那些位置；
    // 当前正在播的那首不在 positions 里，永远不参与重排。
    const output = list.slice();
    let cursor = 0;
    for (const position of positions) {
      if (isObject(list[position])) output[position] = rebuilt[cursor++];
    }
    await playerStore.dispatch({ type: 'playingList/onUpdate', payload: { curPlayingList: output } });
    return { ok: true, count: rebuilt.length };
  })()`;
}

export function queueSortButtonScript(enabled: boolean): string {
  return `(() => {
    const key = '__nemusicQueueSortButton';
    const version = ${BUTTON_API_VERSION};
    const enabled = ${enabled ? "true" : "false"};
    if (!enabled) {
      try { window[key]?.destroy?.(); } catch (error) {}
      return { installed: false, action: null };
    }
    if (window[key]?.version === version) return window[key].poll();
    try { window[key]?.destroy?.(); } catch (error) {}
    ${PLAYER_ACCESS_SCRIPT}
    ${QUEUE_GATE}
    const api = { version, button: null, pending: null, busy: false, observer: null, timer: 0, retries: 0, scheduled: false, toastTimer: 0, destroyed: false };
    const visible = node => {
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const view = node.ownerDocument?.defaultView;
      for (let ancestor = node; ancestor && view?.getComputedStyle; ancestor = ancestor.parentElement) {
        const style = view.getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      }
      return true;
    };
    const anchor = () => {
      const play = document.querySelector('#btn_pc_minibar_play') || document.querySelector('[aria-label="播放进度调节"]');
      const playRect = play?.getBoundingClientRect();
      const middle = playRect?.height > 0 ? playRect.top + playRect.height / 2 : (window.innerHeight || 0) - 28;
      for (const node of Array.from(document.querySelectorAll('[title],[aria-label],[data-log*="btn_pc_minibar_volume"],[id^="btn_pc_minibar_volume"]'))) {
        const name = (node.getAttribute('title') || '') + ' ' + (node.getAttribute('aria-label') || '');
        if (!/音量|静音|volume|mute/i.test(name) && !String(node.getAttribute('data-log') || node.id || '').includes('btn_pc_minibar_volume')) continue;
        const button = node.closest('button,[role="button"],.cmd-button') || node;
        if (!button.parentElement || !visible(button)) continue;
        const rect = button.getBoundingClientRect();
        if (rect.left < (window.innerWidth || 0) / 2 || Math.abs(rect.top + rect.height / 2 - middle) > 26) continue;
        return button;
      }
      return null;
    };
    const toast = message => {
      window.clearTimeout(api.toastTimer);
      document.querySelector('[data-nemusic-queue-toast]')?.remove();
      const node = document.createElement('div');
      node.setAttribute('data-nemusic-queue-toast', '');
      node.textContent = message;
      node.style.cssText = 'position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483647;padding:8px 18px;border:0;border-radius:0;background:#232b36;color:#dcdedf;font:13px/1.5 system-ui,sans-serif;pointer-events:none;max-width:calc(100vw - 32px);box-sizing:border-box';
      document.body.append(node);
      api.toastTimer = window.setTimeout(() => node.remove(), 3200);
    };
    const refresh = () => {
      if (!api.button) return;
      // 只在真的变化时改属性：这些改动会触发别的按钮脚本的 MutationObserver，
      // 白写一次就多一轮无意义的补挂。
      if (api.button.disabled !== api.busy) api.button.disabled = api.busy;
      const opacity = api.busy ? '0.45' : '0.85';
      if (api.button.style.opacity !== opacity) api.button.style.opacity = opacity;
      const title = api.busy ? '正在分析播放列表…' : '按节奏与调性排序播放列表';
      if (api.button.title !== title) api.button.title = title;
    };
    const ensure = () => {
      if (api.destroyed) return false;
      const volume = anchor();
      if (!volume) {
        api.button?.remove();
        api.button = null;
        return false;
      }
      if (!api.button) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = '按节奏与调性排序播放列表';
        button.setAttribute('aria-label', '排序播放列表');
        button.setAttribute('data-nemusic-queue-sort-button', '1');
        button.innerHTML = ${JSON.stringify(ICON)};
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;margin:0 12px 0 4px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;opacity:.85';
        button.addEventListener('mouseenter', () => { if (!api.busy) button.style.opacity = '1'; });
        button.addEventListener('mouseleave', () => { if (!api.busy) button.style.opacity = '.85'; });
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (api.busy) return;
          const gate = readQueueGate();
          if (!gate.ok) { toast(gate.reason); return; }
          api.busy = true;
          api.pending = 'sort';
          refresh();
        });
        api.button = button;
      }
      // 音质按钮的补挂脚本一直要求自己紧贴音量键左边；如果我们去抢同一个位置，
      // 两个按钮就会每帧互相把对方挤开，点击永远落不到按钮上。所以这里把锚点改成
      // 「音质按钮（没有就音量键）的正左边」，跟着它站位，谁都不用再动。
      const target = document.querySelector('[data-nemusic-quality-button]') || volume;
      if (!api.button.isConnected || api.button.parentElement !== target.parentElement || api.button.nextElementSibling !== target) {
        target.parentElement.insertBefore(api.button, target);
      }
      api.retries = 0;
      refresh();
      return true;
    };
    const schedule = () => {
      if (api.destroyed || api.scheduled) return;
      api.scheduled = true;
      const heal = () => {
        api.scheduled = false;
        if (api.destroyed || ensure() || api.retries >= 24) return;
        api.retries += 1;
        schedule();
      };
      if (api.retries < 16 && window.requestAnimationFrame) window.requestAnimationFrame(heal);
      else api.timer = window.setTimeout(heal, api.retries < 16 ? 0 : 200);
    };
    api.poll = () => {
      if (!ensure()) schedule();
      const action = api.pending;
      api.pending = null;
      return { installed: true, action };
    };
    api.status = message => { if (!api.destroyed) toast(message); };
    api.complete = message => {
      api.busy = false;
      refresh();
      if (message) toast(message);
    };
    api.destroy = () => {
      api.destroyed = true;
      api.button?.remove();
      api.button = null;
      api.observer?.disconnect();
      window.clearTimeout(api.timer);
      window.clearTimeout(api.toastTimer);
      document.querySelector('[data-nemusic-queue-toast]')?.remove();
      window.removeEventListener('resize', schedule);
    };
    api.observer = new MutationObserver(() => {
      if (api.destroyed) return;
      api.retries = 0;
      schedule();
    });
    api.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    window[key] = api;
    return api.poll();
  })()`;
}

export function queueSortButtonUpdateScript(enabled: boolean): string {
  return `(() => {
    const enabled = ${enabled ? "true" : "false"};
    const api = window.__nemusicQueueSortButton;
    if (!enabled) {
      try { api?.destroy?.(); } catch (error) {}
      return { installed: false, action: null };
    }
    return api?.version === ${BUTTON_API_VERSION} ? api.poll() : { installed: false, action: null };
  })()`;
}

export function queueSortButtonStatusScript(message: string): string {
  return `(() => { window.__nemusicQueueSortButton?.status?.(${JSON.stringify(message)}); return true; })()`;
}

export function queueSortButtonResultScript(message: string): string {
  return `(() => { window.__nemusicQueueSortButton?.complete?.(${JSON.stringify(message)}); return true; })()`;
}
