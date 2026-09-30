import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { QUALITY_OPTIONS, QUALITY_SNAPSHOT_SCRIPT, qualityCommandScript, qualityLabel } from "./quality-player.ts";

function qualityFixture() {
  const state = {
    host: { isAnonymous: false, isPlusVip: true, isVinylVip: false },
    setting: { quantity: { listen: 320, listenReg: 320, listenAnon: 128, download: 999 } },
    playing: {
      playingVolume: 0.4,
      playingState: 2,
      resourcePlayingQuality: 320,
      resourceTrackId: "song-1",
      resourceDuration: 240,
      resourceType: "track",
      curPlaying: { resourceId: "song-1" },
      trackFileType: "online",
      isLoadingFirst: false,
    },
  };
  const actions: { type: string; payload: Record<string, unknown> }[] = [];
  const media = { paused: false, currentTime: 75, duration: 240, readyState: 4 };
  const store = {
    getState: () => state,
    dispatch: async (action: typeof actions[number]) => {
      actions.push(action);
      if (action.type === "setting/updateQuantity") Object.assign(state.setting.quantity, action.payload);
    },
  };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const context = {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector.includes("#root > *") ? [root] : selector === "audio, video" ? [media] : [],
    },
    navigator: { mediaSession: { metadata: { title: "Song", artist: "Artist" } } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  return {
    state, actions, media, store, context,
    read: () => runInNewContext(QUALITY_SNAPSHOT_SCRIPT, context),
    set: (value: number) => runInNewContext(qualityCommandScript(value), context),
  };
}

describe("NetEase playback quality", () => {
  it("persists the account preference and switches the current song at its existing position", async () => {
    const player = qualityFixture();
    const result = await player.set(1999);
    assert.equal(result.state.preferred, 1999);
    assert.equal(result.state.current, 320);
    assert.deepEqual(JSON.parse(JSON.stringify(player.actions)), [
      { type: "setting/updateQuantity", payload: { listen: 1999, listenReg: 1999 } },
      { type: "playing/switchQuality", payload: { quality: { quality: 1999, type: "soundQuality" }, current: 75, triggerScene: "miniBar" } },
    ]);
    assert.equal(player.state.setting.quantity.download, 999);
    assert.equal(player.state.setting.quantity.listenAnon, 128);
    assert.equal(player.media.currentTime, 75);
  });

  it("reports the actual fallback quality separately from the requested preference", async () => {
    const player = qualityFixture();
    await player.set(4999);
    player.state.playing.resourcePlayingQuality = 999;
    assert.equal(player.read().preferred, 4999);
    assert.equal(player.read().current, 999);
    assert.equal(player.read().playing, true);
  });

  it("does not resume paused songs or reload local files, podcasts, or a song still loading", async () => {
    for (const changes of [{ playingState: 1 }, { trackFileType: "local" }, { resourceType: "voice" }, { isLoadingFirst: true }, { resourceTrackId: "" }]) {
      const player = qualityFixture();
      Object.assign(player.state.playing, changes);
      const result = await player.set(999);
      assert.equal(result.state.preferred, 999);
      assert.equal(player.actions.length, 1);
      assert.match(result.message, /下一首/);
    }
  });

  it("stores anonymous settings separately and requests login before selecting higher quality", async () => {
    const player = qualityFixture();
    player.state.host.isAnonymous = true;
    assert.equal(player.read().preferred, 128);
    await player.set(320);
    assert.equal(player.state.setting.quantity.listenAnon, 320);
    assert.equal(player.state.setting.quantity.listenReg, 320);
    player.actions.length = 0;
    await assert.rejects(player.set(999), /登录/);
    assert.equal(player.actions.length, 0);
  });

  it("rejects unrecognized values and a missing player store without reporting success", async () => {
    const player = qualityFixture();
    for (const value of [0, 100000, NaN, Infinity]) await assert.rejects(player.set(value), /不支持/);
    assert.equal(player.actions.length, 0);
    player.context.document.querySelectorAll = () => [];
    assert.equal(player.read().available, false);
    await assert.rejects(player.set(320), /尚未就绪/);
    assert.equal(player.actions.length, 0);
  });

  it("does not reload a song if NetEase does not confirm the saved preference", async () => {
    const player = qualityFixture();
    player.store.dispatch = async action => { player.actions.push(action); };
    await assert.rejects(player.set(999), /未确认/);
    assert.equal(player.actions.length, 1);
    assert.equal(player.read().preferred, 320);
  });

  it("uses NetEase's spatial audio type for surround quality", async () => {
    const player = qualityFixture();
    await player.set(5999);
    assert.deepEqual(JSON.parse(JSON.stringify(player.actions[1].payload.quality)), { quality: 5999, type: "envSound" });
  });

  it("saves the preference without interrupting playback when membership does not allow the quality", async () => {
    const player = qualityFixture();
    player.state.host.isPlusVip = false;
    player.state.host.isVinylVip = true;
    const result = await player.set(4999);
    assert.equal(result.state.preferred, 4999);
    assert.equal(result.state.current, 320);
    assert.equal(player.actions.length, 1);
    assert.match(result.message, /账号或歌曲/);
  });

  it("provides labels without claiming unknown quality is standard", () => {
    for (const option of QUALITY_OPTIONS) assert.equal(qualityLabel(option.data), option.label);
    assert.match(qualityLabel(null), /暂无/);
    assert.match(qualityLabel(2999), /杜比/);
    assert.match(qualityLabel(9000), /未知/);
  });
});
