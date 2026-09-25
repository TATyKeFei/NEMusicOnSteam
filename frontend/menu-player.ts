/**
 * Runs inside the NetEase page (not the Steam window) to add a 下载 item to the song "···" menu.
 * The menu is React-rendered third-party DOM, so every step is defensive: when a menu or a song
 * cannot be identified we inject nothing instead of guessing, and the reason surfaces in the
 * plugin settings so a NetEase redesign is visible rather than silent.
 */

/**
 * DOM-free helpers. Self-invoking so `node:vm` can hand them plain objects and assert on the
 * song that would be picked.
 */
export const MENU_HELPERS_SCRIPT = `(() => {
  const ARTIST_KEYS = ['ar', 'artists', 'singer', 'singers'];
  const ALBUM_KEYS = ['al', 'album'];
  const DURATION_KEYS = ['dt', 'duration', 'durationMs', 'interval'];

  const artistNames = value => {
    for (const key of ARTIST_KEYS) {
      const list = value?.[key];
      if (!Array.isArray(list)) continue;
      return list
        .map(entry => (typeof entry === 'string' ? entry : entry?.name))
        .filter(name => typeof name === 'string' && name.trim())
        .join(', ');
    }
    return '';
  };

  /** A track row, not a playlist or album header: needs a real id, a name, and track-only fields. */
  const asSong = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = Number(value.id ?? value.songId ?? value.trackId ?? value.resourceId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name) return null;
    const trackish = ARTIST_KEYS.some(key => Array.isArray(value[key]) && value[key].length > 0)
      || ALBUM_KEYS.some(key => value[key] && typeof value[key] === 'object')
      || DURATION_KEYS.some(key => Number(value[key]) > 0);
    if (!trackish) return null;
    return { id, name, artist: artistNames(value) };
  };

  const NESTED_KEYS = ['song', 'track', 'item', 'record', 'detail', 'info', 'data', 'props', 'payload'];
  const MAX_DEPTH = 4;

  /**
   * Walks named keys only. Never descends into arrays: the first element of a list prop is a
   * different song, and downloading the wrong file is worse than downloading nothing.
   */
  const findSongFromProps = props => {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
    const direct = asSong(props);
    if (direct) return direct;
    const visited = new Set([props]);
    const queue = [[props, 0]];
    while (queue.length > 0) {
      const [current, depth] = queue.shift();
      if (depth >= MAX_DEPTH) continue;
      for (const key of NESTED_KEYS) {
        const value = current?.[key];
        if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) continue;
        visited.add(value);
        const song = asSong(value);
        if (song) return song;
        queue.push([value, depth + 1]);
      }
    }
    return null;
  };

  return { asSong, findSongFromProps, artistNames };
})()`;

/**
 * Function expression that installs the scanner and is idempotent, so the frontend can just call
 * it on every tick: after a page reload the global is gone and it installs itself again.
 */
const MENU_INSTALL = `() => {
  const helpers = ${MENU_HELPERS_SCRIPT};
  const KEY = '__nemusicDownload';
  const VERSION = 1;
  const ITEM = '下载';
  const SCAN_MS = 300;
  const CLICK_WINDOW_MS = 4000;
  const EXAMINE_LIMIT = 400;
  const ITEM_SELECTOR = 'li, a, button, div, span, [role="menuitem"]';
  const ROOT_SELECTORS = ['[role="menu"]', '[class*="menu"]', '[class*="popup"]', '[class*="dropdown"]', '[class*="layer"]'];
  const EXACT_LABELS = ['播放', '下一首播放', '收藏', '分享', '复制链接', '从歌单中删除'];
  const PREFIX_LABELS = ['查看评论'];
  const SONG_MARKERS = ['下一首播放', '收藏', '分享', '复制链接', '查看评论'];
  const CLONE_PREFERENCE = ['复制链接', '收藏', '分享', '下一首播放'];

  const current = window[KEY];
  if (current && current.version === VERSION) return { installed: true, menus: current.menus, songs: current.songs };

  const api = current || { version: VERSION, menus: 0, songs: 0, pending: [], seen: new WeakSet(), lastClick: null, timer: 0, toastTimer: 0 };

  const text = element => String(element?.textContent || '').replace(/\\s+/g, '');

  const labelOf = content => {
    if (EXACT_LABELS.includes(content)) return content;
    return PREFIX_LABELS.find(label => content.startsWith(label) && content.length <= 12) || '';
  };

  const visible = element => {
    if (!element || !element.isConnected) return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (error) {
      return false;
    }
  };

  const fiberOf = element => {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    return key ? element[key] : null;
  };

  /** Row components hold the song in their props, so the clicked node is the best lead. */
  const songFromNode = node => {
    let element = node && node.nodeType === 1 ? node : null;
    for (let hops = 0; element && hops < 12; element = element.parentElement, hops++) {
      let fiber = fiberOf(element);
      const visited = new Set();
      let depth = 0;
      while (fiber && !visited.has(fiber) && depth++ < 30) {
        visited.add(fiber);
        const song = helpers.findSongFromProps(fiber.memoizedProps);
        if (song) return song;
        fiber = fiber.return;
      }
    }
    return null;
  };

  const itemsIn = root => {
    const items = [];
    let examined = 0;
    for (const element of root.querySelectorAll(ITEM_SELECTOR)) {
      if (++examined > EXAMINE_LIMIT) return [];
      const content = text(element);
      if (!content || content.length > 20 || !labelOf(content)) continue;
      if (text(element.parentElement) === content) continue;
      if (!visible(element)) continue;
      items.push(element);
    }
    return items;
  };

  /** Class names are hashed, so also look next to the click and at body-level portal children. */
  const rootsNear = clicked => {
    const roots = new Set();
    for (const child of document.body.children) roots.add(child);
    for (const selector of ROOT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) roots.add(element);
    }
    let element = clicked && clicked.nodeType === 1 ? clicked : null;
    for (let hops = 0; element && hops < 8; element = element.parentElement, hops++) {
      roots.add(element);
      const parent = element.parentElement;
      if (!parent) continue;
      roots.add(parent);
      let siblings = 0;
      for (const sibling of parent.children) {
        if (++siblings > 12) break;
        roots.add(sibling);
      }
    }
    roots.delete(document.body);
    roots.delete(document.documentElement);
    return roots;
  };

  const toast = message => {
    let box = document.getElementById('nemusic-download-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nemusic-download-toast';
      box.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;max-width:70vw;padding:9px 16px;border-radius:6px;background:rgba(22,22,28,.92);color:#fff;font:14px/20px "Microsoft YaHei",Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;text-align:center;';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.display = 'block';
    clearTimeout(api.toastTimer);
    api.toastTimer = setTimeout(() => { box.style.display = 'none'; }, 5000);
  };

  /** Clone a sibling item so the label matches the native menu, then swap its text. */
  const inject = (source, parent, song) => {
    let item = null;
    try {
      item = source.cloneNode(true);
    } catch (error) {
      item = null;
    }
    if (item) {
      const label = text(source);
      const labelNode = Array.from(item.querySelectorAll('*')).reverse().find(node => node.children.length === 0 && text(node) === label);
      if (labelNode) labelNode.textContent = ITEM;
      else item.textContent = ITEM;
      for (const icon of item.querySelectorAll('svg, img, i, use, [class*="icon"], [class*="Icon"]')) icon.style.display = 'none';
    } else {
      item = document.createElement('div');
      const style = getComputedStyle(source);
      item.style.cssText = 'cursor:pointer;padding:' + style.padding + ';font:' + style.font + ';color:' + style.color + ';line-height:' + style.lineHeight + ';';
      item.textContent = ITEM;
    }
    item.setAttribute('data-nemusic-download', '1');
    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      api.pending.push({ id: song.id, name: song.name, artist: song.artist });
      toast('正在准备下载 ' + (song.artist ? song.artist + ' - ' : '') + song.name);
    });
    if (source.parentElement !== parent) return false;
    parent.insertBefore(item, source.nextElementSibling);
    return true;
  };

  const scan = () => {
    const clicked = api.lastClick;
    if (!clicked || Date.now() - clicked.at > CLICK_WINDOW_MS) return;
    for (const root of rootsNear(clicked.node)) {
      if (!visible(root)) continue;
      const groups = new Map();
      for (const item of itemsIn(root)) {
        const parent = item.parentElement;
        if (!parent) continue;
        const group = groups.get(parent) || [];
        group.push(item);
        groups.set(parent, group);
      }
      for (const [parent, items] of groups) {
        if (items.length < 2) continue;
        const markers = items.map(item => labelOf(text(item))).filter(label => SONG_MARKERS.includes(label));
        if (markers.length < 2) continue;
        if (!api.seen.has(parent)) {
          api.seen.add(parent);
          api.menus += 1;
        }
        if (parent.querySelector('[data-nemusic-download]')) continue;
        const song = songFromNode(clicked.node) || songFromNode(parent);
        if (!song) continue;
        const source = CLONE_PREFERENCE.map(label => items.find(item => text(item) === label)).find(Boolean) || items[0];
        if (!inject(source, parent, song)) continue;
        api.songs += 1;
        return;
      }
    }
  };

  api.take = () => api.pending.splice(0, api.pending.length);
  api.toast = toast;
  window[KEY] = api;
  document.addEventListener('click', event => { api.lastClick = { node: event.target, at: Date.now() }; }, true);
  if (!api.timer) api.timer = setInterval(scan, SCAN_MS);
  return { installed: true, menus: api.menus, songs: api.songs };
}`;

/** One round trip: installs if needed and drains whatever the user asked for. */
export const MENU_TICK_SCRIPT = `(() => {
  let status = null;
  try {
    status = (${MENU_INSTALL})();
  } catch (error) {
    return { installed: false, menus: 0, songs: 0, pending: [], error: String((error && error.message) || error) };
  }
  const api = window.__nemusicDownload;
  const pending = api && typeof api.take === 'function' ? api.take() : [];
  return {
    installed: Boolean(status && status.installed),
    menus: (status && status.menus) || 0,
    songs: (status && status.songs) || 0,
    pending,
  };
})()`;

/** Lets the frontend report progress and failures where the user is actually looking. */
export function menuToastScript(message: string): string {
  return `(() => {
    const api = window.__nemusicDownload;
    if (!api || typeof api.toast !== 'function') return false;
    api.toast(${JSON.stringify(message)});
    return true;
  })()`;
}
