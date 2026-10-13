import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { QualityState } from "./quality-player.ts";
import { QUALITY_OPTIONS } from "./quality-player.ts";
import type { QualitySnapshot } from "./quality.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./quality.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type Bridge = {
  setEnabled: (enabled: boolean) => void;
  setQuality: (value: number) => void;
  snapshot: () => QualitySnapshot;
  tick: () => Promise<void>;
};

function fixture() {
  const evaluations: string[] = [];
  const state: QualityState = { available: true, preferred: 320, current: 320, playing: true };
  let action: number | null = null;
  let installed = true;
  let failure = "";
  let heldCommand: Promise<void> | null = null;
  const timers = new Map<number, () => void>();
  const BridgeClass = runInNewContext(`${source}; QualityBridge`, {
    Error,
    QUALITY_OPTIONS,
    QUALITY_SNAPSHOT_SCRIPT: "state",
    qualityButtonScript: () => "install",
    qualityButtonUpdateScript: () => "poll",
    qualityButtonResultScript: (message: string) => `result:${message}`,
    qualityCommandScript: (value: number) => `command:${value}`,
    window: { setInterval: (callback: () => void) => { timers.set(1, callback); return 1; }, clearInterval: (id: number) => { timers.delete(id); } },
    evaluateInPlayer: async (script: string) => {
      evaluations.push(script);
      if (script.startsWith("command:")) {
        await heldCommand;
        if (failure) throw new Error(failure);
        state.preferred = Number(script.slice("command:".length));
        return { state: { ...state }, message: "已保存并请求切换" };
      }
      if (script === "poll" && !installed) return { installed: false };
      if (script === "poll" || script === "install") {
        installed = true;
        const request = action;
        action = null;
        return { installed: true, state: { ...state }, action: request };
      }
      return true;
    },
  }) as new () => Bridge;
  const bridge = new BridgeClass();
  return {
    bridge, evaluations, state, timers,
    request: (value: number) => { action = value; },
    reload: () => { installed = false; },
    reject: (message: string) => { failure = message; },
    hold: (promise: Promise<void>) => { heldCommand = promise; },
  };
}

describe("quality menu bridge", () => {
  it("installs the button on enable and reinstalls it after page reload", async () => {
    const player = fixture();
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.evaluations[0], "install");
    assert.equal(player.bridge.snapshot().available, true);
    player.reload();
    await player.bridge.tick();
    assert.deepEqual(player.evaluations.slice(-2), ["poll", "install"]);
  });

  it("runs a playback bar request once and reports the confirmed preference and actual quality", async () => {
    const player = fixture();
    player.bridge.setEnabled(true);
    await flush();
    player.request(1999);
    await player.bridge.tick();
    await flush();
    assert.equal(player.evaluations.filter(script => script === "command:1999").length, 1);
    assert.ok(player.evaluations.includes("result:已保存并请求切换"));
    assert.equal(player.bridge.snapshot().preferred, 1999);
    assert.equal(player.bridge.snapshot().current, 320);
    assert.equal(player.bridge.snapshot().updating, false);
  });

  it("returns command errors to the menu and permits a new selection", async () => {
    const player = fixture();
    player.bridge.setEnabled(true);
    await flush();
    player.reject("请先登录");
    player.request(999);
    await player.bridge.tick();
    await flush();
    assert.ok(player.evaluations.includes("result:请先登录"));
    assert.equal(player.bridge.snapshot().updating, false);
    assert.equal(player.bridge.snapshot().preferred, 320);
    player.reject("");
    player.bridge.setQuality(128);
    await flush();
    assert.equal(player.bridge.snapshot().preferred, 128);
  });

  it("shares the command path with settings and ignores duplicate requests while updating", async () => {
    const player = fixture();
    player.bridge.setEnabled(true);
    await flush();
    let release!: () => void;
    player.hold(new Promise<void>(resolve => { release = resolve; }));
    player.bridge.setQuality(999);
    player.bridge.setQuality(1999);
    assert.equal(player.bridge.snapshot().updating, true);
    release();
    await flush();
    assert.ok(player.evaluations.includes("command:999"));
    assert.equal(player.evaluations.includes("command:1999"), false);
    assert.equal(player.bridge.snapshot().preferred, 999);
  });

  it("does not report a stale command result after the player closes", async () => {
    const player = fixture();
    player.bridge.setEnabled(true);
    await flush();
    let release!: () => void;
    player.hold(new Promise<void>(resolve => { release = resolve; }));
    player.bridge.setQuality(999);
    player.bridge.setEnabled(false);
    release();
    await flush();
    assert.equal(player.timers.size, 0);
    assert.equal(player.bridge.snapshot().available, false);
    assert.equal(player.evaluations.some(script => script.startsWith("result:")), false);
  });
});
