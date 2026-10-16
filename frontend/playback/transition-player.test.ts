import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { TRANSITION_CANDIDATE_SCRIPT, transitionClockScript, transitionCommitScript } from "./transition-player.ts";

function fixture() {
  const state = {
    playing: { resourceTrackId: "1", playingMode: "playOrder", playingVolume: 0.5, resourceDuration: 100,
      resourceType: "track", curPlaying: { resourceId: "1" }, freeTrialInfo: null as unknown },
    playingList: { curPlayingList: [1, 2, 3].map(id => ({ resourceType: "track", resourceId: String(id), track: { id, name: `Song ${id}`, ar: [{ name: "Artist" }] } })) },
    "async:listenTogether": { status: "alone", roomInfo: {} as { roomId?: string } },
  };
  const store = { getState: () => state, dispatch: () => {} };
  let clicks = 0;
  const button = { getAttribute: () => null, className: "", click: () => {
    clicks++;
    state.playing.resourceTrackId = "2";
    state.playing.curPlaying.resourceId = "2";
  } };
  const context = { document: { querySelectorAll: () => [], querySelector: (selector: string) => selector === '#page_pc_mini_bar' ? null : button },
    __NEMusicOnSteamPlayerStore: store, __NEMusicOnSteamPlayerStoreSource: {},
    __NEMusicOnSteamMpvControls: { allowAction: "" }, setTimeout,
  };
  return { state, context, store, clicks: () => clicks,
    candidate: () => JSON.parse(JSON.stringify(runInNewContext(TRANSITION_CANDIDATE_SCRIPT, context))),
  };
}

describe("mpv transition page access", () => {
  it("reads the next track from the real queue and wraps only in playlist loop", () => {
    const page = fixture();
    assert.deepEqual(page.candidate(), { from: "1", song: { id: 2, name: "Song 2", artist: "Artist", album: "", cover: "" } });
    page.state.playing.resourceTrackId = "3";
    assert.equal(page.candidate(), null);
    page.state.playing.playingMode = "playCycle";
    assert.equal(page.candidate().song.id, 1);
  });

  it("does not predict next tracks in rooms, trials, shuffle, FM or single repeat", () => {
    const page = fixture();
    for (const mode of ["playOneCycle", "playRandom", "playFm", "playAi"]) {
      page.state.playing.playingMode = mode;
      assert.equal(page.candidate().blocked, true);
    }
    page.state.playing.playingMode = "playOrder";
    page.state["async:listenTogether"].status = "togetherOwner";
    assert.equal(page.candidate().blocked, true);
    page.state["async:listenTogether"].status = "alone";
    page.state.playing.freeTrialInfo = { start: 10, end: 30 };
    assert.equal(page.candidate().blocked, true);
  });

  it("revalidates queue before committing and uses the official next control", async () => {
    const page = fixture();
    const candidate = page.candidate();
    page.state.playingList.curPlayingList.splice(1, 1);
    assert.equal(await runInNewContext(transitionCommitScript(candidate), page.context), false);
    assert.equal(page.clicks(), 0);
    const fresh = fixture();
    assert.equal(await runInNewContext(transitionCommitScript(fresh.candidate()), fresh.context), true);
    assert.equal(fresh.clicks(), 1);
    assert.equal(fresh.context.__NEMusicOnSteamMpvControls.allowAction, "");
  });

  it("distinguishes webpage clock alignment from an actual progress drag", async () => {
    const page = fixture();
    await runInNewContext(transitionClockScript("1", 2, true), page.context);
    assert.equal((await runInNewContext(transitionClockScript("1", 3, false), page.context)).seek, null);
    page.store.dispatch({ type: "playing/setPlayingPosition", payload: { duration: 30 } });
    assert.equal((await runInNewContext(transitionClockScript("1", 3, true), page.context)).seek, 30);
    assert.equal((await runInNewContext(transitionClockScript("1", 3, false), page.context)).seek, null);
  });
});
