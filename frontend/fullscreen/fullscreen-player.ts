/** 注入网易云网页搜索框右侧的桌面全屏按钮。 */
const FULLSCREEN_BUTTON_API_VERSION = 3;
// 图标来源：assets/icon/full_sceen.svg；内联后不依赖页面能否读取插件资源。
const FULLSCREEN_ICON = '<svg width="18" height="18" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor"><path d="M460.8 940.8h-320l262.4-262.4c12.8-12.8 12.8-38.4 0-51.2-12.8-19.2-38.4-19.2-57.6 0l-262.4 262.4v-345.6c0-19.2-19.2-38.4-38.4-38.4s-38.4 19.2-38.4 38.4v364.8c0 51.2 38.4 115.2 96 115.2h358.4c19.2 0 38.4-19.2 38.4-38.4 0-25.6-19.2-44.8-38.4-44.8zM940.8 6.4h-377.6c-19.2 0-38.4 19.2-38.4 38.4s19.2 38.4 38.4 38.4h320l-268.8 262.4c-12.8 12.8-12.8 38.4 0 57.6 19.2 12.8 44.8 12.8 57.6 0l262.4-262.4v320c0 19.2 19.2 38.4 38.4 38.4s38.4-19.2 38.4-38.4v-352c6.4-64-25.6-102.4-70.4-102.4z"/></svg>';

export function fullscreenButtonUpdateScript(): string {
  return `(() => { const api = window.__nemusicFullscreenButton; if (!api || api.version !== ${FULLSCREEN_BUTTON_API_VERSION}) return false; api.ensure(); return true; })()`;
}

export function fullscreenButtonStateScript(): string {
  return `(() => { const api = window.__nemusicFullscreenButton; return api ? { active: Boolean(api.active), request: Number(api.request || 0) } : null; })()`;
}

export function fullscreenButtonScript(): string {
  return `(() => {
    const key = '__nemusicFullscreenButton';
    const version = ${FULLSCREEN_BUTTON_API_VERSION};
    if (window[key]?.version === version) { window[key].ensure(); return true; }
    try { window[key]?.destroy?.(); } catch (error) {}
    const api = { version, active: false, request: 0, button: null, anchor: null, observer: null, timer: 0 };
    const visible = rect => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < 180;
    const sync = () => {
      if (!api.button) return;
      api.button.title = api.active ? '退出桌面全屏' : '桌面全屏显示网易云';
      api.button.setAttribute('aria-label', api.button.title);
      api.button.setAttribute('aria-pressed', api.active ? 'true' : 'false');
      api.button.innerHTML = ${JSON.stringify(FULLSCREEN_ICON)};
    };
    const toggle = () => { api.active = !api.active; api.request += 1; sync(); };
    const anchorFor = () => {
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      const candidates = [];
      for (const input of Array.from(document.querySelectorAll('input[placeholder], input[type="search"], input'))) {
        const rect = input.getBoundingClientRect?.();
        if (!visible(rect) || rect.left > width * 0.7 || rect.width < 80) continue;
        const hint = [input.getAttribute?.('placeholder') || '', input.getAttribute?.('aria-label') || '', input.getAttribute?.('type') || ''].join(' ');
        const search = /搜索|search|搜/i.test(hint);
        candidates.push({ input, rect, score: (search ? 1000000 : 0) + Math.min(rect.width, 600) * 10 - rect.top });
      }
      candidates.sort((left, right) => right.score - left.score);
      const candidate = candidates[0];
      if (!candidate) return null;
      // input 通常包在搜索框内部；向上找到那个完整的搜索控件，按钮放到它外侧，
      // 而不是塞进输入框、把麦克风等原有图标挤走。
      let group = candidate.input;
      for (let depth = 0; depth < 4 && group.parentElement; depth += 1) {
        const parent = group.parentElement;
        const rect = parent.getBoundingClientRect?.();
        if (!visible(rect) || rect.height > 72 || rect.width > Math.max(candidate.rect.width + 150, 460)
          || rect.left > candidate.rect.left + 8 || rect.right < candidate.rect.right - 8) break;
        group = parent;
      }
      return group;
    };
    const buttonFor = anchor => {
      const rect = anchor.getBoundingClientRect();
      const button = document.createElement('button');
      const size = Math.max(28, Math.min(42, Math.round(rect.height || 34)));
      button.type = 'button';
      button.setAttribute('data-nemusic-fullscreen-button', '1');
      button.style.cssText = 'position:fixed;z-index:2147483645;display:flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggle(); });
      return button;
    };
    const position = () => {
      const button = api.button, anchor = api.anchor;
      if (!button || !anchor) return;
      const rect = anchor.getBoundingClientRect?.();
      if (!visible(rect)) { button.style.display = 'none'; return; }
      const size = Math.max(28, Math.min(42, Math.round(rect.height || 34)));
      button.style.left = Math.round(rect.right + 8) + 'px';
      button.style.top = Math.round(rect.top + (rect.height - size) / 2) + 'px';
      button.style.display = 'flex';
    };
    api.ensure = () => {
      const anchor = anchorFor();
      if (!anchor) return;
      if (api.button?.isConnected) {
        api.anchor = anchor;
        position();
        sync();
        return;
      }
      api.button = null;
      const button = buttonFor(anchor);
      // 独立挂在 body 上并用搜索框坐标定位，绝不触碰网易云顶栏的 flex 布局。
      if (typeof document.body?.append !== 'function') return;
      document.body.append(button);
      api.button = button;
      api.anchor = anchor;
      position();
      sync();
    };
    const schedule = () => { clearTimeout(api.timer); api.timer = setTimeout(() => api.ensure(), 50); };
    api.destroy = () => { clearTimeout(api.timer); api.observer?.disconnect?.(); api.button?.remove?.(); api.button = null; api.anchor = null; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && api.active) { event.preventDefault(); event.stopPropagation(); api.active = false; api.request += 1; sync(); } }, true);
    api.observer = new MutationObserver(schedule);
    api.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window[key] = api;
    api.ensure();
    return true;
  })()`;
}
