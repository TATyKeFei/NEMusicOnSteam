import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { CROSSFADE_QUEUE_SCRIPT, crossfadeAdoptScript, crossfadeClockScript } from "./crossfade-player.ts";

class Subject<Value> {
  private listeners: ((value: Value) => void)[] = [];
  next(value: Value) { for (const listener of this.listeners) listener(value); }
  subscribe(listener: (value: Value) => void) { this.listeners.push(listener); }
  asObservable() { return this; }
}

class BehaviorSubject<Value> extends Subject<Value> {
  private value: Value;
  constructor(value: Value) { super(); this.value = value; }
  getValue() { return this.value; }
  override next(value: Value) { this.value = value; super.next(value); }
}

type Progress = { current: number; cacheProgress: number; force: boolean; playId: string };

function progressModule() {
  const progress = new Subject<Progress>();
  return {
    b: new BehaviorSubject(false),
    c: new BehaviorSubject({ inSeek: false }),
    d: progress,
    e: () => progress.asObservable(),
  };
}

function page(mode = "playOrder") {
  const state = {
    playing: { playingVolume: 1, resourceTrackId: 1, resourceDuration: 100, playingMode: mode,
      playingState: 1, playId: "1_session", freeTrialInfo: { start: 0 } },
    playingList: { curPlayingList: [
      { resourceId: 1, track: { id: 1, name: "first", dt: 100000 } },
      { resourceId: 2, track: { id: 2, name: "second", dt: 120000, ar: [{ name: "artist" }], al: { name: "album", picUrl: "cover" } } },
    ] },
    "async:listenTogether": { status: "", roomInfo: { roomId: "" } },
  };
  const actions: { type: string; payload: Record<string, unknown> }[] = [];
  let clicks = 0;
  const store = { getState: () => state, dispatch: async (action: typeof actions[number]) => {
    actions.push(action);
    if (action.type === "playing/onUpdate") Object.assign(state.playing, action.payload);
  } };
  const progress = progressModule();
  const progressEvents: Progress[] = [];
  const display = { position: 0 };
  progress.e().subscribe(event => {
    progressEvents.push(event);
    if (event.playId.split("_")[0] === String(state.playing.resourceTrackId)) {
      display.position = event.current + state.playing.freeTrialInfo.start;
    }
  });
  let moduleLoads = 0;
  const loader = Object.assign((id: string) => {
    assert.equal(id, "native-progress");
    moduleLoads++;
    return progress;
  }, { m: { "native-progress": progressModule }, c: {} });
  const context = {
    __NEMusicOnSteamPlayerStore: store,
    __NEMusicOnSteamPlayerStoreSource: {},
    __NEMusicOnSteamWebpackRequire: loader,
    document: {
      querySelectorAll: () => [],
      querySelector: (selector: string) => selector.includes("title^") ? { click: () => { clicks++; } } : null,
    },
  };
  return { state, actions, context, store, loader, progress, progressEvents, display,
    moduleLoads: () => moduleLoads, clicks: () => clicks };
}

describe("crossfade page access", () => {
  it("extracts only the next song with duration in seconds", () => {
    const fixture = page();
    const result = runInNewContext(CROSSFADE_QUEUE_SCRIPT, fixture.context);
    assert.equal(result.from, "1");
    assert.equal(result.song.id, 2);
    assert.equal(result.song.duration, 120);
    assert.equal(result.song.artist, "artist");
  });

  it("gates shuffle, single repeat, FM, and listening rooms", () => {
    for (const mode of ["playRandom", "playOneCycle", "playFm", "playAi"]) {
      assert.equal(runInNewContext(CROSSFADE_QUEUE_SCRIPT, page(mode).context).eligible, false);
    }
    const fixture = page();
    fixture.state["async:listenTogether"].roomInfo.roomId = "room";
    assert.equal(runInNewContext(CROSSFADE_QUEUE_SCRIPT, fixture.context).song, null);
  });

  it("wraps a playlist and rejects stale adoption after queue edits", () => {
    const fixture = page("playCycle");
    fixture.state.playing.resourceTrackId = 2;
    assert.equal(runInNewContext(CROSSFADE_QUEUE_SCRIPT, fixture.context).song.id, 1);
    assert.equal(runInNewContext(crossfadeAdoptScript("2", "1"), fixture.context), true);
    assert.equal(fixture.clicks(), 1);
    fixture.state.playingList.curPlayingList.reverse();
    fixture.state.playing.playingMode = "playOrder";
    assert.equal(runInNewContext(crossfadeAdoptScript("2", "3"), fixture.context), false);
    assert.equal(fixture.clicks(), 1);
  });

  it("never writes a clock to the wrong song", async () => {
    const fixture = page();
    assert.equal(await runInNewContext(crossfadeClockScript("2", 3.6, true), fixture.context), false);
    assert.equal(fixture.actions.length, 0);
    assert.equal(fixture.progressEvents.length, 0);
    assert.equal(fixture.moduleLoads(), 0);
  });

  it("updates the playback icon and progress without seeking or resuming native audio", async () => {
    const fixture = page();
    fixture.progress.b.next(true);
    assert.equal(await runInNewContext(crossfadeClockScript("1", 3.6, true), fixture.context), true);
    assert.equal(fixture.state.playing.playingState, 2);
    assert.equal(fixture.display.position, 3.6);
    assert.equal(fixture.progress.b.getValue(), false);
    assert.equal(await runInNewContext(crossfadeClockScript("1", 4.1, true), fixture.context), true);
    assert.equal(fixture.display.position, 4.1);
    assert.deepEqual(fixture.actions.map(action => action.type), ["playing/onUpdate"]);
    assert.equal(fixture.moduleLoads(), 1);
    assert.equal(fixture.progressEvents[1].force, true);
    assert.equal(fixture.progressEvents[1].cacheProgress, 1);
    assert.equal(fixture.progressEvents[1].playId, "1_session");
  });

  it("shows pause at the same position and resumes the icon independently of clock movement", async () => {
    const fixture = page();
    for (const isPlaying of [true, false, false, true]) {
      assert.equal(await runInNewContext(crossfadeClockScript("1", 20, isPlaying), fixture.context), true);
      assert.equal(fixture.state.playing.playingState, isPlaying ? 2 : 1);
      assert.equal(fixture.display.position, 20);
    }
    assert.equal(fixture.actions.length, 3);
  });

  it("preserves a dragged progress position while still synchronizing the playback icon", async () => {
    const fixture = page();
    await runInNewContext(crossfadeClockScript("1", 20, true), fixture.context);
    fixture.progress.c.next({ inSeek: true });
    assert.equal(await runInNewContext(crossfadeClockScript("1", 21, false), fixture.context), false);
    assert.equal(fixture.state.playing.playingState, 1);
    assert.equal(fixture.display.position, 20);
    assert.equal(fixture.progressEvents.length, 1);
    fixture.progress.c.next({ inSeek: false });
    assert.equal(await runInNewContext(crossfadeClockScript("1", 40, false), fixture.context), true);
    assert.equal(fixture.display.position, 40);
  });

  it("clamps the displayed clock to the song duration and accounts for trial offsets", async () => {
    const fixture = page();
    fixture.state.playing.freeTrialInfo.start = 30;
    await runInNewContext(crossfadeClockScript("1", 130, true), fixture.context);
    assert.equal(fixture.display.position, 100);
    assert.equal(fixture.progressEvents[0].current, 70);
  });

  it("captures the webpack loader once and removes its temporary module", async () => {
    const fixture = page();
    Reflect.deleteProperty(fixture.context, "__NEMusicOnSteamWebpackRequire");
    let captures = 0;
    Object.assign(fixture.context, { webpackJsonp: { push: (payload: [string[], Record<string, (module: unknown, exports: unknown, loader: unknown) => void>, string[][]]) => {
      captures++;
      Object.assign(fixture.loader.m, payload[1]);
      for (const [id] of payload[2]) payload[1][id]({}, {}, fixture.loader);
    } } });
    await runInNewContext(crossfadeClockScript("1", 3.6, true), fixture.context);
    await runInNewContext(crossfadeClockScript("1", 4.1, true), fixture.context);
    assert.equal(captures, 1);
    assert.equal(fixture.moduleLoads(), 1);
    assert.deepEqual(Object.keys(fixture.loader.m), ["native-progress"]);
  });

  it("discards progress when the song changes during a playback state update", async () => {
    const fixture = page();
    const dispatch = fixture.store.dispatch;
    fixture.store.dispatch = async action => {
      await dispatch(action);
      fixture.state.playing.resourceTrackId = 2;
    };
    assert.equal(await runInNewContext(crossfadeClockScript("1", 3.6, true), fixture.context), false);
    assert.equal(fixture.progressEvents.length, 0);
    assert.equal(fixture.actions.length, 1);
  });
});
