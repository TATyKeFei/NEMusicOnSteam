import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { commandScript, LYRICS_SCRIPT, type Command } from "./mpris-player.ts";

function playerFixture() {
  const state = {
    playing: {
      playingVolume: 0.42,
      resourceDuration: 240,
      resourceTrackId: "track-1",
      playingMode: "playOrder",
      freeTrialInfo: null as { start: number; end: number } | null,
    },
  };
  const media = { volume: 1, currentTime: 30, duration: 240, paused: false, readyState: 4 };
  const commands: { type: string; payload: { volume?: number; duration?: number; playingMode?: string } }[] = [];
  let confirmVolume: (() => void) | null = null;
  const store = {
    getState: () => state,
    dispatch: async (action: typeof commands[number]) => {
      commands.push(action);
      if (action.type === "playing/setVolume") {
        confirmVolume = () => { state.playing.playingVolume = action.payload.volume!; };
      } else if (action.type === "playing/setPlayingPosition") {
        media.currentTime = action.payload.duration!;
      } else if (action.type === "playing/switchPlayingMode") {
        state.playing.playingMode = action.payload.playingMode!;
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
  const transport: { element: Record<string, unknown>; clicks: number }[] = [];
  const addControl = (title: string, disabled = false) => {
    const entry = {
      clicks: 0,
      element: {
        title,
        className: "",
        parentElement: null,
        getAttribute: (name: string) => (name === "aria-disabled" ? String(disabled) : null),
        click: () => { entry.clicks += 1; },
      } as Record<string, unknown>,
    };
    transport.push(entry);
    return entry;
  };
  const matchControl = (selector: string) => {
    const prefix = /^\[title\^="(.+)"\]$/.exec(selector)?.[1];
    if (!prefix) return null;
    return transport.find(entry => String(entry.element.title).startsWith(prefix))?.element ?? null;
  };
  const context = {
    document: {
      querySelector: (selector: string) => (selector === "#page_pc_mini_bar" ? { querySelector: matchControl } : matchControl(selector)),
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
    state, media, store, provider, commands, addControl,
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

  it("reads next and previous from the transport controls the player itself renders", () => {
    const player = playerFixture();
    player.addControl("下一首（Ctrl+→）");
    player.addControl("上一首（Ctrl+←）");
    const snapshot = player.snapshot();
    assert.equal(snapshot.canGoNext, true);
    assert.equal(snapshot.canGoPrevious, true);
  });

  it("withholds previous while the player marks it disabled", () => {
    const player = playerFixture();
    player.addControl("下一首");
    player.addControl("上一首", true);
    assert.equal(player.snapshot().canGoNext, true);
    assert.equal(player.snapshot().canGoPrevious, false);
  });

  it("claims no capability when the player exposes no titled controls", () => {
    const player = playerFixture();
    const snapshot = player.snapshot();
    assert.equal(snapshot.canGoNext, false);
    assert.equal(snapshot.canGoPrevious, false);
  });

  it("clicks the labelled control for next and refuses a disabled previous", async () => {
    const player = playerFixture();
    const next = player.addControl("下一首（Ctrl+→）");
    const previous = player.addControl("上一首（Ctrl+←）", true);
    assert.equal(await player.command({ action: "next" }), true);
    assert.equal(await player.command({ action: "previous" }), false);
    assert.equal(next.clicks, 1);
    assert.equal(previous.clicks, 0);
  });

  it("reports loop and shuffle from the playing mode the store holds", () => {
    const player = playerFixture();
    assert.equal(player.snapshot().loopStatus, "None");
    assert.equal(player.snapshot().shuffle, false);
    player.state.playing.playingMode = "playRandom";
    assert.equal(player.snapshot().shuffle, true);
    player.state.playing.playingMode = "playOneCycle";
    assert.equal(player.snapshot().loopStatus, "Track");
    assert.equal(player.snapshot().shuffle, false);
    player.state.playing.playingMode = "playCycle";
    assert.equal(player.snapshot().loopStatus, "Playlist");
  });

  it("switches the playing mode through the store instead of toggling a button", async () => {
    const player = playerFixture();
    assert.equal(await player.command({ action: "shuffle", value: true }), true);
    assert.deepEqual(JSON.parse(JSON.stringify(player.commands.at(-1))), {
      type: "playing/switchPlayingMode",
      payload: { playingMode: "playRandom", triggerScene: "miniBar", HeartBeatFlage: false },
    });
    assert.equal(player.snapshot().shuffle, true);
    assert.equal(await player.command({ action: "loop", value: "Track" }), true);
    assert.equal(player.snapshot().loopStatus, "Track");
    assert.equal(await player.command({ action: "loop", value: "None" }), true);
    assert.equal(player.snapshot().loopStatus, "None");
  });

  it("leaves a loop mode alone when a client only clears shuffle", async () => {
    const player = playerFixture();
    player.state.playing.playingMode = "playOneCycle";
    assert.equal(await player.command({ action: "shuffle", value: false }), true);
    assert.equal(player.snapshot().loopStatus, "Track");
    assert.equal(player.snapshot().shuffle, false);
  });

  it("waits for the application's command and rejects invalid values", async () => {    const player = playerFixture();
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

type LyricsResult = { lyric: string; resolved: boolean };

function lyricsFixture(config: {
  trackId?: string;
  ok?: boolean;
  networkError?: boolean;
  payload?: unknown;
  domLines?: string[];
} = {}) {
  const state = {
    playing: {
      playingVolume: 0.42,
      resourceDuration: 240,
      resourceTrackId: config.trackId ?? "1900172235",
      freeTrialInfo: null,
    },
  };
  const store = { getState: () => state, dispatch: async () => undefined };
  const seed = {
    __reactFiber$test: { return: { memoizedProps: { value: { store } }, return: null } },
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
  };
  const lineNodes = (config.domLines ?? []).map(text => ({
    textContent: text,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 120, height: 20 }),
  }));
  const lyricRoot = {
    textContent: lineNodes.map(node => node.textContent).join("\n"),
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 320, height: 200 }),
    querySelectorAll: (selector: string) => (selector === "li, p, [data-time]" ? lineNodes : []),
  };
  const fetches: string[] = [];
  const context = {
    document: {
      querySelectorAll: (selector: string) => {
        if (selector.includes("#root > *") || selector.includes("#btn_pc_minibar_play")) return [seed];
        if (selector.startsWith(".m-lycifo__content")) return lineNodes.length ? [lyricRoot] : [];
        return [];
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    fetch: (url: string) => {
      fetches.push(String(url));
      if (config.networkError) return Promise.reject(new Error("offline"));
      return Promise.resolve({ ok: config.ok ?? true, json: () => Promise.resolve(config.payload ?? { lrc: { lyric: "" }, tlyric: { lyric: "" } }) });
    },
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  return {
    fetches,
    run: async (): Promise<LyricsResult> => {
      const raw = await (runInNewContext(LYRICS_SCRIPT, context) as Promise<LyricsResult>);
      return JSON.parse(JSON.stringify(raw)) as LyricsResult;
    },
  };
}

describe("NetEase MPRIS lyrics", () => {
  it("merges the translation into the line it shares a timestamp with", async () => {
    const player = lyricsFixture({
      payload: { lrc: { lyric: "[00:00.67]original one\n[00:05.82]original two" }, tlyric: { lyric: "[00:00.67]译文一\n[00:05.82]译文二" } },
    });
    assert.deepEqual(await player.run(), { lyric: "original one\n译文一\noriginal two\n译文二", resolved: true });
    assert.equal(player.fetches.length, 1);
    assert.match(player.fetches[0], /id=1900172235/);
    assert.ok(!player.fetches[0].includes("kv="));
  });

  it("drops a translation whose timestamp matches no original line", async () => {
    const player = lyricsFixture({
      payload: { lrc: { lyric: "[00:00.67]original one" }, tlyric: { lyric: "[00:09.99]译文" } },
    });
    assert.deepEqual(await player.run(), { lyric: "original one", resolved: true });
  });

  it("reports a song the API knows has no lyrics as settled so it is not retried", async () => {
    const player = lyricsFixture({ payload: { uncollected: true, lrc: { lyric: "" } } });
    assert.deepEqual(await player.run(), { lyric: "", resolved: true });
  });

  it("falls back to the page when the API is unreachable", async () => {
    const player = lyricsFixture({ networkError: true, domLines: ["页面第一句", "页面第二句"] });
    assert.deepEqual(await player.run(), { lyric: "页面第一句\n页面第二句", resolved: true });
  });

  it("keeps the song retryable when neither the API nor the page produced lyrics", async () => {
    const player = lyricsFixture({ networkError: true });
    assert.deepEqual(await player.run(), { lyric: "", resolved: false });
  });

  it("reads only the page for a track id without a song number", async () => {
    const player = lyricsFixture({ trackId: "episode-abc", domLines: ["播客内容", "第二句"] });
    assert.deepEqual(await player.run(), { lyric: "播客内容\n第二句", resolved: true });
    assert.equal(player.fetches.length, 0);
  });

  it("caps the synchronized lyrics at 32768 bytes", async () => {
    const lines = Array.from({ length: 400 }, (_unused, index) => {
      const stamp = `[${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.00]`;
      return `${stamp}${"词".repeat(38)}${String(index).padStart(2, "0")}`;
    });
    const full = lines.join("\n");
    assert.ok(new TextEncoder().encode(full).length > 32768);
    const player = lyricsFixture({ payload: { lrc: { lyric: full } } });
    const result = await player.run();
    assert.equal(result.resolved, true);
    assert.ok(new TextEncoder().encode(result.lyric).length <= 32768);
    assert.ok(result.lyric.length > 0);
  });

  it("does not repeat a line that follows itself", async () => {
    const player = lyricsFixture({ payload: { lrc: { lyric: "[00:01.00]same\n[00:02.00]same\n[00:03.00]different" } } });
    assert.deepEqual(await player.run(), { lyric: "same\ndifferent", resolved: true });
  });
});
