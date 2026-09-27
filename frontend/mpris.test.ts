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
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const evaluations: string[] = [];
  const polls: { signal: AbortSignal; deliver: (commands: unknown[]) => void; fail: () => void }[] = [];
  let interval: () => void = () => {};
  let holdSnapshot: Promise<void> | null = null;
  let stateUpdates = 0;
  let targetQueries = 0;
  const Bridge = runInNewContext(`${source}; MprisBridge`, {
    navigator: { platform: "Linux" },
    window: {
      setInterval(callback: () => void) { interval = callback; return 1; },
      clearInterval() {},
    },
    AbortController,
    console: { warn() {} },
    ffi: () => async () => "http://localhost|test-token",
    isPlayerDocument: () => true,
    commandScript: (command: { action: string }) => command.action,
    SNAPSHOT_SCRIPT: "snapshot",
    ChromeDevToolsProtocol: {
      async send(method: string, params: { expression: string }) {
        if (method === "Target.getTargets") {
          targetQueries++;
          return { targetInfos: [{ targetId: "player", url: "player" }] };
        }
        if (method === "Target.attachToTarget") return { sessionId: "session" };
        if (method === "Runtime.evaluate") {
          evaluations.push(params.expression);
          if (params.expression === "snapshot") await holdSnapshot;
          return { result: { value: params.expression === "snapshot" ? { active: true } : true } };
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
      return { ok: true };
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
