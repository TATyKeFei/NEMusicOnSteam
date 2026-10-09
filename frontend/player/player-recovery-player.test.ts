import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { PLAYER_URL } from "../constants.ts";
import { PLAYER_READY_SCRIPT, PLAYER_RECOVERY_SCRIPT, PLAYER_RECOVERY_CHECKPOINT_SCRIPT, PLAYER_RECOVERY_CLEAR_SCRIPT, PLAYER_RETIRE_SCRIPT, playerRestoreScript, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";

function setup(options: { owned?: boolean; playing?: boolean } = {}) {
  const actions: { type: string; payload?: Record<string, unknown> }[] = [];
  const current = { resourceId: "123", track: { id: "123", name: "song" } };
  const queue = [current, { resourceId: "456", track: { id: "456" } }];
  const state = {
    playing: {
      resourceDuration: 240,
      resourceTrackId: "123",
      playingVolume: 0.4,
      playingState: options.playing === false ? 1 : 2,
      playingMode: "playCycle",
      curPlaying: current,
    },
    playingList: { curPlayingList: queue },
    download: {},
    "async:listenTogetherPlayList": { vipTrackNumAndType: {} },
    "async:listenTogetherPlayStatus": { status: "alone" },
    "async:cloudList": { cloudUploadingList: [] },
  };
  const store = {
    getState: () => state,
    dispatch(action: { type: string; payload?: Record<string, unknown> }) {
      actions.push(action);
      if (action.type === "playing/setPlaying") state.playing.resourceTrackId = String((action.payload?.trackIn as typeof current).resourceId);
    },
  };
  const seed = { __reactFiber$test: { memoizedProps: { store } } };
  let actualPlays = 0;
  class Media {
    currentTime = 82;
    paused = false;
    ended = false;
    muted = false;
    volume = 0.4;
    play() { actualPlays++; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const detached = new Media();
  let stops = 0;
  const context = {
    URL,
    location: { href: PLAYER_URL },
    __NEMusicOnSteamViewToken: options.owned === false ? null : "player-id",
    document: {
      querySelectorAll: (selector: string) => selector === "audio, video" ? [] : [seed],
      querySelector: (selector: string) => selector === '#page_pc_mini_bar' || selector === '#btn_pc_minibar_play' ? seed : null,
    },
    HTMLMediaElement: Media,
    Howler: { _howls: [{ _sounds: [{ _node: detached }], stop() { stops++; } }] },
    setTimeout,
  };
  return { context, state, actions, detached, actualPlays: () => actualPlays, stops: () => stops };
}

describe("player recovery state", () => {
  it("waits for the mini bar and lazy Redux models before declaring the webpage ready", async () => {
    const runtime = setup();
    const together = runtime.state['async:listenTogetherPlayList'];
    delete (runtime.state as Partial<typeof runtime.state>)['async:listenTogetherPlayList'];
    let waited = 0;
    runtime.context.setTimeout = ((callback: () => void) => {
      assert.equal(runtime.actions.length, 0);
      waited++;
      runtime.state['async:listenTogetherPlayList'] = together;
      callback();
    }) as typeof setTimeout;
    assert.equal(await runInNewContext(PLAYER_READY_SCRIPT, runtime.context), true);
    assert.equal(waited, 1);
  });

  it("does not restore into a store whose lazy models are not registered yet", async () => {
    const runtime = setup();
    const snapshot = runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context).snapshot as PlayerRecoverySnapshot;
    const cloud = runtime.state['async:cloudList'];
    delete (runtime.state as Partial<typeof runtime.state>)['async:cloudList'];
    let waited = 0;
    runtime.context.setTimeout = ((callback: () => void) => {
      assert.equal(runtime.actions.length, 0);
      waited++;
      runtime.state['async:cloudList'] = cloud;
      callback();
    }) as typeof setTimeout;
    assert.equal(await runInNewContext(playerRestoreScript(snapshot), runtime.context), true);
    assert.equal(waited, 1);
  });

  it("times out safely without dispatching when React has not rendered the player", async () => {
    const runtime = setup();
    const snapshot = runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context).snapshot as PlayerRecoverySnapshot;
    runtime.context.document.querySelector = () => null;
    runtime.context.setTimeout = ((callback: () => void) => { callback(); }) as typeof setTimeout;
    assert.equal(await runInNewContext(PLAYER_READY_SCRIPT, runtime.context), false);
    await assert.rejects(runInNewContext(playerRestoreScript(snapshot), runtime.context), /初始化/);
    assert.equal(runtime.actions.length, 0);
  });

  it("captures the playing song, queue, volume and detached Howler position", () => {
    const runtime = setup();
    const result = runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context);
    assert.equal(result.owned, true);
    assert.equal(result.snapshot.current.resourceId, "123");
    assert.equal(result.snapshot.queue.length, 2);
    assert.equal(result.snapshot.position, 82);
    assert.equal(result.snapshot.playing, true);
    assert.equal(result.snapshot.volume, 0.4);
    assert.equal(result.snapshot.mode, "playCycle");
  });

  it("does not claim an unrelated NetEase page", () => {
    assert.equal(runInNewContext(PLAYER_RECOVERY_SCRIPT, setup({ owned: false }).context), null);
  });

  it("stops detached audio and blocks future HTML audio play calls before closure", async () => {
    const runtime = setup();
    assert.equal(await runInNewContext(PLAYER_RETIRE_SCRIPT, runtime.context), true);
    assert.equal(runtime.detached.paused, true);
    assert.equal(runtime.detached.muted, true);
    assert.equal(runtime.detached.volume, 0);
    assert.equal(runtime.stops(), 1);
    await runtime.detached.play();
    assert.equal(runtime.actualPlays(), 0);
    assert.equal(runtime.actions.at(-1)?.type, "playing/pause");
  });

  it("restores through the official trackIn action shape and seeks to the original position", async () => {
    const runtime = setup();
    const snapshot = runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context).snapshot as PlayerRecoverySnapshot;
    assert.equal(await runInNewContext(playerRestoreScript(snapshot), runtime.context), true);
    const play = runtime.actions.find(action => action.type === "playing/setPlaying");
    assert.equal((play?.payload?.trackIn as { resourceId: string }).resourceId, "123");
    assert.equal(play?.payload?.playingState, 2);
    assert.equal(play?.payload?.noAddToHistory, true);
    assert.equal(runtime.actions.find(action => action.type === "playing/setPlayingPosition")?.payload?.duration, 82);
    assert.equal((runtime.actions.find(action => action.type === "playingList/onUpdate")?.payload?.curPlayingList as unknown[]).length, 2);
  });

  it("keeps a paused song paused after recovering", async () => {
    const runtime = setup({ playing: false });
    const snapshot = runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context).snapshot as PlayerRecoverySnapshot;
    await runInNewContext(playerRestoreScript(snapshot), runtime.context);
    assert.equal(runtime.actions.find(action => action.type === "playing/setPlaying")?.payload?.playingState, 1);
    assert.equal((runtime.actions.find(action => action.type === "playing/onUpdate" && action.payload?.restoreResource)?.payload?.restoreResource as { current: number }).current, 82);
    assert.equal(runtime.actions.at(-1)?.type, "playing/pause");
  });

  it("still recognizes a broken player from the previous query-parameter build", () => {
    const runtime = setup({ owned: false });
    runtime.context.location.href = PLAYER_URL + "?nemusic_view=legacy";
    assert.equal(runInNewContext(PLAYER_RECOVERY_SCRIPT, runtime.context).owned, true);
  });

  it("only restores recent checkpoints and clears them after success", () => {
    const saved = { savedAt: Date.now(), snapshot: { current: { resourceId: "123" } } };
    let value: string | null = JSON.stringify(saved);
    const context = { localStorage: { getItem: () => value, removeItem() { value = null; } } };
    assert.equal(runInNewContext(PLAYER_RECOVERY_CHECKPOINT_SCRIPT, context).current.resourceId, "123");
    runInNewContext(PLAYER_RECOVERY_CLEAR_SCRIPT, context);
    assert.equal(value, null);
    value = JSON.stringify({ ...saved, savedAt: Date.now() - 600000 });
    assert.equal(runInNewContext(PLAYER_RECOVERY_CHECKPOINT_SCRIPT, context), null);
  });
});
