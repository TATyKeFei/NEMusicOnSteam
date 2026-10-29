import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./web-preload.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  let enabled = true, serial = 0, installed = false;
  let gate: Promise<void> | null = null;
  const calls: string[] = [], timers = new Map<number, () => void>();
  const Bridge = runInNewContext(`${source}; WebPreloadBridge`, {
    window: { setInterval: (fn: () => void) => { timers.set(++serial, fn); return serial; }, clearInterval: (id: number) => { timers.delete(id); } },
    WEB_PRELOAD_CLEAR_SCRIPT: "clear", WEB_PRELOAD_UPDATE_SCRIPT: "update", webPreloadScript: () => "install", console: { warn() {} },
    tryEvaluateInPlayer: async (expression: string) => {
      calls.push(expression);
      if (expression === "clear") { installed = false; return true; }
      if (expression === "update") return { installed, status: "下一首已有可播放缓冲" };
      if (gate) await gate;
      installed = true; return { installed: true, status: "正在缓冲下一首" };
    },
  });
  const bridge = new Bridge(() => enabled);
  return { bridge, calls, timers, installed: () => installed, setting(value: boolean) { enabled = value; }, hold(value: Promise<void>) { gate = value; },
    async tick() { for (const fn of timers.values()) fn(); await flush(); }, pageReload() { installed = false; } };
}
describe("web preload bridge", () => {
  it("uses a small update script in steady state and reinstalls only after page reload", async () => {
    const p = setup(); p.bridge.setEnabled(true); await flush();
    assert.equal(p.calls.filter(call => call.includes("const installed = install")).length, 1);
    await p.tick(); await p.tick(); assert.equal(p.calls.filter(call => call === "update").length, 2);
    assert.equal(p.calls.filter(call => call.includes("const installed = install")).length, 1);
    assert.match(p.bridge.getStatus(), /可播放缓冲/);
    p.pageReload(); await p.tick(); assert.equal(p.calls.filter(call => call.includes("const installed = install")).length, 2);
  });
  it("has no polling interval while disabled and starts when the setting becomes enabled", async () => {
    const p = setup(); p.setting(false); p.bridge.setEnabled(true); await flush(); assert.equal(p.timers.size, 0);
    p.setting(true); p.bridge.refresh(); await flush(); assert.equal(p.timers.size, 1);
    p.bridge.setEnabled(false); await flush(); assert.equal(p.timers.size, 0); assert.equal(p.installed(), false);
  });
  it("removes a late installation after disable", async () => {
    const p = setup(); let release!: () => void; p.hold(new Promise(resolve => { release = resolve; }));
    p.bridge.setEnabled(true); await flush(); p.bridge.setEnabled(false); await flush();
    release(); await flush(); assert.equal(p.installed(), false); assert.equal(p.timers.size, 0); assert.equal(p.calls.at(-1), "clear");
  });
});
