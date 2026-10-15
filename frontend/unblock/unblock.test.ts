import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./unblock.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
const official = { songId: 123, url: "https://music.example/song.mp3", trial: false, name: "歌曲", artist: "歌手", source: "api" };
const matched = { url: "https://audio.example/full.flac", type: "flac", br: 999000, size: 1000, provider: "kuwo" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function setup({ enabled = true, platform = "Linux", track = { ...official } } = {}) {
  let options = { enabled, sources: ["kuwo", "kugou"] };
  const endpoints: string[] = [];
  const requests: { url: string; body: unknown; signal: AbortSignal }[] = [];
  const scripts: boolean[] = [];
  let responseError = "";
  let gate: Promise<void> | null = null;
  let endpointGate: Promise<void> | null = null;
  const Bridge = runInNewContext(`${source}; UnblockBridge`, {
    navigator: { platform },
    window: { setTimeout, clearTimeout },
    AbortController, Error,
    ffi: (name: string) => async () => {
      endpoints.push(name);
      if (name === "unblock_endpoint") { await endpointGate; return "http://127.0.0.1:12345|token"; }
      return "ok";
    },
    downloadScript: (_quality: number, _song: unknown, allowUnavailable: boolean) => { scripts.push(allowUnavailable); return "download"; },
    evaluateInPlayer: async () => track,
    tryEvaluateInPlayer: async () => true,
    UNBLOCK_PAGE_UNINSTALL_SCRIPT: 'uninstall',
    unblockPageHookScript: () => 'install',
    fetch: async (url: string, init: { body?: string; signal: AbortSignal; headers: Record<string, string> }) => {
      assert.equal(init.headers["X-NEMusic-Token"], "token");
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null, signal: init.signal });
      await gate;
      return { ok: !responseError, json: async () => responseError ? { error: responseError } : matched };
    },
  });
  const bridge = new Bridge(() => options);
  return {
    bridge, endpoints, requests, scripts,
    setOptions: (next: typeof options) => { options = next; },
    setError: (error: string) => { responseError = error; },
    hold: (promise: Promise<void>) => { gate = promise; },
    holdEndpoint: (promise: Promise<void>) => { endpointGate = promise; },
  };
}

describe("optional UnblockNeteaseMusic resolver", () => {
  it("keeps official complete URLs without starting the helper", async () => {
    const player = setup();
    assert.equal((await player.bridge.resolve(320)).url, official.url);
    assert.deepEqual(player.endpoints, []);
    assert.deepEqual(player.requests, []);
  });

  it("does not match trials or start a helper when disabled or outside Linux", async () => {
    for (const config of [{ enabled: false }, { platform: "Win32" }]) {
      const player = setup({ ...config, track: { ...official, trial: true } });
      assert.equal((await player.bridge.resolve(320)).url, official.url);
      await player.bridge.check();
      assert.deepEqual(player.endpoints, []);
      assert.deepEqual(player.scripts, [false]);
    }
  });

  for (const track of [{ ...official, url: "" }, { ...official, trial: true }]) {
    it(`matches ${track.url ? "trial" : "missing"} audio by song id with ordered sources`, async () => {
      const player = setup({ track });
      const result = await player.bridge.resolve(320);
      assert.equal(result.url, matched.url);
      assert.equal(result.source, "unblock");
      assert.equal(result.trial, false);
      assert.equal(result.name, official.name);
      assert.deepEqual(player.requests[0].body, { id: 123, sources: ["kuwo", "kugou"] });
      assert.match(player.bridge.getStatus(), /kuwo/);
    });
  }

  it("reports matching failure without handing a trial URL to the downloader", async () => {
    const player = setup({ track: { ...official, trial: true } });
    player.setError("没有找到可用音频");
    await assert.rejects(player.bridge.resolve(320), /没有找到/);
    assert.match(player.bridge.getStatus(), /没有找到/);
  });

  it("aborts in-flight matching and discards its late result when disabled", async () => {
    const player = setup({ track: { ...official, url: "" } });
    let release!: () => void;
    player.hold(new Promise<void>(resolve => { release = resolve; }));
    const pending = player.bridge.resolve(320);
    await flush();
    assert.equal(player.requests.length, 1);
    player.setOptions({ enabled: false, sources: ["kuwo"] });
    player.bridge.reset();
    assert.equal(player.requests[0].signal.aborted, true);
    release();
    await assert.rejects(pending, /取消/);
    await flush();
    assert.ok(player.endpoints.includes("unblock_stop"));
    assert.equal(player.bridge.getStatus(), "已关闭");
  });

  it("stops a helper that was still starting when disabled", async () => {
    const player = setup({ track: { ...official, url: "" } });
    let release!: () => void;
    player.holdEndpoint(new Promise<void>(resolve => { release = resolve; }));
    const pending = player.bridge.resolve(320);
    await flush();
    player.bridge.reset();
    release();
    await assert.rejects(pending, /取消/);
    await flush();
    assert.deepEqual(player.endpoints, ["unblock_endpoint", "unblock_stop"]);
    assert.equal(player.requests.length, 0);
  });

  it("propagates mpv cancellation to the matching request", async () => {
    const player = setup({ track: { ...official, url: "" } });
    let release!: () => void;
    player.hold(new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = player.bridge.resolve(320, undefined, controller.signal);
    await flush();
    controller.abort();
    assert.equal(player.requests[0].signal.aborted, true);
    release();
    await assert.rejects(pending, /取消/);
  });

  it("reports helper status without searching for a song", async () => {
    const player = setup();
    await player.bridge.check();
    assert.match(player.requests[0].url, /\/status$/);
    assert.match(player.bridge.getStatus(), /已连接/);
  });
});
