import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { commandScript, SNAPSHOT_SCRIPT, type Command } from "./mpris-player.ts";

function playerFixture() {
  const state = {
    playing: {
      playingVolume: 0.42,
      resourceDuration: 240,
      resourceTrackId: "track-1",
      freeTrialInfo: null as { start: number; end: number } | null,
    },
  };
  const media = { volume: 1, currentTime: 30, duration: 240, paused: false, readyState: 4 };
  const commands: { type: string; payload: { volume?: number; duration?: number } }[] = [];
  let confirmVolume: (() => void) | null = null;
  const store = {
    getState: () => state,
    dispatch: async (action: typeof commands[number]) => {
      commands.push(action);
      if (action.type === "playing/setVolume") {
        confirmVolume = () => { state.playing.playingVolume = action.payload.volume!; };
      } else if (action.type === "playing/setPlayingPosition") {
        media.currentTime = action.payload.duration!;
      }
    },
  };
  const provider = { memoizedProps: { value: { store } }, return: null };
  const button = {
    __reactFiber$test: { return: provider },
    className: "play-pause-btn",
    classList: { contains: () => true },
    getAttribute: () => null,
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
    click: () => { media.paused = !media.paused; },
  };
  const input = { getAttribute: () => null, get value() { return String(media.currentTime); }, max: "240" };
  const progress = {
    matches: () => false,
    getAttribute: () => null,
    querySelector: () => input,
    getBoundingClientRect: () => ({ width: 400, height: 8 }),
    dispatchEvent: () => { throw new Error("Playback must not depend on synthetic dragging"); },
  };
  const context = {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("#root > *")) return [button];
        if (selector === "audio, video") return [media];
        if (selector.startsWith('[role="slider"]')) return [];
        if (selector.includes("播放进度调节")) return [progress];
        if (selector.includes("#btn_pc_minibar_play") || selector.startsWith("button,")) return [button];
        return [];
      },
    },
    navigator: { mediaSession: { metadata: { title: "Song", artist: "Artist" } } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  return {
    state, media, store, provider, commands,
    confirmVolume: () => confirmVolume?.(),
    snapshot: () => runInNewContext(SNAPSHOT_SCRIPT, context),
    command: (command: Command): Promise<boolean> => runInNewContext(commandScript(command), context),
  };
}

describe("NetEase MPRIS player control", () => {
  it("reads confirmed volume with the volume popup unmounted and an audio element at 100%", async () => {
    const player = playerFixture();
    assert.equal(player.snapshot().volume, 0.42);
    assert.equal(await player.command({ action: "volume", value: 0.25 }), true);
    assert.equal(player.snapshot().volume, 0.42);
    player.confirmVolume();
    for (let poll = 0; poll < 5; poll++) assert.equal(player.snapshot().volume, 0.25);
    assert.equal(await player.command({ action: "volume", value: 0 }), true);
    player.confirmVolume();
    assert.equal(player.snapshot().volume, 0);
    assert.equal(await player.command({ action: "volume", value: 0.6 }), true);
    player.confirmVolume();
    assert.equal(player.snapshot().volume, 0.6);
  });

  it("seeks through the playback action when the slider has a hidden input and no role slider", async () => {
    const player = playerFixture();
    assert.equal(await player.command({ action: "setposition", value: 90000000 }), true);
    assert.equal(player.media.currentTime, 90);
    for (let poll = 0; poll < 5; poll++) assert.equal(player.snapshot().position, 90);
    assert.equal(await player.command({ action: "seek", value: -15000000 }), true);
    assert.equal(player.media.currentTime, 75);
    assert.deepEqual(JSON.parse(JSON.stringify(player.commands)), [
      { type: "playing/setPlayingPosition", payload: { duration: 90 } },
      { type: "playing/setPlayingPosition", payload: { duration: 75 } },
    ]);
  });

  it("honors trial offsets and limits when seeking", async () => {
    const player = playerFixture();
    player.state.playing.freeTrialInfo = { start: 60, end: 120 };
    await player.command({ action: "setposition", value: 90000000 });
    assert.equal(player.media.currentTime, 30);
    await player.command({ action: "setposition", value: 200000000 });
    assert.equal(player.media.currentTime, 60);
    await player.command({ action: "setposition", value: -1000000 });
    assert.equal(player.media.currentTime, 0);
  });

  it("reports unavailable control instead of changing only the DOM or reporting 100%", async () => {
    const player = playerFixture();
    Object.assign(player.provider, { memoizedProps: {} });
    assert.equal(await player.command({ action: "volume", value: 0.3 }), false);
    assert.equal(await player.command({ action: "setposition", value: 90000000 }), false);
    assert.equal(player.snapshot().volume, null);
    assert.equal(player.media.currentTime, 30);
    assert.equal(player.commands.length, 0);
  });

  it("finds the store from React context dependencies", async () => {
    const player = playerFixture();
    Object.assign(player.provider, { memoizedProps: {}, dependencies: { firstContext: { memoizedValue: { store: player.store }, next: null } } });
    assert.equal(player.snapshot().volume, 0.42);
    assert.equal(await player.command({ action: "setposition", value: 60000000 }), true);
    assert.equal(player.media.currentTime, 60);
  });

  it("waits for the application's command and rejects invalid values", async () => {
    const player = playerFixture();
    let finish: (() => void) | undefined;
    player.store.dispatch = () => new Promise<void>(resolve => { finish = resolve; });
    let completed = false;
    const pending = player.command({ action: "setposition", value: 90000000 }).then(result => { completed = result; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.ok(finish);
    finish();
    await pending;
    assert.equal(completed, true);
    assert.equal(await player.command({ action: "volume", value: NaN }), false);
    assert.equal(await player.command({ action: "seek", value: NaN }), false);
  });
});
