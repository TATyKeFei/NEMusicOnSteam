import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import type { TrackState } from "../mpris/mpris.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./external-audio.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type PageScripts = {
  mute: string;
  sync: (playing: boolean, allowPause: boolean) => string;
  unmute: (resume: boolean) => string;
  controls: string;
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

function setup(options: { web?: TrackState | null; mpv?: Payload; resolver?: boolean; alternate?: boolean; mpd?: boolean; configurationError?: string; transition?: boolean; transitionMode?: "normal" | "smart" } = {}) {
  const evaluations: string[] = [];
  const loads: Payload[] = [];
  const prepares: Payload[] = [];
  let transitionEnabled = options.transition === true;
  let transitionMode: "normal" | "smart" = options.transitionMode ?? "normal";
  let clockSeek: number | null = null;
  let clockAlignments = 0;
  let transitionAccepted = true;
  let candidate: unknown = { from: "t1", song: { id: 2, name: "Next", artist: "Artist" } };
  const webCommands: string[] = [];
  const posts: string[] = [];
  const volumeCommands: number[] = [];
  const positionCommands: number[] = [];
  const order: string[] = [];
  const requests: { url: string; signal?: AbortSignal; keepalive?: boolean }[] = [];
  let interval: () => void = () => {};
  let endpointGate: Promise<void> | null = null;
  let evaluationGate: { expression: string; promise: Promise<void> } | null = null;
  let requestGate: { path: string; promise: Promise<void> } | null = null;
  let commandGate: Promise<void> | null = null;
  let web: TrackState | null = options.web === undefined ? { ...webPlaying } : options.web;
  let mpv: Payload = { active: false, playbackStatus: "Stopped", ...(options.mpv ?? {}) };

  const evaluate = async (expression: string) => {
    evaluations.push(expression);
    if (evaluationGate?.expression === expression) await evaluationGate.promise;
    if (isSnapshot(expression)) return web;
    if (expression === "download") return downloadTrack;
    if (expression === "candidate") return candidate;
    if (expression === "commit") { web = { ...web!, trackId: "2", position: 0 }; return true; }
    if (expression === "clock" || expression === "clock:align") {
      if (expression === "clock:align") clockAlignments++;
      const seek = clockSeek;
      clockSeek = null;
      return { seek };
    }
    if (expression.includes("splice")) return { actions: [] };
    return true;
  };
  const fetch = async (url: string, init?: { body?: string; signal?: AbortSignal; keepalive?: boolean }) => {
    requests.push({ url, signal: init?.signal, keepalive: init?.keepalive });
    if (requestGate && url.endsWith(requestGate.path)) await requestGate.promise;
    if (url.endsWith("/configure")) {
      order.push("configure");
      return { ok: !options.configurationError, json: async () => ({ error: options.configurationError }) };
    }
    if (url.endsWith("/state")) return { ok: true, json: async () => mpv };
    if (url.endsWith("/load")) {
      const body = JSON.parse(init!.body!);
      loads.push(body);
      if (body.transition) {
        if (!transitionAccepted) return { ok: true, json: async () => ({ ...mpv, transitionCancelled: true }) };
        mpv = { ...mpv, ...body, active: true, playbackStatus: "Playing", position: 0, transitioning: true };
        return { ok: true, json: async () => ({ ...mpv, transitioned: true }) };
      }
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith("/prepare")) {
      const body = JSON.parse(init!.body!);
      prepares.push(body);
      return { ok: true, json: async () => ({ prepared: Boolean(body.url) }) };
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
    `${source}; ({ Bridge: ExternalAudioBridge, scripts: { mute: EXTERNAL_MUTE_SCRIPT, sync: externalSyncScript, unmute: externalUnmuteScript, controls: EXTERNAL_CONTROL_INSTALL_SCRIPT } })`,
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
      AbortController,
      ffi: () => async () => {
        await endpointGate;
        return "http://localhost|test-token";
      },
      SNAPSHOT_SCRIPT: "snapshot",
      TRANSITION_CANDIDATE_SCRIPT: "candidate",
      transitionCommitScript: () => "commit",
      transitionClockScript: (_id: string, _position: number, align: boolean) => align ? "clock:align" : "clock",
      downloadScript: () => "download",
      tryEvaluateInPlayer: evaluate,
      fetch,
    },
  ) as { Bridge: new (options: unknown) => TestBridge; scripts: PageScripts };

  const bridge = new api.Bridge({
    name: options.mpd ? "MPD" : "mpv",
    ...(options.mpd ? { configuration: () => ({ host: "music.local", port: 6600, password: "", socket: "" }), supportsRate: false } : {}),
    endpoint: async () => { await endpointGate; return "http://localhost|test-token"; },
    quality: () => 1,
    ...(options.transition ? { transition: () => ({ mode: transitionEnabled ? transitionMode : "off" as const, seconds: 6 }) } : {}),
    ...(options.resolver ? {
      holdWebDuringResolution: () => true,
      resolveTrack: async () => {
        const track = await evaluate("download");
        return { ...(track as typeof downloadTrack), source: options.alternate ? "unblock" : "api" };
      },
    } : {}),
    commandWeb: async (command: { action: string }) => {
      webCommands.push(command.action);
      order.push(`web:${command.action}`);
      await commandGate;
      return true;
    },
  });

  return {
    bridge,
    scripts: api.scripts,
    evaluations,
    loads,
    prepares,
    setCandidate: (value: unknown) => { candidate = value; },
    setTransitionEnabled: (value: boolean) => { transitionEnabled = value; },
    setTransitionMode: (value: "normal" | "smart") => { transitionMode = value; },
    setClockSeek: (value: number) => { clockSeek = value; },
    clockAlignments: () => clockAlignments,
    setTransitionAccepted: (value: boolean) => { transitionAccepted = value; },
    webCommands,
    posts,
    volumeCommands,
    positionCommands,
    order,
    requests,
    tick: () => interval(),
    holdEndpoint: (promise: Promise<void> | null) => { endpointGate = promise; },
    holdEvaluation: (expression: string, promise: Promise<void> | null) => {
      evaluationGate = promise ? { expression, promise } : null;
    },
    holdRequest: (path: string, promise: Promise<void> | null) => {
      requestGate = promise ? { path, promise } : null;
    },
    holdWebCommand: (promise: Promise<void> | null) => { commandGate = promise; },
    setWeb: (next: TrackState | null) => { web = next; },
    setMpv: (next: Payload) => { mpv = next; },
    lastSync: () => evaluations.filter(isSync).at(-1) ?? "",
    lastUnmute: () => evaluations.filter(isUnmute).at(-1) ?? "",
  };
}

type TestBridge = {
  setEnabled(enabled: boolean, restoreWeb?: boolean): void;
  command(command: { action: string; value?: number }): Promise<boolean>;
  snapshot(): TrackState;
  getStatus(): string;
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
  return runInNewContext(`${source}; ({ mute: EXTERNAL_MUTE_SCRIPT, sync: externalSyncScript, unmute: externalUnmuteScript, controls: EXTERNAL_CONTROL_INSTALL_SCRIPT })`, stub) as PageScripts;
}

const scripts = pageScripts();

describe("mpv automatic transitions", () => {
  const current = (position: number): Payload => ({ ...webPlaying, position, transportRevision: 0 });
  const plan = { from: "t1", trackId: "2", ready: true, seconds: 6, trim: 0 };

  it("preloads ahead and adopts the next decoder before the song ends", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.prepares.filter(item => item.url).length, 1);
    player.setWeb({ ...webPlaying, position: 95 });
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    assert.equal(player.loads.at(-1)?.transition, true);
    assert.equal(player.loads.at(-1)?.trackId, "2");
    assert.equal(player.bridge.snapshot().trackId, "2");
    assert.equal(player.webCommands.includes("next"), false);
    assert.equal(player.posts.includes("setposition"), false);
  });

  it("clears a stale preload after a queue change or entering a room", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    player.setCandidate(null);
    player.tick();
    await flush();
    assert.equal(player.prepares.at(-1)?.url, undefined);
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    assert.equal(player.loads.some(item => item.transition), false);
  });

  it("keeps pause responsive while the next audio address is resolving", async () => {
    const gate = deferred();
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    player.setCandidate({ from: "t1", song: { id: 3, name: "Third", artist: "Artist" } });
    player.holdEvaluation("download", gate.promise);
    player.tick();
    await flush();
    await player.bridge.command({ action: "pause" });
    assert.equal(player.posts.at(-1), "pause");
    player.bridge.setEnabled(false);
    gate.resolve();
    await flush();
    assert.equal(player.prepares.filter(item => item.url).length, 1);
  });

  it("keeps pause effective while the webpage catches up with the audio handoff", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    const gate = deferred();
    player.holdEvaluation("commit", gate.promise);
    player.setWeb({ ...webPlaying, position: 95 });
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    await player.bridge.command({ action: "pause" });
    player.setMpv({ ...current(0), trackId: "2", playbackStatus: "Paused", transitioning: true });
    gate.resolve();
    await flush();
    assert.equal(player.loads.filter(item => item.transition).length, 1);
    assert.equal(player.posts.at(-1), "pause");
    assert.equal(player.bridge.snapshot().playbackStatus, "Paused");
    player.tick();
    await flush();
    assert.equal(player.loads.length, 2); // 初次装载和过渡接管，没有重新 loadfile 恢复播放。
    assert.equal(player.bridge.snapshot().playbackStatus, "Paused");
  });

  it("starts mixing before waiting for the webpage to resolve the next song", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    const gate = deferred();
    player.holdEvaluation("commit", gate.promise);
    player.setWeb({ ...webPlaying, position: 95 });
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    assert.equal(player.loads.at(-1)?.transition, true);
    gate.resolve();
    await flush();
  });

  it("does not switch the webpage when the prepared decoder cannot be adopted", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    player.setTransitionAccepted(false);
    player.setWeb({ ...webPlaying, position: 95 });
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    assert.equal(player.evaluations.includes("commit"), false);
  });

  it("aligns stale webpage progress without seeking mpv or cutting off its tail", async () => {
    const player = setup({ transition: true, web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    player.setWeb({ ...webPlaying, position: 95 });
    player.setMpv({ ...current(95), transition: plan });
    player.tick();
    await flush();
    player.setCandidate(null);
    for (const position of [95, 96, 97]) {
      player.setWeb({ ...webPlaying, trackId: "2", position });
      player.setMpv({ ...current(1), trackId: "2", transitioning: true });
      player.tick();
      await flush();
    }
    assert.equal(player.clockAlignments(), 3);
    assert.equal(player.posts.includes("setposition"), false);
    assert.equal(player.loads.filter(item => item.transition).length, 1);
    player.setClockSeek(30);
    player.tick();
    await flush();
    assert.equal(player.positionCommands.at(-1), 30_000_000);
  });

  it("stops the outgoing tail when the feature is turned off", async () => {
    const player = setup({ transition: true, mpv: current(10) });
    player.bridge.setEnabled(true);
    await flush();
    player.setTransitionEnabled(false);
    player.setMpv({ ...current(10), transitioning: true });
    player.tick();
    await flush();
    assert.equal(player.prepares.at(-1)?.cancelFade, true);
  });

  it("asks the backend for beat mixing and adopts right before the planned beat", async () => {
    const player = setup({ transition: true, transitionMode: "smart", web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.prepares.at(-1)?.mode, "smart");
    const smart = { from: "t1", trackId: "2", ready: true, seconds: 16, trim: 0, mode: "smart", startAt: 94.8 };
    player.setWeb({ ...webPlaying, position: 93.7 });
    player.setMpv({ ...current(93.7), transition: smart });
    player.tick();
    await flush();
    assert.equal(player.loads.at(-1)?.transition, true);
    assert.equal(player.loads.at(-1)?.trackId, "2");
    assert.equal(player.bridge.snapshot().trackId, "2");
  });

  it("keeps waiting for the planned beat until the smart preload is ready", async () => {
    const player = setup({ transition: true, transitionMode: "smart", web: { ...webPlaying, position: 60 }, mpv: current(60) });
    player.bridge.setEnabled(true);
    await flush();
    const smart = { from: "t1", trackId: "2", ready: true, seconds: 16, trim: 0, mode: "smart", startAt: 97 };
    // 距离拍点还有 3 秒以上时不该提前接管。
    player.setWeb({ ...webPlaying, position: 93 });
    player.setMpv({ ...current(93), transition: smart });
    player.tick();
    await flush();
    assert.equal(player.loads.some(item => item.transition), false);
    player.setWeb({ ...webPlaying, position: 96.2 });
    player.setMpv({ ...current(96.2), transition: smart });
    player.tick();
    await flush();
    assert.equal(player.loads.at(-1)?.transition, true);
  });

  it("keeps the tail fading when the new song is the last in the queue", async () => {
    const player = setup({ transition: true, mpv: current(10) });
    player.bridge.setEnabled(true);
    await flush();
    player.setCandidate(null);
    player.setMpv({ ...current(10), transitioning: true });
    player.tick();
    await flush();
    assert.equal(player.prepares.some(item => item.cancelFade), false);
  });
});

function page() {
  class FakeControl {
    id: string;
    constructor(id: string) { this.id = id; }
    closest() { return this; }
  }
  type ClickEvent = { target: FakeControl; preventDefault(): void; stopPropagation(): void };
  const clickListeners = new Set<(event: ClickEvent) => void>();
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
    Element: FakeControl,
    document: {
      querySelectorAll: (selector: string) => (selector === "audio, video" ? attached.slice() : []),
      addEventListener(type: string, listener: (event: ClickEvent) => void) {
        if (type === "click") clickListeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: ClickEvent) => void) {
        if (type === "click") clickListeners.delete(listener);
      },
    },
  });
  return {
    context,
    attached,
    FakeMedia,
    clickListenerCount: () => clickListeners.size,
    click(id: string, nativeAction: () => void = () => {}) {
      let prevented = false;
      let stopped = false;
      const event = {
        target: new FakeControl(id),
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
      };
      for (const listener of clickListeners) listener(event);
      if (!prevented && !stopped) nativeAction();
      return { prevented, stopped };
    },
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

describe("external audio page scripts", () => {
  it("restores native pause and track controls when switching back to web playback", () => {
    const web = page();
    const node = new web.FakeMedia();
    node.paused = false;
    web.run(scripts.controls);
    assert.equal(web.click("btn_pc_minibar_play", () => node.pause()).prevented, true);
    assert.equal(node.paused, false);
    web.run(`globalThis.__NEMusicOnSteamMpvControls.allowAction = 'next';`);
    web.run(scripts.unmute(true));
    assert.equal(web.clickListenerCount(), 0);
    assert.equal(web.run("globalThis.__NEMusicOnSteamMpvControls.actions.length"), 0);
    assert.equal(web.run("globalThis.__NEMusicOnSteamMpvControls.allowAction"), "");
    assert.deepEqual(web.click("btn_pc_minibar_play", () => node.pause()), { prevented: false, stopped: false });
    assert.equal(node.paused, true);
    for (const id of ["btn_pc_next", "btn_pc_previous"]) {
      let nativeClicks = 0;
      web.click(id, () => { nativeClicks++; });
      assert.equal(nativeClicks, 1);
    }
  });

  it("reinstalls just one mpv click listener when the backend is re-enabled", () => {
    const web = page();
    for (let attempt = 0; attempt < 3; attempt++) {
      web.run(scripts.controls);
      web.run(scripts.controls);
      assert.equal(web.clickListenerCount(), 1);
      web.click("btn_pc_minibar_play");
      assert.equal(web.run("globalThis.__NEMusicOnSteamMpvControls.actions.length"), 1);
      web.run(scripts.unmute(false));
      assert.equal(web.clickListenerCount(), 0);
      assert.equal(web.run("globalThis.__NEMusicOnSteamMpvControls.actions.length"), 0);
    }
  });

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

describe("external audio bridge tick", () => {
  it("discards a match when the webpage switches songs during resolution", async () => {
    const player = setup({ resolver: true });
    const pending = deferred();
    player.holdEvaluation("download", pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    player.setWeb({ ...webPlaying, trackId: "t2", title: "另一首" });
    pending.resolve();
    await flush();
    assert.equal(player.loads.length, 0);
    player.setMpv({ active: true, playbackStatus: "Playing", trackId: "t2" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 1);
    assert.equal(player.loads[0].trackId, "t2");
    player.bridge.setEnabled(false);
  });

  it("holds the trial player paused and does not seek the substitute to the trial clock", async () => {
    const player = setup({ resolver: true, alternate: true, mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.loads.length, 1);
    player.setMpv({ active: true, playbackStatus: "Playing", trackId: "t1", position: 70, volume: 1 });
    player.tick();
    await flush();
    assert.deepEqual(player.positionCommands, []);
    assert.match(player.lastSync(), /if \(false\)/);
    assert.match(player.lastSync(), /else if \(true\)/);
    player.bridge.setEnabled(false);
  });

  it("respects pause and stop commands issued during a slow audio match", async () => {
    for (const action of ["pause", "stop"]) {
      const player = setup({ resolver: true, alternate: true });
      const pending = deferred();
      player.holdEvaluation("download", pending.promise);
      player.bridge.setEnabled(true);
      await flush();
      await player.bridge.command({ action });
      player.setMpv({ active: action !== "stop", playbackStatus: action === "stop" ? "Stopped" : "Paused", trackId: "t1" });
      pending.resolve();
      await flush();
      assert.equal(player.loads.length, action === "stop" ? 0 : 1);
      if (action === "pause") assert.equal(player.loads[0].autoplay, false);
      player.bridge.setEnabled(false);
    }
  });

  it("reloads a lost alternate track even though the trial webpage is held paused", async () => {
    const player = setup({ resolver: true, alternate: true, mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    player.setWeb({ ...webPlaying, playbackStatus: "Paused" });
    player.setMpv({ active: false, playbackStatus: "Stopped" });
    player.tick();
    await flush();
    assert.equal(player.loads.length, 2);
    assert.equal(player.loads[1].autoplay, true);
    player.bridge.setEnabled(false);
  });

  it("dispatches shutdown without evaluating or resuming the page when Steam exits", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    await flush();
    player.evaluations.length = 0;
    player.requests.length = 0;
    player.bridge.setEnabled(false, false);
    assert.deepEqual(player.evaluations, []);
    assert.deepEqual(player.requests.map(request => ({ url: request.url, keepalive: request.keepalive })), [
      { url: "http://localhost/shutdown", keepalive: true },
    ]);
    await flush();
    player.tick();
    assert.deepEqual(player.evaluations, []);
  });

  it("does not mute or load a resolved track after the backend is disabled", async () => {
    const player = setup();
    const pending = deferred();
    player.holdEvaluation("download", pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    assert.ok(player.evaluations.includes("download"));
    player.bridge.setEnabled(false);
    await flush();
    const evaluationsAfterStop = player.evaluations.length;
    pending.resolve();
    await flush();
    assert.equal(player.evaluations.length, evaluationsAfterStop);
    assert.equal(player.loads.length, 0);
    assert.deepEqual(player.requests.map(request => request.url), ["http://localhost/shutdown"]);
    assert.equal(player.bridge.snapshot().active, false);
  });

  it("ignores a failed old tick after the backend is disabled", async () => {
    const player = setup();
    const pending = deferred();
    player.holdEvaluation("download", pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    player.bridge.setEnabled(false);
    await flush();
    const status = player.bridge.getStatus();
    pending.reject(new Error("old download failed"));
    await flush();
    assert.equal(player.bridge.getStatus(), status);
    assert.equal(player.loads.length, 0);
  });

  it("does not reconnect when a pending endpoint resolves after disable", async () => {
    const player = setup();
    const pending = deferred();
    player.holdEndpoint(pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    player.bridge.setEnabled(false);
    await flush();
    const evaluationsAfterStop = player.evaluations.length;
    pending.resolve();
    await flush();
    assert.equal(player.evaluations.length, evaluationsAfterStop);
    assert.equal(player.requests.length, 0);
  });

  it("aborts HTTP requests and ignores stale state responses on disable", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    const pending = deferred();
    player.holdRequest("/state", pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    const request = player.requests.find(request => request.url.endsWith("/state"));
    assert.ok(request);
    player.bridge.setEnabled(false);
    await flush();
    const evaluationsAfterStop = player.evaluations.length;
    pending.resolve();
    await flush();
    assert.equal(request.signal?.aborted, true);
    assert.equal(player.bridge.snapshot().active, false);
    assert.equal(player.evaluations.length, evaluationsAfterStop);
  });

  it("waits for old cleanup before muting a re-enabled backend", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    const pending = deferred();
    const unmute = player.scripts.unmute(true);
    player.holdEvaluation(unmute, pending.promise);
    player.bridge.setEnabled(false);
    await flush();
    const evaluationsDuringCleanup = player.evaluations.length;
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.evaluations.length, evaluationsDuringCleanup);
    pending.resolve();
    await flush();
    assert.equal(player.loads.length, 2);
    assert.equal(player.bridge.snapshot().active, true);
  });

  it("discards an old track resolution when disabled and immediately re-enabled", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t2" } });
    const pending = deferred();
    player.holdEvaluation("download", pending.promise);
    player.bridge.setEnabled(true);
    await flush();
    player.bridge.setEnabled(false);
    player.setWeb({ ...webPlaying, trackId: "t2" });
    player.bridge.setEnabled(true);
    await flush();
    pending.resolve();
    await flush();
    assert.deepEqual(player.loads.map(load => load.trackId), ["t2"]);
    assert.equal(player.bridge.snapshot().trackId, "t2");
    assert.ok(player.requests.every(request => !request.url.startsWith("null")));
  });

  it("cancels a queued re-enable if disabled again during cleanup", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    player.posts.length = 0;
    const pending = deferred();
    player.holdEvaluation(player.scripts.unmute(true), pending.promise);
    player.bridge.setEnabled(false);
    player.bridge.setEnabled(true);
    player.bridge.setEnabled(false);
    pending.resolve();
    await flush();
    assert.equal(player.loads.length, 1);
    assert.deepEqual(player.posts, ["shutdown"]);
    assert.equal(player.bridge.snapshot().active, false);
  });

  it("does not issue media commands after a pending web command is disabled", async () => {
    const player = setup({ mpv: { active: true, playbackStatus: "Playing", trackId: "t1" } });
    player.bridge.setEnabled(true);
    await flush();
    const pending = deferred();
    player.holdWebCommand(pending.promise);
    const command = player.bridge.command({ action: "volume", value: 0.6 });
    await flush();
    player.bridge.setEnabled(false);
    await flush();
    pending.resolve();
    assert.equal(await command, false);
    assert.deepEqual(player.volumeCommands, []);
    assert.ok(player.requests.every(request => !request.url.startsWith("null")));
  });

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


describe("MPD playback adapter", () => {
  it("configures MPD before loading audio and leaves a missing mixer alone", async () => {
    const player = setup({ mpd: true, mpv: { active: true, playbackStatus: "Playing", trackId: "t1", volume: null } });
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.order[0], "configure");
    assert.equal(player.loads.length, 1);
    assert.deepEqual(player.volumeCommands, []);
    assert.equal(player.bridge.snapshot().volume, null);
    assert.equal(await player.bridge.command({ action: "rate", value: 2 }), false);
    assert.deepEqual(player.webCommands, []);
  });

  it("reports MPD authentication failures before muting the webpage", async () => {
    const player = setup({ mpd: true, configurationError: "MPD 密码认证失败" });
    player.bridge.setEnabled(true);
    await flush();
    assert.match(player.bridge.getStatus(), /MPD 密码认证失败/);
    assert.equal(player.loads.length, 0);
    assert.equal(player.evaluations.some(isMute), false);
  });
});
