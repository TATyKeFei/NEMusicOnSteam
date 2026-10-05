import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import type { TrackState } from "./mpris.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./mpv.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type PageScripts = {
  mute: string;
  sync: (playing: boolean, allowPause: boolean) => string;
  unmute: (resume: boolean) => string;
};

type Payload = Record<string, unknown>;

const isMute = (expression: string) => expression.includes("bridge.playHook");
const isSync = (expression: string) => expression.includes("bridge.paused.delete(howl)");
const isUnmute = (expression: string) => expression.includes("entry[0].volume");
const isSnapshot = (expression: string) => expression === "snapshot";

const downloadTrack = { url: "https://audio.example/a.mp3", name: "歌名", artist: "歌手", album: "专辑", cover: "" };

const webPlaying: TrackState = {
  active: true,
  playbackStatus: "Playing",
  title: "歌名",
  artist: "歌手",
  lyrics: "",
  album: "专辑",
  artUrl: "",
  trackId: "t1",
  duration: 100,
  position: 10,
  canSeek: true,
  canGoNext: true,
  canGoPrevious: true,
  volume: 1,
  loopStatus: "None",
  shuffle: false,
  rate: 1,
};

function setup(options: { web?: TrackState | null; mpv?: Payload } = {}) {
  const evaluations: string[] = [];
  const loads: Payload[] = [];
  const webCommands: string[] = [];
  const posts: string[] = [];
  const volumeCommands: number[] = [];
  const positionCommands: number[] = [];
  const order: string[] = [];
  let interval: () => void = () => {};
  let web: TrackState | null = options.web === undefined ? { ...webPlaying } : options.web;
  let mpv: Payload = { active: false, playbackStatus: "Stopped", ...(options.mpv ?? {}) };

  const evaluate = async (expression: string) => {
    evaluations.push(expression);
    if (isSnapshot(expression)) return web;
    if (expression === "download") return downloadTrack;
    if (expression.includes("splice")) return { actions: [] };
    return true;
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/state")) return { ok: true, json: async () => mpv };
    if (url.endsWith("/load")) {
      loads.push(JSON.parse(init!.body!));
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith("/command")) {
      const body = JSON.parse(init!.body!);
      posts.push(body.action);
      order.push(`mpv:${body.action}`);
      if (body.action === "volume") volumeCommands.push(body.value);
      if (body.action === "setposition" || body.action === "seek") positionCommands.push(body.value);
      return { ok: true, json: async () => ({ handled: true }) };
    }
    if (url.endsWith("/shutdown")) {
      posts.push("shutdown");
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  const api = runInNewContext(
    `${source}; ({ Bridge: MpvBridge, scripts: { mute: MPV_MUTE_SCRIPT, sync: mpvSyncScript, unmute: mpvUnmuteScript } })`,
    {
      navigator: { platform: "Linux" },
      window: {
        setInterval(callback: () => void) {
          interval = callback;
          return 1;
        },
        clearInterval() {},
      },
      console: { warn() {} },
      ffi: () => async () => "http://localhost|test-token",
      SNAPSHOT_SCRIPT: "snapshot",
      downloadScript: () => "download",
      tryEvaluateInPlayer: evaluate,
      fetch,
    },
  ) as { Bridge: new (options: unknown) => TestBridge; scripts: PageScripts };

  const bridge = new api.Bridge({
    quality: () => 1,
    commandWeb: async (command: { action: string }) => {
      webCommands.push(command.action);
      order.push(`web:${command.action}`);
      return true;
    },
  });

  return {
    bridge,
    scripts: api.scripts,
    evaluations,
    loads,
    webCommands,
    posts,
    volumeCommands,
    positionCommands,
    order,
    tick: () => interval(),
    setWeb: (next: TrackState | null) => { web = next; },
    setMpv: (next: Payload) => { mpv = next; },
    lastSync: () => evaluations.filter(isSync).at(-1) ?? "",
    lastUnmute: () => evaluations.filter(isUnmute).at(-1) ?? "",
  };
}

type TestBridge = {
  setEnabled(enabled: boolean): void;
  command(command: { action: string; value?: number }): Promise<boolean>;
  snapshot(): TrackState;
};

/** 网页里 Howler 的 html5 audio 是游离节点，DOM 里根本扫不到，所以桩要同时备着两条路。 */
function pageScripts(): PageScripts {
  const stub = {
    navigator: { platform: "Linux" },
    window: { setInterval: () => 1, clearInterval: () => {} },
    console: { warn: () => {} },
    ffi: () => async () => "http://localhost|token",
    SNAPSHOT_SCRIPT: "snapshot",
    downloadScript: () => "download",
    tryEvaluateInPlayer: async () => true,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  return runInNewContext(`${source}; ({ mute: MPV_MUTE_SCRIPT, sync: mpvSyncScript, unmute: mpvUnmuteScript })`, stub) as PageScripts;
}

const scripts = pageScripts();

function page() {
  class FakeMedia {
    volume = 1;
    muted = false;
    paused = true;
    private listeners: Record<string, (() => void)[]> = {};
    play() {
      this.paused = false;
      return Promise.resolve("played");
    }
    pause() {
      this.paused = true;
    }
    addEventListener(type: string, listener: () => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    fire(type: string) {
      for (const listener of this.listeners[type] ?? []) listener();
    }
  }
  const attached: FakeMedia[] = [];
  const context = createContext({
    console,
    HTMLMediaElement: FakeMedia,
    document: {
      querySelectorAll: (selector: string) => (selector === "audio, video" ? attached.slice() : []),
    },
  });
  return {
    context,
    attached,
    FakeMedia,
    run: (expression: string) => runInContext(expression, context),
    withHowler(howls: unknown[]) {
      Object.assign(context, { Howler: { _howls: howls, _html5AudioPool: [] } });
    },
  };
}

function fakeHowl(node: { paused: boolean }, ended = false) {
  const sounds = [{ _node: node, _ended: ended, _paused: false }];
  return {
    _state: "loaded",
    _sounds: sounds,
    plays: 0,
    pauses: 0,
    playing() {
      return sounds.some((sound) => !sound._paused);
    },
    play() {
      this.plays++;
      for (const sound of sounds) sound._paused = false;
    },
    pause() {
      this.pauses++;
      for (const sound of sounds) sound._paused = true;
      node.paused = true;
    },
  };
}

describe("MPV backend page scripts", () => {
  it("silences howler's detached audio without ever pausing it", () => {
    const web = page();
    const node = new web.FakeMedia();
    node.volume = 0.8;
    node.paused = false;
    web.withHowler([{ _sounds: [{ _node: node }] }]);
    web.run(scripts.mute);
    assert.equal(node.muted, true);
    assert.equal(node.volume, 0);
    // 页面必须继续"在播"：一旦 pause，它的 ended 就不会来，歌也不会自己往下走。
    assert.equal(node.paused, false);
    // Howler 再动音量也按回去，而第一次见到的音量留给恢复用。
    node.volume = 0.4;
    node.fire("volumechange");
    assert.equal(node.volume, 0);
    web.run(scripts.unmute(true));
    assert.equal(node.volume, 0.8);
    assert.equal(node.muted, false);
  });

  it("mutes detached and DOM nodes alike and blocks later plays", () => {
    const web = page();
    const detached = new web.FakeMedia();
    const attached = new web.FakeMedia();
    attached.volume = 0.5;
    web.attached.push(attached);
    web.withHowler([{ _sounds: [{ _node: detached }] }]);
    web.run(scripts.mute);
    assert.equal(detached.muted, true);
    assert.equal(attached.muted, true);
    // 静音之后 Howler 才拿出来的节点只能在 play() 里挡住，那是唯一不漏声音的位置。
    const fresh = new web.FakeMedia();
    fresh.play();
    assert.equal(fresh.muted, true);
    assert.equal(fresh.volume, 0);
    assert.equal(fresh.paused, false);
  });

  it("mirrors mpv's play state into the page through howler's API", () => {
    const web = page();
    const node = new web.FakeMedia();
    node.paused = false;
    const playing = fakeHowl(node);
    const ended = fakeHowl(node, true);
    web.withHowler([playing, ended]);
    web.run(scripts.mute);

    // mpv 暂停：页面也得停，否则它会静音播完整首再自动切歌，把暂停中的 mpv 拉起来。
    web.run(scripts.sync(false, true));
    assert.equal(playing.pauses, 1);
    // 切歌过渡期不许按停，页面停了新歌就进不来。
    web.run(scripts.sync(false, false));
    assert.equal(playing.pauses, 1);
    // mpv 在播：把页面接回去，但已经播完的 howl 不能被 play() 从头重放。
    web.run(scripts.sync(true, true));
    assert.equal(playing.plays, 1);
    assert.equal(ended.plays, 0);
    // 关后端而 mpv 正在播：被我们按停的声音要经 Howler API 接回来，音量也一并还回去。
    web.run(scripts.sync(false, true));
    assert.equal(playing.pauses, 2);
    web.run(scripts.unmute(true));
    assert.equal(playing.plays, 2);
    assert.equal(node.volume, 1);
    assert.equal(node.muted, false);
  });

  it("leaves the page stopped when mpv was paused at handoff", () => {
    const web = page();
    const node = new web.FakeMedia();
    node.paused = false;
    const howl = fakeHowl(node);
    web.withHowler([howl]);
    web.run(scripts.mute);
    web.run(scripts.sync(false, true));
    assert.equal(howl.pauses, 1);
    web.run(scripts.unmute(false));
    assert.equal(howl.plays, 0);
  });
});

describe("MPV bridge tick", () => {
  it("silences the page before reading it and hands the track to mpv", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.loads.length, 1);
    assert.equal(player.loads[0].trackId, "t1");
    assert.equal(player.loads[0].autoplay, true);
    const mute = player.evaluations.findIndex(isMute);
    const snapshot = player.evaluations.findIndex(isSnapshot);
    assert.ok(mute >= 0 && mute < snapshot, `mute@${mute} snapshot@${snapshot}`);
    assert.match(player.lastSync(), /if \(true\)/);
  });

  it("waits for the page to start playing before autoplaying", async () => {
    const player = setup({ web: { ...webPlaying, playbackStatus: "Paused" } });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.loads.length, 1);
    assert.equal(player.loads[0].autoplay, false);
  });

  it("hands the page's volume to mpv on load and reconciles the rest", async () => {
    // 网页滑块是 div[role=slider]，拖动不派发事件，音量只能靠快照跟 mpv 对账。
    const player = setup({
      web: { ...webPlaying, volume: 0.4 },
      mpv: { active: true, playbackStatus: "Playing", trackId: "t1", volume: 1 },
    });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.loads[0].volume, 0.4);
    assert.deepEqual(player.volumeCommands, [0.4]);
  });

  it("leaves mpv alone when the volume already matches", async () => {
    const player = setup({
      web: { ...webPlaying, volume: 0.4 },
      mpv: { active: true, playbackStatus: "Playing", trackId: "t1", volume: 0.4 },
    });
    player.bridge.setEnabled(true);
    await flush();
    assert.deepEqual(player.volumeCommands, []);
    assert.equal(player.loads[0].volume, 0.4);
  });

  it("writes media-key volume back to the page so the next tick keeps it", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    await player.bridge.command({ action: "volume", value: 0.6 });
    assert.ok(player.webCommands.includes("volume"));
    assert.deepEqual(player.volumeCommands, [0.6]);
    player.setWeb({ ...webPlaying, volume: 0.6 });
    player.setMpv({ active: true, playbackStatus: "Playing", trackId: "t1", volume: 0.6 });
    player.tick();
    await flush();
    assert.deepEqual(player.volumeCommands, [0.6]);
  });

  it("drags mpv along when the page's progress bar is dragged", async () => {
    const player = setup({
      web: { ...webPlaying, position: 40 },
      mpv: { active: true, playbackStatus: "Playing", trackId: "t1", position: 5 },
    });
    player.bridge.setEnabled(true);
    await flush();
    assert.deepEqual(player.positionCommands, [40_000_000]);
    assert.equal(player.loads[0].position, 40);
  });

  it("leaves mpv alone over a normal drift, a paused mpv, or another song", async () => {
    const player = setup({
      web: { ...webPlaying, position: 40 },
      mpv: { active: true, playbackStatus: "Playing", trackId: "t1", position: 39.4 },
    });
    player.bridge.setEnabled(true);
    await flush();
    assert.deepEqual(player.positionCommands, []);
    // 暂停中谁也不许拽谁：mpv 是音频出口，它停着就得停在原地。
    player.setMpv({ active: true, playbackStatus: "Paused", trackId: "t1", position: 5 });
    player.setWeb({ ...webPlaying, position: 40 });
    player.tick();
    await flush();
    assert.deepEqual(player.positionCommands, []);
    // 网页已经切到下一首而 mpv 还在上一首，进度对账不掺和切歌的事。
    player.setMpv({ active: true, playbackStatus: "Playing", trackId: "t1", position: 5 });
    player.setWeb({ ...webPlaying, trackId: "t2", position: 40 });
    player.tick();
    await flush();
    assert.deepEqual(player.positionCommands, []);
  });

  it("writes progress to the page before touching mpv so the reconcile cannot roll it back", async () => {
    const player = setup({
      web: { ...webPlaying, position: 5 },
      mpv: { active: true, playbackStatus: "Playing", trackId: "t1", position: 5 },
    });
    player.bridge.setEnabled(true);
    await flush();
    await player.bridge.command({ action: "setposition", value: 40_000_000 });
    assert.deepEqual(player.order, ["web:setposition", "mpv:setposition"]);
    player.positionCommands.length = 0;
    player.setWeb({ ...webPlaying, position: 40 });
    player.setMpv({ active: true, playbackStatus: "Playing", trackId: "t1", position: 40 });
    player.tick();
    await flush();
    assert.deepEqual(player.positionCommands, []);
  });

  it("asks the page for the next song when mpv runs out", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    player.setMpv({ active: true, playbackStatus: "Stopped", trackId: "t1", position: 100 });
    player.tick();
    await flush();
    assert.deepEqual(player.webCommands, ["next"]);
    // 过渡期 mpv 还没把新歌播起来，但页面绝不能被按停，否则下一 tick 的快照是 Paused，歌就断了。
    assert.match(player.lastSync(), /else if \(false\)/);
    assert.doesNotMatch(player.lastSync(), /else if \(true\)/);
    player.setWeb({ ...webPlaying, trackId: "t2" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 2);
    assert.equal(player.loads[1].autoplay, true);
  });

  it("keeps mpv stopped after an explicit stop", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    await player.bridge.command({ action: "stop" });
    // stop 之后辅助进程里 path 没了，但曲目信息还在，快照仍然带着 t1。
    player.setMpv({ active: false, playbackStatus: "Stopped", trackId: "t1" });
    player.setWeb({ ...webPlaying, playbackStatus: "Paused" });
    player.tick();
    await flush();
    assert.deepEqual(player.webCommands, []);
    assert.equal(player.loads.length, 1);
    assert.match(player.lastSync(), /if \(false\)/);
    assert.match(player.lastSync(), /else if \(true\)/);
  });

  it("reattaches mpv to the same track after the helper restarts", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    // 辅助进程重启后曲目信息是空的，网页却还在同一首上播着。
    player.setMpv({ active: false, playbackStatus: "Stopped", trackId: "" });
    player.tick();
    await flush();
    assert.deepEqual(player.webCommands, []);
    assert.equal(player.loads.length, 2);
    assert.equal(player.loads[1].trackId, "t1");
    assert.equal(player.loads[1].autoplay, true);
  });

  it("follows mpv's pause instead of restarting it", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    player.setMpv({ active: true, playbackStatus: "Paused", trackId: "t1" });
    player.setWeb({ ...webPlaying, playbackStatus: "Paused" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 1);
    // mpv 暂停时页面必须一起停，否则它会自己切歌。
    assert.match(player.lastSync(), /if \(false\)/);
    assert.match(player.lastSync(), /else if \(true\)/);
    // 页面切了歌也不能把暂停中的 mpv 带起来。
    player.setWeb({ ...webPlaying, trackId: "t2", playbackStatus: "Playing" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 2);
    assert.equal(player.loads[1].autoplay, false);
  });

  it("pulls the track back in when play arrives after a stop", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    await player.bridge.command({ action: "stop" });
    player.setMpv({ active: false, playbackStatus: "Stopped", trackId: "t1" });
    player.setWeb({ ...webPlaying, playbackStatus: "Paused" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 1);
    await player.bridge.command({ action: "play" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 2);
    assert.equal(player.loads[1].autoplay, true);
  });

  it("hands audio back to the page when the backend turns off", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    player.bridge.setEnabled(false);
    await flush();
    assert.match(player.lastUnmute(), /if \(true\)/);
    assert.ok(player.posts.includes("shutdown"));
  });

  it("does not resurrect a page the user explicitly stopped", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    await player.bridge.command({ action: "stop" });
    player.bridge.setEnabled(false);
    await flush();
    assert.match(player.lastUnmute(), /if \(false\)/);
  });
});
