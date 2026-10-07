/** 注入网易云网页搜索框右侧的桌面全屏按钮。 */
const FULLSCREEN_BUTTON_API_VERSION = 8;
// 图标来源：assets/icon/full_sceen.svg；内联后不依赖页面能否读取插件资源。
const FULLSCREEN_ICON = '<svg width="18" height="18" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor"><path d="M460.8 940.8h-320l262.4-262.4c12.8-12.8 12.8-38.4 0-51.2-12.8-19.2-38.4-19.2-57.6 0l-262.4 262.4v-345.6c0-19.2-19.2-38.4-38.4-38.4s-38.4 19.2-38.4 38.4v364.8c0 51.2 38.4 115.2 96 115.2h358.4c19.2 0 38.4-19.2 38.4-38.4 0-25.6-19.2-44.8-38.4-44.8zM940.8 6.4h-377.6c-19.2 0-38.4 19.2-38.4 38.4s19.2 38.4 38.4 38.4h320l-268.8 262.4c-12.8 12.8-12.8 38.4 0 57.6 19.2 12.8 44.8 12.8 57.6 0l262.4-262.4v320c0 19.2 19.2 38.4 38.4 38.4s38.4-19.2 38.4-38.4v-352c6.4-64-25.6-102.4-70.4-102.4z"/></svg>';
// 图标来源：assets/icon/exit_full_sceen.svg；进入桌面全屏后用于退出。
const EXIT_FULLSCREEN_ICON = '<svg width="18" height="18" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor"><path d="M400.595 345.365l-0.948-245.022c-0.42-18.881-16.018-30.215-34.956-30.637h-25.406c-18.88-0.42-33.874 16.018-33.457 34.881l1.061 133.251-168.117-165.421c-18.274-18.311-47.844-18.311-66.119 0-18.218 18.314-18.218 47.907 0 66.236l166.575 164.885-127.697 0.512c-18.88-0.477-36.394 12.606-39.26 34.899v24.080c0.477 18.917 16.077 34.558 34.957 34.972l243.826-1.438c0.362 0.035 0.608 0.171 0.928 0.171l17.1 0.378c9.441 0.226 17.9-3.467 23.923-9.593 6.124-6.083 8.382-14.58 8.131-24.078l-1.821-17.138c0.001-0.335 1.27-0.562 1.27-0.945z"/><path d="M766.211 701.451l127.524-0.512c18.88 0.421 36.357-11.183 39.26-33.474v-24.077c-0.478-18.922-16.134-34.558-34.957-35.037l-240.702 1.458c-0.378 0-0.605-0.151-0.967-0.151l-17.062-0.42c-9.441-0.226-17.95 3.469-23.98 9.611-6.159 6.030-8.361 14.559-8.173 24.057l1.881 17.1c0.033 0.42-1.234 0.661-1.234 0.986l0.986 241.248c0.477 18.863 16.078 30.162 34.957 30.576l24.017 0.037c18.827 0.433 33.874-16.055 33.403-34.941l-1.062-130.388 168.117 166.502c18.276 18.314 47.809 18.314 66.085 0 18.255-18.31 18.255-47.906 0-66.218l-168.095-166.366z"/><path d="M392.992 618.855c-6.028-6.14-14.541-9.834-23.923-9.61l-17.104 0.42c-0.346 0-0.566 0.151-0.948 0.151l-243.81-1.458c-18.881 0.478-34.503 16.112-34.956 35.034v24.078c2.843 22.292 20.357 33.892 39.206 33.474l129.158 0.42-167.983 166.37c-18.234 18.255-18.234 47.906 0 66.218 18.256 18.314 47.845 18.314 66.102 0l168.137-165.418-1.079 131.185c-0.42 18.922 14.579 35.413 33.424 34.938h25.406c18.937-0.477 34.54-11.713 34.956-30.637l0.987-243.050c0-0.346-1.267-0.571-1.267-0.949l1.821-17.104c0.206-9.495-1.993-18.025-8.116-24.053z"/><path d="M615.434 387.559c6.030 6.123 14.541 9.819 23.965 9.553l17.060-0.378c0.378 0 0.608-0.132 0.986-0.19l244.19 1.457c18.88-0.434 34.482-16.078 34.956-34.994l0.058-24.078c-2.898-22.331-20.439-35.355-39.26-34.939l-129.573-0.511 166.483-164.893c18.31-18.235 18.31-47.83 0.054-66.143-18.276-18.311-47.809-18.311-66.084 0l-168.117 166.447 1.079-134.276c0.454-18.863-14.598-35.355-33.424-34.939h-24.017c-18.881 0.477-34.484 11.773-34.957 30.637l-0.967 245.075c0 0.378 1.251 0.608 1.251 0.948l-1.859 17.138c-0.192 9.499 2.007 17.991 8.173 24.078z"/></svg>';

export function fullscreenButtonUpdateScript(): string {
  return `(() => { const api = window.__nemusicFullscreenButton; if (!api || api.version !== ${FULLSCREEN_BUTTON_API_VERSION}) return false; api.ensure(); return true; })()`;
}

export function fullscreenButtonStateScript(): string {
  return `(() => { const api = window.__nemusicFullscreenButton; return api ? { active: Boolean(api.active), fillWindow: Boolean(api.fillWindow), request: Number(api.request || 0) } : null; })()`;
}

export function fullscreenButtonScript(): string {
  return `(() => {
    const key = '__nemusicFullscreenButton';
    const version = ${FULLSCREEN_BUTTON_API_VERSION};
    if (window[key]?.version === version) { window[key].ensure(); return true; }
    try { window[key]?.destroy?.(); } catch (error) {}
    const api = { version, active: false, fillWindow: false, request: 0, button: null, anchor: null, observer: null, timer: 0 };
    const visible = rect => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < 180;
    // 按钮本身在 body 里，不能仅靠较低的 z-index 猜测遮罩层会盖住它。
    // 直接检查搜索框在屏幕上是否仍是最上面的可交互区域：搜索页、歌词页可以继续用，
    // 但登录框、菜单、抽屉等覆盖界面一出现就把按钮收起来。
    const exposed = anchor => {
      if (typeof document.elementFromPoint !== 'function') return true;
      const rect = anchor?.getBoundingClientRect?.();
      if (!visible(rect)) return false;
      const owns = node => {
        let current = node;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          if (current === anchor) return true;
        }
        current = anchor;
        for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
          if (current === node) return true;
        }
        return false;
      };
      const y = Math.round(rect.top + rect.height / 2);
      const xs = [
        Math.round(rect.left + Math.min(16, rect.width / 3)),
        Math.round(rect.left + rect.width / 2),
        Math.round(rect.right - Math.min(16, rect.width / 3)),
      ];
      return xs.some(x => owns(document.elementFromPoint(x, y)));
    };
    const sync = () => {
      if (!api.button) return;
      api.button.title = api.active
        ? (api.fillWindow ? '退出窗口铺满' : '退出桌面全屏')
        : '桌面全屏显示网易云（Shift+点击：铺满当前窗口）';
      api.button.setAttribute('aria-label', api.button.title);
      api.button.setAttribute('aria-pressed', api.active ? 'true' : 'false');
      api.button.innerHTML = api.active ? ${JSON.stringify(EXIT_FULLSCREEN_ICON)} : ${JSON.stringify(FULLSCREEN_ICON)};
    };
    const toggle = fillWindow => { api.active = !api.active; api.fillWindow = api.active && fillWindow; api.request += 1; sync(); };
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
      // 网易云的顶栏有自己的堆叠上下文；层级太低时图标看得到，却被那层透明容器吃掉点击。
      // 覆盖界面是否展示由 exposed() 判断，因此这里可以确保按钮本身始终接得到指针事件。
      button.style.cssText = 'position:fixed;z-index:2147483645;display:flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;user-select:none;touch-action:manipulation;-webkit-app-region:no-drag;';
      let pointerHandled = false;
      const activate = event => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        toggle(event.shiftKey === true);
      };
      button.addEventListener('pointerdown', event => {
        pointerHandled = true;
        activate(event);
        setTimeout(() => { pointerHandled = false; }, 500);
      });
      button.addEventListener('mousedown', event => {
        if (pointerHandled) return;
        pointerHandled = true;
        activate(event);
        setTimeout(() => { pointerHandled = false; }, 500);
      });
      button.addEventListener('click', event => { if (!pointerHandled) activate(event); });
      return button;
    };
    const position = () => {
      const button = api.button, anchor = api.anchor;
      if (!button || !anchor) return;
      if (document.hidden || !exposed(anchor)) { button.style.display = 'none'; return; }
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
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && api.active) { event.preventDefault(); event.stopPropagation(); api.active = false; api.fillWindow = false; api.request += 1; sync(); } }, true);
    document.addEventListener('visibilitychange', schedule);
    api.observer = new MutationObserver(schedule);
    api.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window[key] = api;
    api.ensure();
    return true;
  })()`;
}
