export function unblockPageHookScript(endpoint: string, token: string, sources: string[]): string {
  return `(() => {
    const key = '__NEMusicOnSteamUnblockHook';
    const config = ${JSON.stringify({ endpoint, token, sources })};
    const existing = globalThis[key];
    if (existing?.endpoint === config.endpoint && existing?.token === config.token
      && JSON.stringify(existing.sources) === JSON.stringify(config.sources)) return existing.ready;
    existing?.restore?.();
    const originalFetch = globalThis.fetch;
    const pending = new Set();
    const changes = new Map();
    let active = true;
    let network = null;
    let originalNetwork = null;
    let hookedNetwork = null;
    const mediaPrototype = globalThis.HTMLMediaElement?.prototype;
    const originalSrc = mediaPrototype && Object.getOwnPropertyDescriptor(mediaPrototype, 'src');
    const localMedia = raw => {
      try {
        const url = new URL(raw, location.href);
        const endpoint = new URL(config.endpoint);
        if (url.protocol === 'https:' && url.hostname === endpoint.hostname && url.port === endpoint.port
          && /^\\/media\\/[a-f0-9]{48}\\.(?:mp3|flac|m4a|aac|ogg)$/.test(url.pathname)) {
          url.protocol = endpoint.protocol;
          return url.href;
        }
      } catch {}
      return raw;
    };
    const setSrc = function(value) { originalSrc.set.call(this, localMedia(value)); };
    const api = { endpoint: config.endpoint, token: config.token, sources: config.sources, ready: false, status: '等待网页请求模块' };
    const playerPath = raw => {
      try { return /\\/(?:api|weapi|eapi)\\/song\\/enhance\\/player\\/url(?:\\/v1)?$/.test(new URL(raw, location.href).pathname); }
      catch { return false; }
    };
    const permission = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      if ('maxPlayBr' in value && Number(value.maxPlayBr) <= 0) return { ...value, maxPlayBr: 128000, maxPlayLevel: 128000 };
      if ('pl' in value && 'id' in value && Number(value.pl) <= 0) return { ...value, pl: 128000, plLevel: 'standard' };
      return null;
    };
    const permissions = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 24) return value;
      if (Array.isArray(value)) return value.map(item => permissions(item, depth + 1));
      const copy = permission(value) || { ...value };
      for (const name of Object.keys(copy)) {
        if (copy[name] && typeof copy[name] === 'object') copy[name] = permissions(copy[name], depth + 1);
      }
      return copy;
    };
    const patchCached = (value, depth = 0, seen = new Set()) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5 || seen.has(value)) return;
      seen.add(value);
      const privilege = value.privilege;
      const updated = permission(privilege);
      if (updated) {
        for (const field of ['maxPlayBr', 'maxPlayLevel', 'pl', 'plLevel']) {
          if (updated[field] === privilege[field]) continue;
          let fields = changes.get(privilege);
          if (!fields) changes.set(privilege, fields = new Map());
          if (!fields.has(field)) fields.set(field, { descriptor: Object.getOwnPropertyDescriptor(privilege, field), value: updated[field] });
          try { privilege[field] = updated[field]; } catch {}
        }
      }
      for (const name of ['song', 'track', 'item', 'record', 'detail', 'info', 'data', 'props', 'payload']) patchCached(value[name], depth + 1, seen);
    };
    const beforeClick = event => {
      let element = event.target;
      for (let hops = 0; element && hops < 12; hops++, element = element.parentElement) {
        const fiberKey = Object.keys(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        let fiber = fiberKey && element[fiberKey];
        const seen = new Set();
        for (let depth = 0; fiber && depth < 30 && !seen.has(fiber); depth++, fiber = fiber.return) {
          seen.add(fiber);
          patchCached(fiber.memoizedProps);
          patchCached(fiber.pendingProps);
          patchCached(fiber.alternate?.memoizedProps);
        }
      }
    };
    const localRequest = async (path, body) => {
      const controller = new AbortController();
      pending.add(controller);
      const timer = setTimeout(() => controller.abort(), 28000);
      try {
        const response = await originalFetch.call(globalThis, config.endpoint + path, {
          method: body ? 'POST' : 'GET', credentials: 'omit', signal: controller.signal,
          headers: { 'X-NEMusic-Token': config.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '音源匹配失败');
        if (!active) throw new Error('解灰已关闭');
        return result;
      } finally { clearTimeout(timer); pending.delete(controller); }
    };
    const replace = async (payload, raw, data) => {
      if (!active) return payload;
      if (!playerPath(raw)) return permissions(payload);
      const items = Array.isArray(payload?.data) ? payload.data : [];
      let ids = [];
      try {
        const params = typeof data === 'string' ? new URLSearchParams(data) : null;
        const rawIds = params?.get('ids') || data?.ids || new URL(raw, location.href).searchParams.get('ids') || '[]';
        ids = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
        if (!Array.isArray(ids)) ids = [ids];
      } catch {}
      const replaced = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item?.url && !item.freeTrialInfo) { replaced.push(item); continue; }
        const id = Number(item?.id || ids[index]);
        if (!Number.isSafeInteger(id) || id <= 0) { replaced.push(item); continue; }
        api.status = '正在匹配歌曲 ' + id;
        try {
          const matched = await localRequest('/match', { id, sources: config.sources });
          if (typeof matched.mediaPath !== 'string' || !/^\\/media\\/[a-f0-9]{48}\\.(?:mp3|flac|m4a|aac|ogg)$/.test(matched.mediaPath)) throw new Error('音频转发地址无效');
          replaced.push({ ...item, id, url: config.endpoint + matched.mediaPath, type: matched.type || 'mp3',
            md5: matched.md5, br: matched.br || 128000, size: matched.size || 0,
            time: matched.duration || item?.time || 0, level: 'standard', encodeType: matched.type || 'mp3',
            freeTrialInfo: null, freeTrialPrivilege: null, code: 200, flag: 0 });
          api.status = '已匹配 ' + matched.provider + '：' + id;
        } catch (error) { api.status = error.message; replaced.push(item); }
      }
      return active ? { ...payload, data: replaced } : payload;
    };
    const installNetwork = () => {
      const chunks = globalThis.webpackJsonp;
      if (!chunks?.push) return false;
      let require;
      const id = 'nemusic-unblock-' + Math.random().toString(36).slice(2);
      chunks.push([[id], { [id]: (module, exports, loader) => { require = loader; } }, [[id]]]);
      if (!require?.m) return false;
      delete require.m[id];
      if (require.c) delete require.c[id];
      const moduleId = Object.keys(require.m).find(id => {
        const source = String(require.m[id]);
        return source.includes('rawFetch') && source.includes('FetchWithRPC');
      });
      if (moduleId == null) return false;
      network = require(moduleId);
      originalNetwork = network.default;
      if (typeof originalNetwork !== 'function') return false;
      hookedNetwork = async function(raw, options) {
        const response = await originalNetwork.apply(this, arguments);
        if (!active || !response || typeof response.json !== 'function') return response;
        return new Proxy(response, { get(target, name) {
          if (name === 'json') return async () => replace(await target.json(), raw, options?.data);
          const value = Reflect.get(target, name, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      Object.assign(hookedNetwork, originalNetwork);
      network.default = hookedNetwork;
      return network.default === hookedNetwork;
    };
    api.ready = installNetwork();
    if (!api.ready) return false;
    if (originalSrc?.configurable && originalSrc.set) Object.defineProperty(mediaPrototype, 'src', { ...originalSrc, set: setSrc });
    for (const name of ['click', 'dblclick', 'keydown']) document.addEventListener(name, beforeClick, true);
    const heartbeat = setInterval(() => { void localRequest('/status').catch(error => { api.status = error.message; }); }, 30000);
    api.restore = () => {
      active = false;
      clearInterval(heartbeat);
      for (const controller of pending) controller.abort();
      if (network?.default === hookedNetwork) network.default = originalNetwork;
      if (mediaPrototype && Object.getOwnPropertyDescriptor(mediaPrototype, 'src')?.set === setSrc) Object.defineProperty(mediaPrototype, 'src', originalSrc);
      for (const name of ['click', 'dblclick', 'keydown']) document.removeEventListener(name, beforeClick, true);
      for (const [object, fields] of changes) for (const [field, previous] of fields) {
        if (object[field] !== previous.value) continue;
        try { if (previous.descriptor) Object.defineProperty(object, field, previous.descriptor); else delete object[field]; } catch {}
      }
      changes.clear();
      if (globalThis[key] === api) delete globalThis[key];
    };
    api.status = '网页解灰已就绪';
    globalThis[key] = api;
    return true;
  })()`;
}

export const UNBLOCK_PAGE_UNINSTALL_SCRIPT = `(() => {
  globalThis.__NEMusicOnSteamUnblockHook?.restore?.();
  return true;
})()`;
