import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { CAPABILITIES_SCRIPT } from "./capabilities.ts";
import { SNAPSHOT_WATCH_SCRIPT } from "./player-access.ts";

function page(state: Record<string, any>) {
  const listeners = new Map<string, Function>();
  const timers = new Map<number, Function>();
  let serial = 0, unsubscribed = 0, subscriptions = 0;
  const store = { getState: () => state, dispatch() {}, subscribe(fn: Function) { subscriptions++; listeners.set("store", fn); return () => { unsubscribed++; }; } };
  const events: any[] = [];
  const context = {
    document: { querySelectorAll: () => [], querySelector: () => null,
      addEventListener(name: string, callback: Function) { listeners.set(name, callback); }, removeEventListener(name: string) { listeners.delete(name); } },
    navigator: {}, fetch() {}, window: { addEventListener(name: string, fn: Function) { listeners.set(name, fn); }, removeEventListener(name: string) { listeners.delete(name); } },
    __NEMusicOnSteamPlayerStore: store, __NEMusicOnSteamPlayerStoreSource: {},
    __NEMusicOnSteamEvent: (raw: string) => events.push(JSON.parse(raw)),
    setTimeout(fn: Function) { timers.set(++serial, fn); return serial; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: Function) { timers.set(++serial, fn); return serial; }, clearInterval(id: number) { timers.delete(id); },
  };
  return { context, events, listeners, timers, run: (script: string) => runInNewContext(script, context), subscriptions: () => subscriptions, unsubscribed: () => unsubscribed };
}
describe("web player compatibility and state subscription", () => {
  it("recognizes the actual Redux slices and leaves lazy together state pending", () => {
    const p = page({ playing: { playingVolume: 1 }, playingList: { curPlayingList: [] }, setting: { quantity: {} }, host: {} });
    const value = p.run(CAPABILITIES_SCRIPT);
    assert.equal(value.playback, true); assert.equal(value.queue, true); assert.equal(value.quality, true);
    assert.equal(value.together, null); assert.equal(value.download, true);
  });
  it("isolates a changed queue or quality schema from basic playback", () => {
    const value = page({ playing: { playingVolume: 1 }, 'async:listenTogether': {} }).run(CAPABILITIES_SCRIPT);
    assert.equal(value.playback, true); assert.equal(value.queue, false); assert.equal(value.quality, false); assert.equal(value.together, true);
  });
  it("publishes state after store changes, avoids duplicate subscriptions and cleans up", () => {
    const state = { playing: { playingVolume: 0.8, resourceTrackId: "1", resourceName: "第一首", resourceDuration: 100 } };
    const p = page(state);
    assert.equal(p.run(SNAPSHOT_WATCH_SCRIPT), true);
    assert.equal(p.events[0].state.trackId, "1");
    p.run(SNAPSHOT_WATCH_SCRIPT); assert.equal(p.subscriptions(), 1);
    state.playing.resourceTrackId = "2"; state.playing.resourceName = "第二首";
    p.listeners.get("store")!(); p.listeners.get("store")!();
    assert.equal(p.timers.size, 2); // 一个心跳、一个合并后的状态更新
    [...p.timers.values()].at(-1)!();
    assert.equal(p.events.at(-1).state.trackId, "2");
    p.listeners.get("pagehide")!(); assert.equal(p.unsubscribed(), 1); assert.equal(p.timers.size, 0);
  });
});
