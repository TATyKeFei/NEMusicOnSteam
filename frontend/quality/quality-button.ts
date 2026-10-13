import { QUALITY_OPTIONS, QUALITY_SNAPSHOT_SCRIPT } from "./quality-player.ts";

const BUTTON_API_VERSION = 4;
const ICON = '<svg width="25" height="25" viewBox="173 187 681 681" aria-hidden="true" fill="currentColor"><path d="m 600.20195,570.8023 11.84547,13.75804 a 15.423806,15.423806 0 1 1 -23.38249,20.11263 l -9.13089,-10.59101 a 72.862061,72.862061 0 0 1 -45.20203,15.9585 c -45.71616,0 -81.4377,-43.33061 -81.4377,-95.48364 0,-52.15303 35.72154,-95.50421 81.4377,-95.50421 45.69559,0 81.43769,43.35118 81.43769,95.50421 0,20.89412 -5.75821,40.3898 -15.56775,56.24548 z m -21.59333,-25.06883 c 4.01018,-9.19259 6.31347,-19.80417 6.31347,-31.17665 0,-36.29736 -23.38249,-64.6566 -50.59008,-64.6566 -27.22816,0 -50.59008,28.37981 -50.59008,64.6566 0,36.27679 23.36192,64.63602 50.59008,64.63602 8.98694,0 17.56258,-3.08475 25.0277,-8.55507 l -27.6189,-32.08151 a 15.423806,15.423806 0 1 1 23.36193,-20.11264 l 23.52644,27.28985 z m -192.83871,-50.8163 c 36.50301,0 64.9445,20.50338 64.9445,53.34581 0,32.84241 -28.44149,53.3458 -64.9445,53.3458 -35.10459,0 -64.94451,-22.8478 -64.94451,-53.3458 a 15.423807,15.423807 0 0 1 30.84761,0 c 0,11.39304 14.49838,22.49819 34.0969,22.49819 21.22316,0 34.09689,-9.27486 34.09689,-22.49819 0,-13.22335 -12.87373,-22.49821 -34.09689,-22.49821 -36.1534,0 -64.94451,-21.09976 -64.94451,-53.36636 0,-32.24604 28.79111,-53.3458 64.94451,-53.3458 35.10458,0 64.9445,22.84779 64.9445,53.3458 a 15.423807,15.423807 0 1 1 -30.84761,0 c 0,-11.39305 -14.49838,-22.49819 -34.09689,-22.49819 -20.81186,0 -34.0969,9.72728 -34.0969,22.49819 0,12.79148 13.28504,22.51876 34.0969,22.51876 z m 229.91753,212.76626 a 15.423806,15.423806 0 0 1 16.61659,15.38268 c -0.0206,10.28254 5.03844,18.961 14.04594,24.39018 l 64.20416,38.64177 c 8.43168,5.07958 18.73479,5.07958 27.18703,0 l 64.20416,-38.66233 c 8.63734,-5.20297 14.06652,-14.99195 14.06652,-25.68579 v -77.28355 c 0,-10.69383 -5.42918,-20.48282 -14.06652,-25.68577 l -64.20416,-38.64178 a 26.158775,26.158775 0 0 0 -27.18703,0 l -64.20416,38.64178 c -8.63733,5.20295 -14.06652,15.0125 -14.06652,25.70634 a 15.423807,15.423807 0 0 1 -30.8476,0 c 0,-21.42881 11.00231,-41.29467 28.99675,-52.13247 l 64.20417,-38.66233 a 57.006388,57.006388 0 0 1 59.02176,0 l 64.1836,38.66233 a 60.728666,60.728666 0 0 1 29.01733,52.1119 v 77.28355 a 60.728666,60.728666 0 0 1 -28.99676,52.13247 l -64.22474,38.64178 a 57.006388,57.006388 0 0 1 -59.00119,0 l -64.1836,-38.66235 A 58.898374,58.898374 0 0 1 603.43066,738.48991 H 289.89552 c -55.89587,0 -101.11846,-45.71616 -101.11846,-102.00276 V 398.34358 c 0,-56.28661 45.24316,-102.00277 101.11846,-102.00277 h 342.73754 c 55.89587,0 101.11848,45.71616 101.11848,102.00277 v 108.17229 a 15.423808,15.423808 0 0 1 -30.84761,0 V 398.34358 c 0,-39.32042 -31.48514,-71.15516 -70.27087,-71.15516 H 289.89552 c -38.78572,0 -70.27085,31.83474 -70.27085,71.15516 v 238.14357 c 0,39.32042 31.48513,71.15515 70.27085,71.15515 H 614.4741 c 0.39074,0 0.78148,0 1.17222,0.0411 z m 51.7623,-20.35942 c 0,-31.71134 25.29504,-57.56165 56.69791,-57.56165 31.3823,0 56.67735,25.85031 56.67735,57.58221 0,31.71135 -25.29505,57.54108 -56.67735,57.54108 -31.38231,0 -56.69791,-25.82973 -56.69791,-57.56164 z m 30.8476,0 c 0,14.82742 11.63984,26.73459 25.85031,26.73459 14.1899,0 25.82974,-11.90717 25.82974,-26.73459 0,-14.80685 -11.63984,-26.71404 -25.82974,-26.71404 -14.18991,0 -25.85031,11.88662 -25.85031,26.7346 z"/></svg>';

export function qualityButtonScript(): string {
  return `(() => {
    const key = '__nemusicQualityButton';
    const version = ${BUTTON_API_VERSION};
    if (window[key]?.version === version) return window[key].poll();
    try { window[key]?.destroy?.(); } catch (error) {}
    const options = ${JSON.stringify(QUALITY_OPTIONS)};
    const label = value => value == null ? '暂无播放中的歌曲' : value === 2999 ? '杜比全景声'
      : options.find(option => option.data === value)?.label || '未知音质（' + value + '）';
    const read = () => ${QUALITY_SNAPSHOT_SCRIPT};
    const api = { version, button: null, menu: null, pending: null, busy: false, observer: null, timer: 0, scheduled: false, retries: 0, toastTimer: 0, destroyed: false };
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
      document.querySelector('[data-nemusic-quality-toast]')?.remove();
      const node = document.createElement('div');
      node.setAttribute('data-nemusic-quality-toast', '');
      node.textContent = message;
      node.style.cssText = 'position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483647;padding:8px 18px;border:0;border-radius:0;background:#232b36;color:#dcdedf;font:13px/1.5 system-ui,sans-serif;pointer-events:none;max-width:calc(100vw - 32px);box-sizing:border-box';
      document.body.append(node);
      api.toastTimer = window.setTimeout(() => node.remove(), 3000);
    };
    const closeMenu = () => {
      api.menu?.remove();
      api.menu = null;
      api.button?.setAttribute('aria-expanded', 'false');
    };
    const positionMenu = () => {
      if (!api.menu || !api.button) return;
      const rect = api.button.getBoundingClientRect();
      const box = api.menu.getBoundingClientRect();
      api.menu.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))) + 'px';
      api.menu.style.top = Math.round(Math.max(8, rect.top - box.height - 8)) + 'px';
    };
    const refreshMenu = () => {
      if (!api.menu) return;
      const state = read();
      api.menu.querySelector('[data-nemusic-quality-current]').textContent = '当前实际音质：' + label(state.current);
      for (const row of Array.from(api.menu.querySelectorAll('[data-nemusic-quality-item]'))) {
        const selected = Number(row.getAttribute('data-nemusic-quality-item')) === state.preferred;
        row.setAttribute('aria-checked', String(selected));
        row.querySelector('span').textContent = selected ? '✓' : '';
        row.disabled = !state.available || api.busy;
        row.style.opacity = row.disabled ? '.5' : '1';
      }
      positionMenu();
    };
    const openMenu = () => {
      if (api.menu) return closeMenu();
      const menu = document.createElement('div');
      menu.setAttribute('data-nemusic-quality-menu', '');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', '播放音质');
      menu.style.cssText = 'position:fixed;z-index:2147483647;width:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 96px);overflow-y:auto;padding:8px 0;box-sizing:border-box;border:0;border-radius:0;background:#3d4450;color:#dcdedf;box-shadow:0 8px 26px 2px #0003;font:13px/1.5 system-ui,sans-serif;user-select:none';
      const current = document.createElement('div');
      current.setAttribute('data-nemusic-quality-current', '');
      current.style.cssText = 'padding:6px 18px 10px;font-size:12px;color:#a8b0bc';
      menu.append(current);
      for (const option of options) {
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('role', 'menuitemradio');
        row.setAttribute('data-nemusic-quality-item', String(option.data));
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%;margin:0;padding:8px 18px;box-sizing:border-box;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer';
        row.append(document.createTextNode(option.label));
        const check = document.createElement('span');
        check.setAttribute('aria-hidden', 'true');
        row.append(check);
        const highlight = active => {
          row.style.background = active && !row.disabled ? '#dcdedf' : 'transparent';
          row.style.color = active && !row.disabled ? '#3d4450' : 'inherit';
        };
        row.addEventListener('mouseenter', () => highlight(true));
        row.addEventListener('mouseleave', () => highlight(false));
        row.addEventListener('focus', () => highlight(true));
        row.addEventListener('blur', () => highlight(false));
        row.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (api.busy || !read().available) return;
          api.pending = option.data;
          api.busy = true;
          closeMenu();
          toast('正在设置音质…');
        });
        menu.append(row);
      }
      document.body.append(menu);
      api.menu = menu;
      api.button.setAttribute('aria-expanded', 'true');
      refreshMenu();
    };
    const ensure = () => {
      if (api.destroyed) return false;
      const volume = anchor();
      if (!volume) {
        closeMenu();
        api.button?.remove();
        api.button = null;
        return false;
      }
      if (!api.button) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = '音质设置';
        button.setAttribute('aria-label', '音质设置');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('data-nemusic-quality-button', '1');
        button.innerHTML = ${JSON.stringify(ICON)};
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;margin:0 12px 0 4px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;opacity:.85';
        button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
        button.addEventListener('mouseleave', () => { button.style.opacity = '.85'; });
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openMenu(); });
        api.button = button;
      }
      if (!api.button.isConnected || api.button.nextElementSibling !== volume) volume.parentElement.insertBefore(api.button, volume);
      api.retries = 0;
      refreshMenu();
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
    const onClick = event => {
      if (!api.menu || event.target?.closest?.('[data-nemusic-quality-button],[data-nemusic-quality-menu]')) return;
      closeMenu();
    };
    const onKey = event => {
      if (!api.menu) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        api.button?.focus();
        return;
      }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(api.menu.querySelectorAll('[data-nemusic-quality-item]')).filter(row => !row.disabled);
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement);
      const next = current < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0)
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    api.poll = () => {
      if (!ensure()) schedule();
      const action = api.pending;
      api.pending = null;
      return { installed: true, state: read(), action };
    };
    api.complete = message => {
      api.busy = false;
      if (message) toast(message);
      refreshMenu();
    };
    api.destroy = () => {
      api.destroyed = true;
      closeMenu();
      api.button?.remove();
      api.button = null;
      api.observer?.disconnect();
      window.clearTimeout(api.timer);
      window.clearTimeout(api.toastTimer);
      document.querySelector('[data-nemusic-quality-toast]')?.remove();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', schedule);
    };
    api.observer = new MutationObserver(mutations => {
      if (api.button?.isConnected && visible(api.button) && mutations.every(mutation => mutation.type === 'attributes')) return;
      if (api.button?.isConnected && mutations.every(mutation => mutation.target?.closest?.('[data-nemusic-quality-menu],[data-nemusic-quality-toast]'))) return;
      api.retries = 0;
      schedule();
    });
    api.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', schedule);
    window[key] = api;
    return api.poll();
  })()`;
}

export function qualityButtonUpdateScript(): string {
  return `(() => { const api = window.__nemusicQualityButton; return api?.version === ${BUTTON_API_VERSION} ? api.poll() : { installed: false }; })()`;
}

export function qualityButtonResultScript(message: string): string {
  return `(() => { window.__nemusicQualityButton?.complete?.(${JSON.stringify(message)}); return true; })()`;
}
