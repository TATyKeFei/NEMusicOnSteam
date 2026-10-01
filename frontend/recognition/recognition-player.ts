/**
 * recognitionScript 的稳态部分：刷新已在运行的页面脚本的配置，并汇报它是否还在。
 * 识曲每两秒运行一次定时器，为了确认「装上了没有」而每次都发整份脚本，
 * 只会是每个 tick 一次无谓的内存分配。
 */

/** 注入的 api 结构一有变化就递增，让升级能够替换掉页面上的旧脚本。 */
const RECOGNITION_API_VERSION = 4;

export function recognitionUpdateScript(endpoint: string, token: string, open = false): string {
  return `(() => {
    const api = window.__nemusicRecognition;
    if (!api || api.version !== ${RECOGNITION_API_VERSION}) return false;
    api.config = ${JSON.stringify({ endpoint, token, open })};
    api.ensureHeaderButton?.();
    if (api.config.open) api.show();
    return true;
  })()`;
}

export function recognitionScript(endpoint: string, token: string, open = false): string {
  return `(() => {
    const config = ${JSON.stringify({ endpoint, token, open })};
    const key = '__nemusicRecognition';
    const version = ${RECOGNITION_API_VERSION};
    // 旧版本插件留下的过期 api 会继续用它当初的闭包（比如安装那一刻抓到的 store、
    // 旧版的播放流程），所以版本号一升就把它整个替换掉。
    if (window[key] && window[key].version === version) {
      window[key].config = config;
      window[key].ensureHeaderButton?.();
      if (config.open) window[key].show();
      return true;
    }
    if (window[key]) {
      try { window[key].cancel?.(); window[key].hide?.(); } catch (error) {}
      try { delete window[key]; } catch (error) { window[key] = undefined; }
    }
    const api = { version, config, generation: 0, jobId: '', busy: false, factory: null, panel: null, previousFocus: null };
    const historyStore = (() => {
      try { return window.localStorage ?? null; } catch (error) { return null; }
    })();
    const HISTORY_KEY = '__nemusicRecognitionHistory';
    api.history = (() => {
      try {
        const parsed = JSON.parse(historyStore?.getItem?.(HISTORY_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) { return []; }
    })();
    const saveHistory = () => {
      try { historyStore?.setItem?.(HISTORY_KEY, JSON.stringify(api.history.slice(0, 50))); } catch (error) {}
    };
    api.pushHistory = entry => {
      api.history = [entry, ...api.history.filter(item => Number(item.id) !== Number(entry.id))].slice(0, 50);
      saveHistory();
      api.showHistory();
    };
    api.clearHistory = () => {
      api.history = [];
      saveHistory();
      api.showHistory();
    };
    api.showHistory = () => {
      const list = api.panel?.querySelector('[data-history]');
      if (!list) return;
      list.replaceChildren();
      for (const entry of api.history.slice(0, 20)) {
        const item = document.createElement('li');
        const title = document.createElement('span');
        title.textContent = entry.name + (entry.artist ? ' — ' + entry.artist : '');
        title.style.color = '#ff7777';
        const link = document.createElement('button');
        link.type = 'button';
        link.textContent = '复制链接';
        link.style.cssText = 'float:right;background:#484850;font-size:12px;padding:2px 10px;';
        link.addEventListener('click', () => api.copyText('https://music.163.com/#/song?id=' + encodeURIComponent(entry.id)));
        item.append(title, link);
        list.append(item);
      }
    };
    api.copyText = async value => {
      try {
        await navigator.clipboard.writeText(value);
        status('已复制');
      } catch {
        status('复制失败，请手动选中文字复制');
      }
    };
    const request = async (path, body, keepalive = false) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(api.config.endpoint + path, {
          method: body ? 'POST' : 'GET',
          headers: { 'X-NEMusic-Token': api.config.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          keepalive,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '识曲请求失败：' + response.status);
        return payload;
      } finally {
        clearTimeout(timeout);
      }
    };
    const cancelJob = id => id ? request('/recognition/cancel', { id }, true).catch(() => {}) : Promise.resolve();
    const status = message => { if (api.panel) api.panel.querySelector('[data-status]').textContent = message; };
    const setBusy = busy => {
      api.busy = busy;
      if (!api.panel) return;
      api.panel.querySelector('[data-start]').disabled = busy;
      api.panel.querySelector('[data-source]').disabled = busy;
      api.panel.querySelector('[data-cancel]').hidden = !busy;
    };
    api.cancel = () => {
      api.generation++;
      const id = api.jobId;
      api.jobId = '';
      setBusy(false);
      status('已取消');
      return cancelJob(id);
    };
    api.hide = () => {
      void api.cancel();
      api.panel?.remove();
      api.panel = null;
      api.previousFocus?.focus?.();
    };
    const fingerprint = async samples => {
      const bytes = Uint8Array.from(atob(samples), character => character.charCodeAt(0));
      if (bytes.length !== 6 * 8000 * 4) throw new Error('录音数据不完整，请重试');
      const pcm = new Float32Array(bytes.buffer);
      if (!pcm.every(Number.isFinite)) throw new Error('录音数据无效');
      if (!pcm.some(value => Math.abs(value) > 0.0001)) throw new Error('没有采集到声音，请检查音量和默认输入／输出设备');
      const runtime = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('识曲引擎启动超时')), 10000);
        try {
          const module = api.factory();
          const ready = () => { clearTimeout(timeout); resolve(module); };
          module.onRuntimeInitialized = ready;
          module.onAbort = reason => { clearTimeout(timeout); reject(new Error(String(reason))); };
          if (typeof module.ExtractQueryFP === 'function') ready();
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      const vector = runtime.ExtractQueryFP(pcm.buffer);
      try {
        const bytes = new Uint8Array(vector.size());
        for (let index = 0; index < bytes.length; index++) bytes[index] = Number(vector.get(index)) & 0xff;
        if (!bytes.length) throw new Error('未生成有效音频指纹，请换一段音乐再试');
        let encoded = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          encoded += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        return btoa(encoded);
      } finally {
        vector.delete();
      }
    };
    const showResults = results => {
      const list = api.panel?.querySelector('[data-results]');
      if (!list) return;
      list.replaceChildren();
      const copy = async value => {
        try {
          await navigator.clipboard.writeText(value);
          status('已复制');
        } catch {
          const input = document.createElement('textarea');
          input.value = value;
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.append(input);
          input.select();
          document.execCommand('copy');
          input.remove();
          status('已复制');
        }
      };
      for (const song of results) {
        const item = document.createElement('li');
        const url = 'https://music.163.com/#/song?id=' + encodeURIComponent(song.id);
        const title = document.createElement('span');
        title.textContent = song.name + (song.artist ? ' — ' + song.artist : '');
        title.style.color = '#ff7777';
        item.append(title);
        if (song.album) {
          const album = document.createElement('small');
          album.textContent = song.album;
          item.append(album);
        }
        const actions = document.createElement('div');
        actions.style.marginTop = '6px';
        for (const [label, action] of [
          ['复制歌名', () => copy(String(song.name))],
          ['复制链接', () => copy(url)],
          ['浏览器打开', () => window.open(url, '_blank', 'noopener,noreferrer')],
          ['复制歌曲 ID', () => copy(String(song.id))],
        ]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.style.cssText = 'margin:0 6px 0 0;padding:3px 8px;border:1px solid #555;border-radius:0;background:#303038;color:#ddd;cursor:pointer;font:12px system-ui,sans-serif;';
          button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void action(); });
          actions.append(button);
        }
        item.append(actions);
        list.append(item);
      }
    };
    const ensureHeaderButton = () => {
      if (document.querySelector?.('[data-nemusic-recognition-button]')) return;
      const search = Array.from(document.querySelectorAll?.('input[placeholder], input[type="search"]') ?? []).find(input => {
        const rect = input.getBoundingClientRect();
        return rect.top >= 0 && rect.top < 100 && rect.width > 120 && rect.height > 20;
      });
      if (!search?.parentElement) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.title = '听歌识曲';
      button.setAttribute('aria-label', '听歌识曲');
      button.setAttribute('data-nemusic-recognition-button', '1');
      button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm7-3a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V21H8a1 1 0 0 0 0 2h8a1 1 0 0 0-2 0h-3v-3.08A7 7 0 0 0 19 11Z"/></svg>';
      button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin-left:8px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); api.show(); });
      search.parentElement.append(button);
    };
    api.start = async () => {
      if (api.busy || !api.panel) return;
      const generation = ++api.generation;
      const source = api.panel.querySelector('[data-source]').value;
      setBusy(true);
      showResults([]);
      let id = '';
      try {
        if (!api.factory) {
          status('正在下载识曲引擎…');
          const engine = await request('/recognition/engine');
          if (generation !== api.generation) return;
          api.factory = new Function('globalThis', engine.source + '\\nreturn AudioFingerprintRuntime;')({});
        }
        if (generation !== api.generation) return;
        status('正在连接音频设备…');
        const started = await request('/recognition/start', { source });
        id = started.id;
        if (generation !== api.generation) { await cancelJob(id); return; }
        api.jobId = id;
        const began = Date.now();
        let submitted = false;
        while (generation === api.generation) {
          if (Date.now() - began > 60000) throw new Error('识曲超时，请重试');
          const job = await request('/recognition');
          if (generation !== api.generation) return;
          if (job.id !== id || job.stage === 'cancelled') throw new Error('识曲任务已取消');
          if (job.stage === 'error') throw new Error(job.error || '识曲失败');
          if (job.stage === 'done') {
            showResults(job.results);
            status(job.results.length ? '识别完成，麻烦自己通过下面歌名等搜索😭' : '没有找到匹配歌曲，请换一段更清晰的音乐再试');
            for (const song of job.results.slice(0, 5)) {
              api.pushHistory({ id: song.id, name: String(song.name || ''), artist: String(song.artist || ''), album: String(song.album || ''), at: Date.now() });
            }
            return;
          }
          if (job.stage === 'recorded' && !submitted) {
            status('采集完成，正在识别…');
            const audioFP = await fingerprint(job.samples);
            if (generation !== api.generation) return;
            await request('/recognition/match', { id, fingerprint: audioFP });
            submitted = true;
          } else if (job.stage === 'recording') {
            const seconds = Math.min(6, Math.floor((Date.now() - began) / 1000));
            status((source === 'system' ? '正在聆听系统声音' : '正在聆听麦克风') + ' · ' + seconds + ' / 6 秒');
          } else {
            status('正在查询歌曲…');
          }
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } catch (error) {
        if (generation === api.generation) status(error.message || String(error));
        await cancelJob(id);
      } finally {
        if (generation === api.generation) {
          api.jobId = '';
          setBusy(false);
        }
      }
    };
    api.show = () => {
      if (api.panel) { api.panel.querySelector('[data-close]').focus(); return; }
      api.previousFocus = document.activeElement;
      const panel = document.createElement('div');
      panel.id = 'nemusic-recognition';
      panel.innerHTML = '<style>#nemusic-recognition{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(0,0,0,.48);font:14px/1.6 system-ui,sans-serif;color:#eee}#nemusic-recognition section{width:min(460px,90vw);max-height:85vh;overflow:auto;box-sizing:border-box;padding:26px;border:1px solid #46464c;border-radius:0;background:#222228;box-shadow:0 18px 70px #0008}#nemusic-recognition h2{font-size:21px;margin:0 0 14px;color:#fff}#nemusic-recognition p{margin:12px 0;color:#b8b8c2}#nemusic-recognition select{display:block;width:100%;margin:8px 0 16px;padding:10px;border:1px solid #555;border-radius:8px;background:#303038;color:#fff}#nemusic-recognition button{cursor:pointer;padding:8px 18px;border:0;border-radius:20px;margin-right:8px;background:#ec4141;color:#fff;font:inherit}#nemusic-recognition button:disabled{opacity:.5;cursor:wait}#nemusic-recognition [data-close]{float:right;background:transparent;padding:0 6px;font-size:24px}#nemusic-recognition [data-cancel]{background:#484850}#nemusic-recognition [data-status]{min-height:44px;color:#eee}#nemusic-recognition ul{padding:0;list-style:none;margin:0}#nemusic-recognition li{padding:10px 0;border-top:1px solid #444}#nemusic-recognition a{color:#ff7777;text-decoration:none}#nemusic-recognition small{display:block;color:#aaa}#nemusic-recognition :focus-visible{outline:2px solid #ff7777;outline-offset:3px}</style><section role="dialog" aria-modal="true" aria-labelledby="nemusic-recognition-title"><button data-close aria-label="关闭">×</button><h2 id="nemusic-recognition-title">听歌识曲</h2><label>声音来源<select data-source aria-label="声音来源"><option value="system">系统声音 · 默认输出设备</option><option value="microphone">麦克风 · 默认输入设备</option></select></label><p>开始后将采集 6 秒。仅用于向网易云发送音频指纹，不会保存录音文件</p><button data-start>开始识曲</button><button data-cancel hidden>取消</button><p data-status role="status" aria-live="polite">准备好音乐后，点击开始识曲</p><ul data-results></ul><p style="margin:18px 0 4px;color:#8a8a94;font-size:12px">识别历史（只保存在本机）<button data-clear-history type="button" style="float:right;background:#484850;color:#ddd;border:0;border-radius:20px;padding:2px 12px;font:12px system-ui;cursor:pointer">清空</button></p><ul data-history></ul></section>';
      panel.querySelector('[data-close]').addEventListener('click', api.hide);
      panel.querySelector('[data-start]').addEventListener('click', () => void api.start());
      panel.querySelector('[data-cancel]').addEventListener('click', () => void api.cancel());
      panel.addEventListener('click', event => { if (event.target === panel) api.hide(); });
      panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); api.hide(); }
        if (event.key === 'Tab') {
          const buttons = Array.from(panel.querySelectorAll('button:not([hidden]):not(:disabled),select:not(:disabled),a[href]'));
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
      api.panel = panel;
      document.body.append(panel);
      panel.querySelector('[data-clear-history]').addEventListener('click', () => api.clearHistory());
      api.showHistory();
      panel.querySelector('[data-source]').focus();
    };
    document.addEventListener('click', event => {
      if (!event.target?.closest?.('#btn_pc_song_recognize,[data-logid="btn_pc_song_recognize"],[data-oid="btn_pc_song_recognize"],[title="听歌识曲"],[aria-label="听歌识曲"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      api.show();
    }, true);
    window.addEventListener('pagehide', () => void api.cancel());
    window[key] = api;
    api.ensureHeaderButton = ensureHeaderButton;
    ensureHeaderButton();
    if (config.open) api.show();
    return true;
  })()`;
}
