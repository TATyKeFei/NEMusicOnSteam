import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { WEB_PRELOAD_CLEAR_SCRIPT, webPreloadScript } from "./web-preload-player.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const path = "/api/song/enhance/player/url/v1";
const nextRequest = { ids: "[2]", level: "exhigh", encodeType: "mp3" };

function page() {
  const state = {
    playing: { playingVolume: 1, resourceTrackId: 1, resourceDuration: 100, playingMode: "playOrder", playingState: 2 },
    playingList: { curPlayingList: [
      { resourceId: 1, track: { id: 1, name: "first", dt: 100000 } },
      { resourceId: 2, track: { id: 2, name: "second", dt: 120000 } },
    ] },
    host: { isAnonymous: false },
    setting: { quantity: { listenReg: 320, listenAnon: 128 } },
    "async:listenTogether": { status: "", roomInfo: { roomId: "" } },
  };
  const store = { getState: () => state, dispatch: () => { throw new Error("preload must not change playback"); } };
  const current = { currentTime: 80, duration: 100, readyState: 4, paused: false, ended: false };
  const media: Media[] = [];
  class Media {
    src = "";
    preload = "";
    muted = false;
    loads = 0;
    pauses = 0;
    onerror: (() => void) | null = null;
    constructor() { media.push(this); }
    load() { this.loads++; }
    pause() { this.pauses++; }
    play() { throw new Error("preloaded audio must never play"); }
    removeAttribute(name: string) { if (name === "src") this.src = ""; }
  }
  const calls: { url: string; data: typeof nextRequest; signal?: AbortSignal }[] = [];
  let gate: Promise<void> | null = null;
  let trial = false;
  let now = 1000;
  const network = { default: async (url: string, options: { data: typeof nextRequest; signal?: AbortSignal }) => {
    calls.push({ url, data: options.data, signal: options.signal });
    await gate;
    const id = JSON.parse(options.data.ids)[0];
    return new Response(JSON.stringify({ code: 200, data: [{ id, url: `https://audio.example/${id}.mp3`,
      md5: "md5", expi: 300, level: options.data.level, freeTrialInfo: trial ? { start: 0, end: 30 } : null }] }));
  } };
  const original = network.default;
  const loader = Object.assign(() => network, { m: { network: function () { return { rawFetch: true, FetchWithRPC: true }; } }, c: {} });
  const context = createContext({
    __NEMusicOnSteamPlayerStore: store, __NEMusicOnSteamPlayerStoreSource: {},
    __NEMusicOnSteamWebpackRequire: loader,
    document: { querySelectorAll: (selector: string) => selector === "audio, video" ? [current] : [], querySelector: () => null },
    navigator: { mediaSession: { metadata: { title: "first" }, playbackState: "playing" } },
    location: { href: "https://music.163.com/st/webplayer" },
    Audio: Media, Response, URL, URLSearchParams, AbortController, Date: { now: () => now },
  });
  return {
    state, current, media, calls, network, original, context,
    tick: () => runInContext(webPreloadScript(true), context),
    stop: () => runInContext(WEB_PRELOAD_CLEAR_SCRIPT, context),
    request: async (data = nextRequest) => (await network.default(path, { data })).json(),
    hold: (value: Promise<void>) => { gate = value; },
    trial: () => { trial = true; },
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

describe("web next-track preloading", () => {
  it("silently buffers the next song and reuses its complete URL response during native playback", async () => {
    const fixture = page();
    assert.equal(fixture.tick(), true);
    await flush();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.media.length, 1);
    assert.equal(fixture.media[0].src, "https://audio.example/2.mp3");
    assert.equal(fixture.media[0].muted, true);
    assert.equal(fixture.media[0].preload, "auto");
    const result = await fixture.request();
    assert.equal(result.data[0].id, 2);
    assert.equal(result.data[0].md5, "md5");
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.current.currentTime, 80);
    const hooked = fixture.network.default;
    fixture.tick();
    await flush();
    assert.equal(fixture.network.default, hooked);
    assert.equal(fixture.media.length, 1);
  });

  it("does not reuse another song, quality, or an expired URL", async () => {
    const fixture = page();
    fixture.tick();
    await flush();
    await fixture.request({ ...nextRequest, ids: "[3]" });
    await fixture.request({ ...nextRequest, level: "lossless" });
    assert.equal(fixture.calls.length, 3);
    fixture.advance(301000);
    await fixture.request();
    assert.equal(fixture.calls.length, 4);
  });

  it("cancels buffering on queue changes, seeking away, or disabling", async () => {
    const fixture = page();
    fixture.tick();
    await flush();
    fixture.state.playingList.curPlayingList[1].resourceId = 3;
    fixture.state.playingList.curPlayingList[1].track.id = 3;
    fixture.tick();
    await flush();
    assert.equal(fixture.media[0].src, "");
    assert.equal(fixture.media[1].src, "https://audio.example/3.mp3");
    fixture.current.currentTime = 10;
    fixture.tick();
    assert.equal(fixture.media[1].src, "");
    fixture.current.currentTime = 80;
    fixture.tick();
    await flush();
    fixture.stop();
    assert.equal(fixture.media[2].src, "");
    assert.equal(fixture.network.default, fixture.original);
    assert.equal(fixture.context.__NEMusicOnSteamWebPreload, undefined);
  });

  it("uses the page's current quality and discards the old quality buffer", async () => {
    const fixture = page();
    fixture.tick();
    await flush();
    fixture.state.setting.quantity.listenReg = 999;
    fixture.tick();
    await flush();
    assert.equal(fixture.media[0].src, "");
    assert.equal(fixture.calls[1].data.level, "lossless");
    assert.equal(fixture.calls[1].data.encodeType, "flac");
  });

  it("discards URL resolution that finishes after disabling", async () => {
    const fixture = page();
    let release!: () => void;
    fixture.hold(new Promise<void>(resolve => { release = resolve; }));
    fixture.tick();
    await flush();
    fixture.stop();
    assert.equal(fixture.calls[0].signal?.aborted, true);
    release();
    await flush();
    assert.equal(fixture.media.length, 0);
    assert.equal(fixture.context.__NEMusicOnSteamWebPreload, undefined);
  });

  it("leaves trial audio and unsupported playback modes to normal playback", async () => {
    for (const mode of ["playRandom", "playOneCycle", "playFm"]) {
      const fixture = page();
      fixture.state.playing.playingMode = mode;
      fixture.tick();
      await flush();
      assert.equal(fixture.calls.length, 0);
    }
    const room = page();
    room.state["async:listenTogether"].roomInfo.roomId = "room";
    room.tick();
    await flush();
    assert.equal(room.calls.length, 0);
    const fixture = page();
    fixture.trial();
    fixture.tick();
    await flush();
    assert.equal(fixture.media.length, 0);
    await fixture.request();
    assert.equal(fixture.calls.length, 2);
  });
});
