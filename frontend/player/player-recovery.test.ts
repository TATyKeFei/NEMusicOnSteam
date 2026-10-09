import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { isPlayerDocument, PLAYER_URL } from "../constants.ts";
import { PLAYER_RECOVERY_SCRIPT, PLAYER_RETIRE_SCRIPT, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";

const source = stripTypeScriptTypes(readFileSync(new URL("./player-recovery.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace(/^export /gm, ""));

function setup(options: { closeFails?: boolean; neverCloses?: boolean; stopFails?: boolean; navigationFails?: boolean; navigationStalls?: boolean; waitForNativeDestroy?: boolean; waitForDetach?: boolean } = {}) {
  const events: string[] = [];
  const states = new Map<string, { owned: boolean; snapshot: PlayerRecoverySnapshot | null }>();
  let targets: { targetId: string; url: string }[] = [];
  const sessions = new Set<string>();
  const closing = new Set<string>();
  let nativeDestroyed = false;
  const updateTargets = () => {
    targets = targets.filter(target => !closing.has(target.targetId)
      || (options.waitForNativeDestroy && !nativeDestroyed)
      || (options.waitForDetach && sessions.has(target.targetId)));
  };
  const retire = runInNewContext(`${source}; retirePlayerTargets`, {
    isPlayerDocument,
    PLAYER_RECOVERY_SCRIPT,
    PLAYER_RETIRE_SCRIPT,
    window: { setTimeout: (callback: () => void) => { callback(); } },
    ChromeDevToolsProtocol: {
      async send(method: string, params?: { targetId?: string; expression?: string; sessionId?: string }, sessionId?: string) {
        if (method === "Target.getTargets") { updateTargets(); return { targetInfos: [...targets] }; }
        if (method === "Target.attachToTarget") { sessions.add(params!.targetId!); return { sessionId: params?.targetId }; }
        if (method === "Target.detachFromTarget") { sessions.delete(params!.sessionId!); return {}; }
        if (method === "Page.navigate") {
          events.push("blank:" + sessionId);
          if (options.navigationFails) return { errorText: "navigation failed" };
          if (!options.navigationStalls) targets = targets.map(target => target.targetId === sessionId ? { ...target, url: "about:blank" } : target);
          return { frameId: sessionId };
        }
        if (method === "Runtime.evaluate") {
          if (params?.expression === PLAYER_RECOVERY_SCRIPT) return { result: { value: states.get(sessionId!) } };
          if (params?.expression?.startsWith("localStorage.setItem")) return { result: { value: true } };
          events.push("stop:" + sessionId);
          return { result: { value: !options.stopFails } };
        }
        if (method === "Target.closeTarget") {
          events.push("close:" + params?.targetId);
          if (!options.closeFails && !options.neverCloses) closing.add(params!.targetId!);
          return { success: !options.closeFails };
        }
        throw new Error(method);
      },
    },
  }) as (destroyNative?: () => void) => Promise<PlayerRecoverySnapshot | null>;
  return {
    retire,
    events,
    destroyNative() { nativeDestroyed = true; events.push("destroy-native"); },
    add(id: string, owned: boolean, playing: boolean) {
      targets.push({ targetId: id, url: PLAYER_URL });
      states.set(id, { owned, snapshot: { href: PLAYER_URL, current: { resourceId: id }, queue: [], position: 82, playing, volume: 0.4, mode: "playCycle" } });
    },
  };
}

describe("old player target retirement", () => {
  it("closes every plugin player but leaves unrelated NetEase pages alone", async () => {
    const runtime = setup();
    runtime.add("paused", true, false);
    runtime.add("playing", true, true);
    runtime.add("external", false, true);
    const snapshot = await runtime.retire();
    assert.equal(snapshot?.current?.resourceId, "playing");
    assert.deepEqual(runtime.events, ["stop:paused", "stop:playing", "close:paused", "close:playing"]);
  });

  it("unloads the old document if CEF refuses to close its native target", async () => {
    const runtime = setup({ closeFails: true });
    runtime.add("old", true, true);
    const snapshot = await runtime.retire();
    assert.equal(snapshot?.current?.resourceId, "old");
    assert.deepEqual(runtime.events, ["stop:old", "close:old", "blank:old", "close:old"]);
  });

  it("unloads orphaned BrowserViews when close succeeds but the target never disappears", async () => {
    const runtime = setup({ neverCloses: true });
    runtime.add("old", true, true);
    assert.equal((await runtime.retire())?.current?.resourceId, "old");
    assert.deepEqual(runtime.events, ["stop:old", "close:old", "blank:old", "close:old"]);
  });

  it("does not permit replacement if neither closing nor unloading works", async () => {
    const runtime = setup({ neverCloses: true, navigationFails: true });
    runtime.add("old", true, true);
    await assert.rejects(runtime.retire(), /navigation failed/);
  });

  it("checks that the old document actually unloaded rather than trusting navigation success", async () => {
    const runtime = setup({ neverCloses: true, navigationStalls: true });
    runtime.add("old", true, true);
    await assert.rejects(runtime.retire(), /超时/);
  });

  it("releases debugger sessions before waiting for CEF to close the target", async () => {
    const runtime = setup({ waitForDetach: true });
    runtime.add("old", true, true);
    assert.equal((await runtime.retire())?.current?.resourceId, "old");
    assert.deepEqual(runtime.events, ["stop:old", "close:old"]);
  });

  it("stops and saves every player before destroying its native view and waiting for closure", async () => {
    const runtime = setup({ waitForNativeDestroy: true });
    runtime.add("paused", true, false);
    runtime.add("playing", true, true);
    assert.equal((await runtime.retire(runtime.destroyNative))?.current?.resourceId, "playing");
    assert.deepEqual(runtime.events, ["stop:paused", "stop:playing", "destroy-native", "close:paused", "close:playing"]);
  });

  it("fails safely if the old audio cannot be stopped", async () => {
    const runtime = setup({ stopFails: true });
    runtime.add("old", true, true);
    await assert.rejects(runtime.retire(), /无法停止/);
    assert.deepEqual(runtime.events, ["stop:old"]);
  });

  it("allows the first player when no previous page exists", async () => {
    assert.equal(await setup().retire(), null);
  });

  it("prefers the original playing target when duplicate pages already exist", async () => {
    const runtime = setup();
    runtime.add("original", true, true);
    runtime.add("duplicate", true, true);
    assert.equal((await runtime.retire())?.current?.resourceId, "original");
    assert.deepEqual(runtime.events, ["stop:original", "stop:duplicate", "close:original", "close:duplicate"]);
  });
});
