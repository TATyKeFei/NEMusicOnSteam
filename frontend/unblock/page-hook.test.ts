import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./page-hook.ts", import.meta.url), "utf8").replace(/^export /gm, ""));

function setup(payload: unknown, match = { mediaPath: "/media/" + "a".repeat(48) + '.mp3', provider: "kuwo", type: "mp3", br: 128000, size: 99, md5: '1'.repeat(32), duration: 270000 }) {
  const calls: { url: string; body: unknown }[] = [];
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const timers = new Set<unknown>();
  let matchGate: Promise<void> | null = null;
  class Media {
    value = '';
    get src() { return this.value; }
    set src(value: string) { this.value = value; }
  }
  const network = { default: async (_url: string, _options?: unknown) => new Response(JSON.stringify(payload)), rawFetch: true };
  const originalNetwork = network.default;
  const loader = Object.assign((id: string) => {
    if (id === "256") return network;
    const module = { exports: {} };
    loader.m[id](module, module.exports, loader);
    return module.exports;
  }, { m: { 256: function () { return { rawFetch: true, FetchWithRPC: true }; } } as Record<string, (...args: any[]) => unknown>, c: {} });
  const originalFetch = async (input: string, init: { body?: string; signal: AbortSignal }) => {
    calls.push({ url: input, body: init.body && JSON.parse(init.body) });
    await matchGate;
    if (init.signal.aborted) throw new Error("aborted");
    return new Response(JSON.stringify(match));
  };
  const context = createContext({
    fetch: originalFetch,
    globalThis: null,
    location: { href: "https://music.163.com/st/webplayer" },
    URL, URLSearchParams, Response, JSON, AbortController, setTimeout, clearTimeout, HTMLMediaElement: Media,
    setInterval: (fn: unknown) => { timers.add(fn); return fn; },
    clearInterval: (fn: unknown) => timers.delete(fn),
    document: {
      addEventListener: (name: string, fn: (event: { target: unknown }) => void, capture: boolean) => { assert.equal(capture, true); listeners.set(name, fn); },
      removeEventListener: (name: string) => listeners.delete(name),
    },
    webpackJsonp: { push: (chunk: any[]) => { Object.assign(loader.m, chunk[1]); chunk[2].forEach(([id]: string[]) => loader(id)); } },
  });
  context.globalThis = context;
  const script = runInContext(`${source}; unblockPageHookScript("http://127.0.0.1:1234", "token", ["kuwo"])`, context) as string;
  assert.equal(runInContext(script, context), true);
  return {
    context, calls, network, originalNetwork, listeners, timers, script, Media,
    request: async (url: string, data?: unknown) => JSON.parse(JSON.stringify(await (await network.default(url, { method: "POST", data })).json())),
    click: (song: unknown) => listeners.get("dblclick")?.({ target: { __reactFiber$test: { memoizedProps: { data: song } } } }),
    hold: (gate: Promise<void>) => { matchGate = gate; },
    uninstall: () => runInContext(runInContext("UNBLOCK_PAGE_UNINSTALL_SCRIPT", context), context),
  };
}

describe("web player gray-song hook", () => {
  it("leaves an official URL untouched", async () => {
    const player = setup({ code: 200, data: [{ url: "https://music.163.com/song.mp3" }] });
    assert.deepEqual(await player.request('/api/song/enhance/player/url/v1', { ids: '[1]' }), { code: 200, data: [{ url: "https://music.163.com/song.mp3" }] });
    assert.deepEqual(player.calls, []);
  });

  it("lets an already cached gray row pass the webpage click guard before resolving its encrypted POST", async () => {
    const player = setup({ code: 200, data: [{ id: 186016, url: null, freeTrialInfo: { start: 0, end: 30 } }] });
    const song = { id: '186016', name: '晴天', artists: [{ name: '周杰伦' }], privilege: { id: '186016', maxPlayBr: 0, status: -200, fee: 0 } };
    const guard = () => song.privilege.maxPlayBr > 0;
    assert.equal(guard(), false);
    player.click(song);
    assert.equal(guard(), true);
    assert.deepEqual(await player.request('/api/song/enhance/player/url/v1', { ids: '[186016]' }), {
      code: 200,
      data: [{ id: 186016, url: "http://127.0.0.1:1234/media/" + 'a'.repeat(48) + '.mp3', type: "mp3", br: 128000, size: 99,
        md5: '1'.repeat(32), time: 270000, level: 'standard', encodeType: 'mp3', freeTrialInfo: null, freeTrialPrivilege: null, code: 200, flag: 0 }],
    });
    assert.deepEqual(player.calls, [{ url: "http://127.0.0.1:1234/match", body: { id: 186016, sources: ['kuwo'] } }]);
    player.uninstall();
    assert.equal(guard(), false);
    assert.equal(player.network.default, player.originalNetwork);
    assert.equal(player.listeners.size, 0);
    assert.equal(player.timers.size, 0);
  });

  it("replaces unavailable Simple Love with complete source metadata accepted by the webpage", async () => {
    const match = { mediaPath: '/media/' + 'b'.repeat(48) + '.m4a', provider: 'bilivideo', type: 'm4a', md5: '2'.repeat(32), duration: 270000, br: 0, size: 1964954 };
    const player = setup({ code: 200, data: [{ id: 186119, url: null, md5: null, code: 404, level: null, freeTrialPrivilege: { resConsumable: false } }] }, match);
    const { data: [item] } = await player.request('/api/song/enhance/player/url/v1', { ids: '[186119]' });
    // This is the official createSourcePlayInfo guard; a URL without md5 skips the song.
    assert.ok(item.code === 200 && item.url && item.md5);
    assert.equal(item.md5, match.md5);
    assert.equal(item.type, 'm4a');
    assert.match(item.url, /\.m4a$/);
    assert.equal(item.time, 270000);
    assert.equal(item.level, 'standard');
    assert.equal(item.freeTrialPrivilege, null);
  });

  it("patches new playlist and privilege responses while preserving account and download rights", async () => {
    const payload = { code: 200, privileges: [{ id: 1, pl: 0, dl: 0, fee: 1, st: -200 }], profile: { vipType: 0 } };
    const player = setup(payload);
    const result = await player.request('/api/playlist/v4/detail', { id: 9 });
    assert.deepEqual(result, { ...payload, privileges: [{ ...payload.privileges[0], pl: 128000, plLevel: 'standard' }] });
    assert.equal(payload.privileges[0].pl, 0);
    assert.deepEqual(player.calls, []);
  });

  it("uses response ids for each item instead of replacing another song in a multi-song request", async () => {
    const player = setup({ code: 200, data: [{ id: 2, url: null }, { id: 1, url: 'https://official.example/song.mp3' }] });
    await player.request('/api/song/enhance/player/url/v1', { ids: '[1,2]' });
    assert.deepEqual(player.calls[0].body, { id: 2, sources: ['kuwo'] });
  });

  it("does not install duplicate listeners or timers on repeated initialization", () => {
    const player = setup({});
    const wrapped = player.network.default;
    assert.equal(runInContext(player.script, player.context), true);
    assert.equal(player.network.default, wrapped);
    assert.equal(player.listeners.size, 3);
    assert.equal(player.timers.size, 1);
  });

  it("keeps the local media connection on HTTP when the webpage forces HTTPS", () => {
    const player = setup({});
    const media = new player.Media();
    const address = 'https://127.0.0.1:1234/media/' + 'a'.repeat(48) + '.m4a';
    media.src = address;
    assert.equal(media.src, address.replace('https:', 'http:'));
    media.src = 'https://official.example/song.mp3';
    assert.equal(media.src, 'https://official.example/song.mp3');
    player.uninstall();
    media.src = address;
    assert.equal(media.src, address);
  });

  it("discards a replacement that finishes after disabling", async () => {
    const payload = { code: 200, data: [{ id: 1, url: null }] };
    const player = setup(payload);
    let release!: () => void;
    player.hold(new Promise<void>(resolve => { release = resolve; }));
    const pending = player.request('/api/song/enhance/player/url/v1', { ids: '[1]' });
    await new Promise(resolve => setImmediate(resolve));
    player.uninstall();
    release();
    assert.deepEqual(await pending, payload);
  });

  it("reports unsupported webpage modules instead of pretending the hook was installed", () => {
    const player = setup({});
    player.uninstall();
    player.context.webpackJsonp = undefined;
    assert.equal(runInContext(player.script, player.context), false);
    assert.equal(player.context.__NEMusicOnSteamUnblockHook, undefined);
  });
});
