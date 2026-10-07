import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./fullscreen.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type ButtonState = { active: boolean; fillWindow: boolean; request: number };
type Bridge = {
  setEnabled(enabled: boolean): void;
  refresh(callback: (active: boolean, fillWindow: boolean) => void): void;
};

function setup() {
  const events: [boolean, boolean][] = [];
  let state: ButtonState = { active: false, fillWindow: false, request: 0 };
  let heldState: Promise<ButtonState> | null = null;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const BridgeClass = runInNewContext(`${source}; FullscreenButtonBridge`, {
    window: {
      setInterval(callback: () => void) { timers.set(++timerId, callback); return timerId; },
      clearInterval(id: number) { timers.delete(id); },
    },
    console: { warn() {} },
    PLAYER_TARGET_MISSING: "missing",
    fullscreenButtonScript: () => "install",
    fullscreenButtonUpdateScript: () => "update",
    fullscreenButtonStateScript: () => "state",
    evaluateInPlayer: async (expression: string) => expression === "state" ? heldState ?? state : true,
  }) as new () => Bridge;
  const bridge = new BridgeClass();
  const callback = (active: boolean, fillWindow: boolean) => { events.push([active, fillWindow]); };
  return {
    bridge,
    events,
    callback,
    timers,
    setState(next: ButtonState) { state = next; },
    holdState(promise: Promise<ButtonState> | null) { heldState = promise; },
  };
}

describe("fullscreen button requests", () => {
  it("forwards window fill and exit requests exactly once", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    player.setState({ active: true, fillWindow: true, request: 1 });
    player.bridge.refresh(player.callback);
    await flush();
    player.bridge.refresh(player.callback);
    await flush();
    assert.deepEqual(player.events, [[true, true]]);
    player.setState({ active: false, fillWindow: false, request: 2 });
    player.bridge.refresh(player.callback);
    await flush();
    assert.deepEqual(player.events, [[true, true], [false, false]]);
  });

  it("keeps ordinary clicks as desktop fullscreen requests", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    player.setState({ active: true, fillWindow: false, request: 1 });
    player.bridge.refresh(player.callback);
    await flush();
    assert.deepEqual(player.events, [[true, false]]);
  });

  it("ignores a pending old request after disable and re-enable", async () => {
    const player = setup();
    let resolveState!: (state: ButtonState) => void;
    player.holdState(new Promise(resolve => { resolveState = resolve; }));
    player.bridge.setEnabled(true);
    player.bridge.refresh(player.callback);
    player.bridge.setEnabled(false);
    assert.equal(player.timers.size, 0);
    player.holdState(null);
    player.bridge.setEnabled(true);
    player.setState({ active: true, fillWindow: false, request: 1 });
    player.bridge.refresh(player.callback);
    resolveState({ active: true, fillWindow: true, request: 2 });
    await flush();
    assert.deepEqual(player.events, [[true, false]]);
  });
});
