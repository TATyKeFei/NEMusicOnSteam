import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { sleepGuardScript } from "./sleep-player.ts";

function setup() {
  let plays = 0;
  const actions: string[] = [], listeners = new Set<() => void>();
  const state = { playing: { resourceTrackId: "1", playingVolume: 0.8 }, playingList: {} };
  const store = { getState: () => state, dispatch: (action: { type: string }) => { actions.push(action.type); } };
  const seed = { __reactFiber$test: { memoizedProps: { store } } };
  class Media {
    play() { plays++; return Promise.resolve(); }
    addEventListener(_name: string, listener: () => void) { listeners.add(listener); }
    removeEventListener(_name: string, listener: () => void) { listeners.delete(listener); }
  }
  const node = new Media();
  const context = { HTMLMediaElement: Media, document: { querySelector: () => seed, querySelectorAll: (selector: string) => selector === "audio, video" ? [] : [seed] }, Howler: { _howls: [{ _sounds: [{ _node: node }] }] } };
  return { context, state, actions, node, listeners, plays: () => plays };
}
describe("finish current track playback guard", () => {
  it("blocks detached Howler replay and next-track playback, then removes listeners", async () => {
    const p = setup(); runInNewContext(sleepGuardScript("1"), p.context); await p.node.play(); assert.equal(p.plays(), 1);
    for (const ended of p.listeners) ended(); await p.node.play(); assert.equal(p.plays(), 1);
    assert.equal(p.actions.at(-1), "playing/pause");
    runInNewContext(sleepGuardScript(null), p.context); assert.equal(p.listeners.size, 0); await p.node.play(); assert.equal(p.plays(), 2);
  });
  it("blocks a different track even before an ended event", async () => {
    const p = setup(); runInNewContext(sleepGuardScript("1"), p.context); p.state.playing.resourceTrackId = "2"; await p.node.play(); assert.equal(p.plays(), 0);
  });
  it("allows playback after cancellation even when another backend wraps play later", async () => {
    const p = setup(); runInNewContext(sleepGuardScript("1"), p.context);
    const guarded = p.context.HTMLMediaElement.prototype.play;
    p.context.HTMLMediaElement.prototype.play = function() { return guarded.apply(this); };
    p.state.playing.resourceTrackId = "2"; runInNewContext(sleepGuardScript(null), p.context);
    await p.node.play(); assert.equal(p.plays(), 1);
  });
});
