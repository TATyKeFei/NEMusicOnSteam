import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

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

function setup(options: { trackId?: string; lyric?: unknown } = {}) {
  const evaluations: string[] = [];
  const polls: { signal: AbortSignal; deliver: (commands: unknown[]) => void; fail: () => void }[] = [];
  let interval: () => void = () => {};
  let holdSnapshot: Promise<void> | null = null;
  let stateUpdates = 0;
  let targetQueries = 0;
  let lyricCalls = 0;
  const clock = { now: 0 };
  const Bridge = runInNewContext(`${targetSource}\n${source}; MprisBridge`, {
    navigator: { platform: "Linux" },
    window: {
      setInterval(callback: () => void) { interval = callback; return 1; },
      clearInterval() {},
    },
    AbortController,
    Date: class { static now() { return clock.now; } },
    console: { warn() {} },
    ffi: () => async () => "http://localhost|test-token",
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
            const snapshot = options.trackId
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
    fetch: async (url: string, options: { signal: AbortSignal }) => {
      if (url.endsWith("/commands?wait=1")) {
        return new Promise((resolve, reject) => {
          polls.push({
            signal: options.signal,
            deliver: (commands) => resolve({ ok: true, json: async () => commands }),
            fail: () => reject(new Error("connection lost")),
          });
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (url.endsWith("/state")) stateUpdates++;
      // The bridge drains the body of every state push; a real Response always offers the body.
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const bridge = new Bridge(() => {}, () => {});
  bridge.setEnabled(true);
  bridge.start();
  return {
    bridge, evaluations, polls,
    tick: () => interval(),
    holdSnapshot: (promise: Promise<void>) => { holdSnapshot = promise; },
    stateUpdates: () => stateUpdates,
    targetQueries: () => targetQueries,
    lyricCalls: () => lyricCalls,
    advance: (ms: number) => { clock.now += ms; },
  };
}

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
