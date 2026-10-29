import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { HelperClient, HelperConnectionError } from "../runtime/helper-client.ts";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./mpris.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export class MprisBridge", "class MprisBridge"),
);
// mpris.ts imports its CDP session from player-target.ts, and the harness strips imports,
// so run the real module body alongside it instead of stubbing the session out.
const targetSource = stripTypeScriptTypes(
  readFileSync(new URL("../player/player-target.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { trackId?: string; lyric?: unknown; platform?: string; endpoint?: string; reconnectEndpoint?: string; failState?: boolean; snapshot?: () => unknown; notifyMode?: "system" | "steam" } = {}) {
  const evaluations: string[] = [];
  const polls: { signal: AbortSignal; deliver: (commands: unknown[]) => void; fail: () => void }[] = [];
  const endpointCalls: string[] = [];
  const requests: { url: string; token: string }[] = [];
  const statePayloads: Record<string, any>[] = [];
  const toasts: string[][] = [];
  let interval: () => void = () => {};
  let holdSnapshot: Promise<void> | null = null;
  let stateUpdates = 0;
  let targetQueries = 0;
  let lyricCalls = 0;
  const clock = { now: 0 };
  const Bridge = runInNewContext(`${targetSource}\nconst mprisHelper = new HelperClient(ffi('mpris_endpoint'), ffi('mpris_reconnect'), fetch);\n${source}; MprisBridge`, {
    HelperClient,
    HelperConnectionError,
    steamToast: (title: string, artist: string) => { toasts.push([title, artist]); },
    navigator: { platform: options.platform ?? "Linux" },
    window: {
      setInterval(callback: () => void) { interval = callback; return 1; },
      clearInterval() {},
    },
    AbortController,
    Date: class { static now() { return clock.now; } },
    console: { warn() {} },
    ffi: (name: string) => async () => {
      endpointCalls.push(name);
      return name === "mpris_reconnect"
        ? options.reconnectEndpoint ?? "http://localhost|test-token"
        : options.endpoint ?? "http://localhost|test-token";
    },
    isPlayerDocument: () => true,
    commandScript: (command: { action: string }) => command.action,
    SNAPSHOT_SCRIPT: "snapshot",
    LYRICS_SCRIPT: "lyrics",
    ChromeDevToolsProtocol: {
      async send(method: string, params: { expression: string }) {
        if (method === "Target.getTargets") {
          targetQueries++;
          return { targetInfos: [{ targetId: "player", url: "player" }] };
        }
        if (method === "Target.attachToTarget") return { sessionId: "session" };
        if (method === "Runtime.evaluate") {
          evaluations.push(params.expression);
          if (params.expression === "snapshot") {
            await holdSnapshot;
            const snapshot = options.snapshot ? options.snapshot() : options.trackId
              ? { active: true, playbackStatus: "Playing", title: "歌名", artist: "歌手", trackId: options.trackId, duration: 100, position: 0 }
              : { active: true };
            return { result: { value: snapshot } };
          }
          if (params.expression === "lyrics") {
            lyricCalls++;
            return { result: { value: options.lyric ?? { lyric: "", resolved: true } } };
          }
          return { result: { value: true } };
        }
        return {};
      },
    },
    fetch: async (url: string, requestOptions: { signal: AbortSignal; headers: Record<string, string>; body?: string }) => {
      requests.push({ url, token: requestOptions.headers["X-NEMusic-Token"] });
      if (url.endsWith("/commands?wait=1")) {
        return new Promise((resolve, reject) => {
          polls.push({
            signal: requestOptions.signal,
            deliver: (commands) => resolve({ ok: true, json: async () => commands }),
            fail: () => reject(new Error("connection lost")),
          });
          requestOptions.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (url.endsWith("/state")) {
        stateUpdates++;
        statePayloads.push(JSON.parse(requestOptions.body!));
        if (options.failState) throw new Error("connection lost");
      }
      // The bridge drains the body of every state push; a real Response always offers the body.
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const bridge = new Bridge(() => {}, () => {}, () => options.notifyMode ?? "system");
  bridge.setEnabled(true);
  bridge.start();
  return {
    bridge, evaluations, polls, endpointCalls, requests, statePayloads, toasts,
    tick: () => interval(),
    holdSnapshot: (promise: Promise<void>) => { holdSnapshot = promise; },
    stateUpdates: () => stateUpdates,
    targetQueries: () => targetQueries,
    lyricCalls: () => lyricCalls,
    advance: (ms: number) => { clock.now += ms; },
  };
}

describe("网页切歌通知", () => {
  for (const notifyMode of ["system", "steam"] as const) {
    it(`${notifyMode} 通知不在切歌空档或媒体会话延迟更新时重复提示上一首`, async () => {
      const playing = { resourceTrackId: "1", resourceDuration: 100, resourceName: "上一首", resourceArtists: [{ name: "歌手一" }] };
      const source = { getState: () => ({ playing }), dispatch() {} };
      const mediaSession = { metadata: { title: "上一首", artist: "歌手一" }, playbackState: "playing" };
      const page = createContext({
        document: { querySelectorAll: () => [], querySelector: () => null },
        navigator: { mediaSession },
        __NEMusicOnSteamPlayerStore: source, __NEMusicOnSteamPlayerStoreSource: {},
      });
      const player = setup({ snapshot: () => runInContext(SNAPSHOT_SCRIPT, page), notifyMode });
      await flush();
      Object.assign(playing, { resourceTrackId: "", resourceName: "", resourceArtists: [] });
      player.tick();
      await flush();
      Object.assign(playing, { resourceTrackId: "2", resourceName: "下一首", resourceArtists: [{ name: "歌手二" }] });
      player.tick();
      await flush();
      mediaSession.metadata = { title: "下一首", artist: "歌手二" };
      player.tick();
      await flush();

      const songs = player.statePayloads.filter(state => state.title).map(state => [state.trackId, state.title, state.artist, state.notify]);
      assert.deepEqual(songs, [["1", "上一首", "歌手一", notifyMode], ["2", "下一首", "歌手二", notifyMode]]);
      assert.deepEqual(player.toasts, notifyMode === "steam" ? [["上一首", "歌手一"], ["下一首", "歌手二"]] : []);
      await player.bridge.stop();
    });
  }
});

describe("MPRIS command delivery", () => {
  it("executes incoming commands and publishes state without waiting for a timer", async () => {
    const player = setup();
    await flush();
    const queries = player.targetQueries();
    player.polls[0].deliver([{ action: "playpause" }, { action: "next" }]);
    await flush();
    assert.deepEqual(player.evaluations, ["snapshot", "playpause", "next", "snapshot"]);
    assert.equal(player.targetQueries(), queries);
    assert.equal(player.stateUpdates(), 2);
    assert.equal(player.polls.length, 2);
    await player.bridge.stop();
  });

  it("processes commands arriving during a snapshot as soon as it completes", async () => {
    const player = setup();
    await flush();
    let release!: () => void;
    player.holdSnapshot(new Promise<void>((resolve) => { release = resolve; }));
    player.tick();
    await flush();
    player.polls[0].deliver([{ action: "next" }]);
    await flush();
    assert.equal(player.evaluations.includes("next"), false);
    release();
    await flush();
    assert.deepEqual(player.evaluations, ["snapshot", "snapshot", "next", "snapshot"]);
    await player.bridge.stop();
  });

  it("keeps refreshing state while waiting for commands and cancels on stop", async () => {
    const player = setup();
    await flush();
    player.tick();
    await flush();
    assert.equal(player.stateUpdates(), 2);
    assert.equal(player.polls.length, 1);
    // The player page is attached once and reused; polling state must not re-query targets.
    assert.equal(player.targetQueries(), 1);
    await player.bridge.stop();
    assert.equal(player.polls[0].signal.aborted, true);
    player.polls[0].deliver([{ action: "next" }]);
    await flush();
    assert.equal(player.evaluations.includes("next"), false);
  });

  it("retries a failed command connection on the next state tick", async () => {
    const player = setup();
    await flush();
    player.polls[0].fail();
    await flush();
    assert.equal(player.polls.length, 1);
    player.tick();
    await flush();
    assert.equal(player.polls.length, 2);
    player.polls[1].deliver([{ action: "playpause" }]);
    await flush();
    assert.equal(player.evaluations.includes("playpause"), true);
    await player.bridge.stop();
  });

  it("does not publish an in-flight snapshot after stopping", async () => {
    const player = setup();
    await flush();
    let release!: () => void;
    player.holdSnapshot(new Promise<void>((resolve) => { release = resolve; }));
    player.tick();
    await flush();
    await player.bridge.stop();
    release();
    await flush();
    assert.equal(player.stateUpdates(), 1);
  });
});

describe("MPRIS manual reconnect", () => {
  it("reconnects immediately after helper startup fails and ignores repeated clicks", async () => {
    const player = setup({ endpoint: "!retry", reconnectEndpoint: "http://localhost:1234|new-token" });
    await flush();
    assert.equal(player.bridge.canReconnect(), true);
    player.bridge.reconnect();
    player.bridge.reconnect();
    assert.equal(player.bridge.canReconnect(), false);
    assert.equal(player.bridge.getStatus(), "正在重新连接 MPRIS");
    await flush();
    assert.deepEqual(player.endpointCalls, ["mpris_endpoint", "mpris_reconnect"]);
    assert.equal(player.bridge.getStatus(), "MPRIS 已连接");
    assert.equal(player.bridge.canReconnect(), false);
    assert.equal(player.stateUpdates(), 1);
    assert.equal(player.requests.every(request => request.token === "new-token"), true);
    player.polls[0].deliver([{ action: "playpause" }]);
    await flush();
    assert.equal(player.evaluations.includes("playpause"), true);
    await player.bridge.stop();
  });

  it("replaces a failed connection and republishes state with the new endpoint and token", async () => {
    const options = { failState: true, reconnectEndpoint: "http://localhost:1234|new-token" };
    const player = setup(options);
    await flush();
    assert.match(player.bridge.getStatus(), /连接失败/);
    assert.equal(player.bridge.canReconnect(), true);
    assert.equal(player.polls[0].signal.aborted, true);
    options.failState = false;
    const previousRequests = player.requests.length;
    player.bridge.reconnect();
    await flush();
    assert.equal(player.bridge.getStatus(), "MPRIS 已连接");
    assert.equal(player.stateUpdates(), 2);
    assert.equal(player.polls.length, 2);
    assert.deepEqual(player.requests.slice(previousRequests), [
      { url: "http://localhost:1234/commands?wait=1", token: "new-token" },
      { url: "http://localhost:1234/state", token: "new-token" },
    ]);
    await player.bridge.stop();
  });

  it("waits for an in-flight state tick before reconnecting without another timer tick", async () => {
    const player = setup({ endpoint: "!retry" });
    await flush();
    let release!: () => void;
    player.holdSnapshot(new Promise<void>((resolve) => { release = resolve; }));
    player.tick();
    await flush();
    player.bridge.reconnect();
    player.bridge.reconnect();
    assert.deepEqual(player.endpointCalls, ["mpris_endpoint", "mpris_endpoint"]);
    release();
    await flush();
    assert.deepEqual(player.endpointCalls, ["mpris_endpoint", "mpris_endpoint", "mpris_reconnect"]);
    assert.equal(player.bridge.getStatus(), "MPRIS 已连接");
    await player.bridge.stop();
  });

  it("allows another attempt if manual reconnect fails", async () => {
    const options = { endpoint: "!spawn", reconnectEndpoint: "!spawn:helper unavailable" };
    const player = setup(options);
    await flush();
    player.bridge.reconnect();
    await flush();
    assert.equal(player.bridge.canReconnect(), true);
    assert.match(player.bridge.getStatus(), /helper unavailable/);
    options.reconnectEndpoint = "http://localhost|new-token";
    player.bridge.reconnect();
    await flush();
    assert.equal(player.bridge.canReconnect(), false);
    assert.equal(player.bridge.getStatus(), "MPRIS 已连接");
    await player.bridge.stop();
  });

  it("does not offer reconnect on unsupported platforms or after stopping", async () => {
    const unsupported = setup({ platform: "Win32" });
    unsupported.bridge.reconnect();
    await flush();
    assert.equal(unsupported.bridge.canReconnect(), false);
    assert.equal(unsupported.bridge.getStatus(), "仅 Linux 支持 MPRIS");
    assert.deepEqual(unsupported.endpointCalls, []);
    await unsupported.bridge.stop();
    const player = setup({ endpoint: "!spawn" });
    await flush();
    await player.bridge.stop();
    player.bridge.reconnect();
    await flush();
    assert.equal(player.bridge.canReconnect(), false);
    assert.deepEqual(player.endpointCalls, ["mpris_endpoint"]);
  });
});

describe("MPRIS lyric lookup", () => {
  it("asks once for a song the API reported as having no lyrics", async () => {
    const player = setup({ trackId: "t1", lyric: { lyric: "", resolved: true } });
    await flush();
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 1);
    player.advance(30000);
    player.tick();
    await flush();
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 1);
    await player.bridge.stop();
  });

  it("keeps asking while the API has not answered", async () => {
    const player = setup({ trackId: "t1", lyric: { lyric: "", resolved: false } });
    await flush();
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 1);
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 1);
    player.advance(2000);
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 2);
    await player.bridge.stop();
  });

  it("reuses fetched lyrics for a track that keeps playing", async () => {
    const player = setup({ trackId: "t1", lyric: { lyric: "第一句\n第二句", resolved: true } });
    await flush();
    player.tick();
    await flush();
    player.advance(30000);
    player.tick();
    await flush();
    assert.equal(player.lyricCalls(), 1);
    await player.bridge.stop();
  });
});
