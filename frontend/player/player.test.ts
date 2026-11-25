import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { ChromeHandlers, ChromeModel } from "../widget/chrome.ts";
import type { SteamSettingsStatus } from "./player.ts";
import { LIBRARY_ENTRY_FALLBACK_CLASSES } from "../widget/library.ts";
import { NAV_SELECTED_CLASS } from "../widget/nav.ts";
import type { Bounds } from "../widget/layout.ts";
import { sameBounds } from "../widget/layout.ts";
import { isPlayerDocument, PLAYER_URL } from "../constants.ts";
import { browserId, type BrowserView, type BrowserViewCreateOptions, type SteamPopup, type SteamWindow } from "./steam.ts";
import { PLAYER_READY_SCRIPT, playerRecoveryScript, PLAYER_RECOVERY_CHECKPOINT_SCRIPT, PLAYER_RECOVERY_CLEAR_SCRIPT, playerRestoreScript, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";
import { ViewBridges } from "./view-bridges.ts";
import { notificationModeFor } from "../settings/settings.ts";
import { GameProfileSession } from "../playback/game-profile.ts";
import { CAPABILITIES_SCRIPT } from "./capabilities.ts";
import type { PlayerCapabilities } from "./capabilities.ts";
import type { TrackState } from "../mpris/mpris.ts";
import { commandScript, type Command } from "../mpris/mpris-player.ts";
import { parseLyrics, songLyricsScript, type SongLyrics } from "../now-playing/lyrics.ts";
import { SNAPSHOT_SCRIPT } from "./player-access.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./player.ts", import.meta.url), "utf8")
    .replace(/^import [\s\S]*? from [^;]+;\n/gm, "")
    .replace(/^export /gm, ""),
);

type Controller = {
  mode: string;
  status: string;
  view: BrowserView | null;
  owner: SteamWindow | null;
  loaded: boolean;
  booted: boolean;
  pendingOpen: boolean;
  viewCreation: Promise<void> | null;
  desktopFullscreen: boolean;
  windowFullscreen: boolean;
  ensureView(win: SteamWindow, popup: SteamPopup | null): void;
  setFullscreen(active: boolean, fillWindow?: boolean): void;
  render(): unknown;
  tick(): void;
  onVisibilityChange(): void;
  open(): string;
  collapse(): string;
  reload(): string;
  close(): string;
  shutdown(): void;
  settings: { playbackBackend: string };
  applyPlaybackBackend(): void;
  checkCompatibility(force?: boolean): Promise<void>;
  readPlaybackState(): Promise<TrackState | null>;
  controlPlayback(command: Command, trackId?: string): Promise<boolean>;
  readSongLyrics(trackId: string): Promise<SongLyrics | null>;
  compatibility: { capabilities: PlayerCapabilities | null; status: string };
};

function setup(options: { desktopSupported?: boolean; failToggle?: boolean; playbackBackend?: string; keepAliveWhenCollapsed?: boolean; ready?: () => Promise<boolean>; retire?: (destroyNative?: () => void) => Promise<PlayerRecoverySnapshot | null>; steamSettings?: SteamSettingsStatus; saved?: PlayerRecoverySnapshot; restoreSession?: boolean; resumeOnRestore?: boolean; checkpoint?: PlayerRecoverySnapshot; capabilities?: () => PlayerCapabilities | null } = {}) {
  const models: ChromeModel[] = [];
  const toggles: boolean[] = [];
  const created: { view: BrowserView; options: BrowserViewCreateOptions; bounds: Bounds[]; visible: boolean[]; callbacks: Map<string, (...args: unknown[]) => void> }[] = [];
  const destroyed: BrowserView[] = [];
  const evaluations: string[] = [];
  const loadedUrls: string[] = [];
  let popup: SteamPopup | null = null;
  let registrations = 0;
  let unregistrations = 0;
  let sessionReleases = 0;
  const backendChanges: string[] = [];
  let releaseMpvStop: Promise<void> | null = null;
  const bridgeDisables: { enabled: boolean; restoreWeb?: boolean }[] = [];
  let onFullscreenRequest: ((active: boolean, fillWindow: boolean) => void) | null = null;
  let chromeHandlers: ChromeHandlers | null = null;
  let webState: TrackState | null = null;
  const mpvState = { active: true, trackId: "mpv", position: 10 } as TrackState;
  const mpdState = { active: true, trackId: "mpd", position: 20 } as TrackState;
  const audioCommands: { backend: string; command: Command }[] = [];
  let readState: (() => Promise<TrackState | null>) | null = null;
  const client = {
    Window: options.desktopSupported === false ? {} : {
      ToggleFullScreen(active: boolean) {
        if (options.failToggle) throw new Error("toggle failed");
        toggles.push(active);
      },
    },
    BrowserView: {
      Create(options: BrowserViewCreateOptions) {
        const callbacks = new Map<string, (...args: unknown[]) => void>();
        const bounds: Bounds[] = [];
        const visible: boolean[] = [];
        const view: BrowserView = {
          SetBounds(x, y, width, height) { bounds.push({ x, y, width, height }); },
          SetVisible(value) { visible.push(value); },
          LoadURL(url) { loadedUrls.push(url); },
          on(event, callback) { callbacks.set(event, callback); },
        };
        created.push({ view, options, bounds, visible, callbacks });
        return view;
      },
      Destroy(view: BrowserView) { destroyed.push(view); },
    },
  };
  class FakeBridge {
    start() {}
    setEnabled(enabled: boolean, restoreWeb?: boolean) { bridgeDisables.push({ enabled, restoreWeb }); }
    setExternalPlayback() {}
    async stop() {}
    reconnect() {}
    async whenStopped() {}
  }
  const ControllerClass = runInNewContext(`${source}; PlayerController`, {
    PlayerChrome: class {
      mount(_doc: Document, handlers: ChromeHandlers) { chromeHandlers = handlers; }
      render(model: ChromeModel) {
        models.push(model);
        if (model.mode === "expanded") return { x: 0, y: 64, width: 1920, height: 1016 };
        if (model.mode === "collapsed" && model.keepAlive) return { x: 1916, y: 1076, width: 4, height: 4 };
        return null;
      }
      invalidateHeader() {}
      destroy() {}
    },
    MprisBridge: FakeBridge,
    GameProfileSession,
    CAPABILITIES_SCRIPT,
    ViewBridges,
    mprisHelper: {},
    steamToast() {},
    UnblockBridge: class {
      reset() {}
      installPageHook() {}
      getStatus() { return "已关闭"; }
    },
    MpvBridge: class extends FakeBridge {
      snapshot() { return mpvState; }
      async command(command: Command) { audioCommands.push({ backend: "mpv", command }); return true; }
      setEnabled(enabled: boolean, restoreWeb?: boolean) { super.setEnabled(enabled, restoreWeb); backendChanges.push(`mpv:${enabled}`); }
      whenStopped() { return releaseMpvStop ?? Promise.resolve(); }
    },
    MpdBridge: class extends FakeBridge {
      snapshot() { return mpdState; }
      async command(command: Command) { audioCommands.push({ backend: "mpd", command }); return true; }
      setEnabled(enabled: boolean, restoreWeb?: boolean) { super.setEnabled(enabled, restoreWeb); backendChanges.push(`mpd:${enabled}`); }
    },
    WebPreloadBridge: FakeBridge,
    SleepTimer: class { snapshot() { return { mode: "off", remaining: 0, status: "未启用" }; } recoveryVolume(volume: number) { return volume; } async cancel() {} },
    saveSession() {},
    readSession: () => options.saved ?? null,
    notificationModeFor,
    clearSession() {},
    EXTERNAL_MUTE_SCRIPT: "mpv-mute",
    RecognitionBridge: FakeBridge,
    QualityBridge: FakeBridge,
    TogetherBridge: FakeBridge,
    DownloadBridge: FakeBridge,
    FullscreenButtonBridge: class extends FakeBridge {
      refresh(callback: (active: boolean, fillWindow: boolean) => void) { onFullscreenRequest = callback; }
    },
    STEAM_PAGE_FALLBACK_CLASSES: {},
    LIBRARY_ENTRY_FALLBACK_CLASSES,
    NAV_SELECTED_CLASS,
    readSettings: () => ({ keepAliveWhenCollapsed: options.keepAliveWhenCollapsed ?? true, disableBackgroundThrottling: false, playbackBackend: options.playbackBackend ?? "web", restoreSession: options.restoreSession ?? true, resumeOnRestore: options.resumeOnRestore ?? false }),
    browserStorage: () => null,
    findModule: () => null,
    browserId,
    sameBounds,
    BROWSER_VIEW_STACK_TOP: 1,
    PLAYER_URL,
    PLAYER_USER_AGENT: "Steam",
    SNAPSHOT_SCRIPT, commandScript, parseLyrics, songLyricsScript,
    isPlayerDocument,
    sharedSteamClient: () => client,
    findMainPopup: () => popup,
    steamPageVisible: () => false,
    steamPageTransition: () => "none",
    tryEvaluateInPlayer: async (expression: string) => {
      evaluations.push(expression);
      if (expression === SNAPSHOT_SCRIPT) return readState ? readState() : webState;
      if (expression.includes("const command =")) return true;
      if (expression.includes("const currentId =")) return { original: "[00:01]Hello", translated: "[00:01]你好", instrumental: false };
      if (expression === PLAYER_READY_SCRIPT) return options.ready ? options.ready() : true;
      if (expression === CAPABILITIES_SCRIPT) return options.capabilities?.() ?? null;
      if (expression === PLAYER_RECOVERY_CHECKPOINT_SCRIPT) return options.checkpoint ?? null;
      return expression.includes("const snapshot =") || expression === "mpv-mute" ? true : null;
    },
    uiScaleScript: () => "scale",
    releasePlayerSession() { sessionReleases++; },
    preparePlayerTarget: async () => {},
    playerRecoveryScript,
    PLAYER_READY_SCRIPT,
    PLAYER_RECOVERY_CHECKPOINT_SCRIPT,
    PLAYER_RECOVERY_CLEAR_SCRIPT,
    playerRestoreScript,
    retirePlayerTargets: options.retire ?? (async () => null),
    window: { setInterval: () => 1, clearInterval() {} },
    console: { warn() {}, error() {} },
  }) as new (steamSettings?: SteamSettingsStatus) => Controller;
  const player = new ControllerClass(options.steamSettings);
  player.mode = "expanded";
  return {
    player,
    models,
    toggles,
    created,
    destroyed,
    evaluations,
    loadedUrls,
    registrations: () => registrations,
    unregistrations: () => unregistrations,
    sessionReleases: () => sessionReleases,
    bridgeDisables,
    backendChanges,
    audioCommands, mpvState, mpdState,
    setWebState(state: TrackState | null) { webState = state; },
    setStateReader(read: () => Promise<TrackState | null>) { readState = read; },
    holdMpvStop(promise: Promise<void> | null) { releaseMpvStop = promise; },
    get chromeHandlers() { return chromeHandlers; },
    async settle() { await player.viewCreation; },
    createPopup(id: number): SteamPopup & { window: SteamWindow } {
      const win = {
        SteamClient: { ...client, Browser: { GetBrowserID: () => id } },
        document: { body: {}, addEventListener() {}, removeEventListener() {} },
        addEventListener() {},
        removeEventListener() {},
      } as unknown as SteamWindow;
      return {
        window: win,
        RegisterChildBrowserView() {
          registrations++;
          return { Unregister() { unregistrations++; } };
        },
      };
    },
    setPopup(next: SteamPopup | null) { popup = next; },
    request(active: boolean, fillWindow: boolean) {
      player.tick();
      assert.ok(onFullscreenRequest);
      onFullscreenRequest(active, fillWindow);
    },
  };
}

describe("song panel player access", () => {
  it("reads and controls each active backend without MPRIS", async () => {
    for (const backend of ["web", "mpv", "mpd"]) {
      const runtime = setup({ playbackBackend: backend });
      runtime.player.view = {} as BrowserView; runtime.player.loaded = true;
      runtime.setWebState({ active: true, trackId: "web", position: 30 } as TrackState);
      assert.equal((await runtime.player.readPlaybackState())?.trackId, backend);
      assert.equal(await runtime.player.controlPlayback({ action: "next" }), true);
      if (backend === "web") assert.ok(runtime.evaluations.includes(commandScript({ action: "next" })));
      else assert.deepEqual(runtime.audioCommands, [{ backend, command: { action: "next" } }]);
    }
  });

  it("does not create a player or send controls when closed or loading", async () => {
    const runtime = setup();
    assert.equal(await runtime.player.readPlaybackState(), null);
    assert.equal(await runtime.player.controlPlayback({ action: "next" }), false);
    assert.equal(await runtime.player.readSongLyrics("123"), null);
    assert.equal(runtime.created.length, 0);
    assert.equal(runtime.evaluations.length, 0);
  });

  it("rejects a seek from a previous track and passes the guard into the webpage", async () => {
    const runtime = setup(); runtime.player.view = {} as BrowserView; runtime.player.loaded = true;
    runtime.setWebState({ active: true, trackId: "123" } as TrackState);
    const command = { action: "setposition", value: 20_000_000 };
    assert.equal(await runtime.player.controlPlayback(command, "old"), false);
    assert.equal(runtime.evaluations.some(script => script.includes("const command =")), false);
    assert.equal(await runtime.player.controlPlayback(command, "123"), true);
    assert.ok(runtime.evaluations.includes(commandScript(command, "123")));
  });

  it("discards state if the view or backend changes while awaiting a read", async () => {
    for (const change of ["view", "backend"]) {
      const runtime = setup(); runtime.player.view = {} as BrowserView; runtime.player.loaded = true;
      let resolve!: (state: TrackState) => void;
      runtime.setStateReader(() => new Promise(done => { resolve = done; }));
      const pending = runtime.player.readPlaybackState();
      if (change === "view") runtime.player.view = {} as BrowserView;
      else runtime.player.settings.playbackBackend = "mpv";
      resolve({ trackId: "123" } as TrackState);
      assert.equal(await pending, null);
    }
  });

  it("parses translated lyrics returned by the player page", async () => {
    const runtime = setup(); runtime.player.view = {} as BrowserView; runtime.player.loaded = true;
    const lyrics = await runtime.player.readSongLyrics("123");
    assert.deepEqual(lyrics?.lines, [{ at: 1, text: "Hello", translation: "你好" }]);
    assert.equal(lyrics?.text, "Hello");
  });
});

describe("web compatibility recovery", () => {
  it("waits for confirmation before disabling a changed feature and re-enables it after recovery", async () => {
    let capabilities: PlayerCapabilities = { playback: true, queue: true, quality: true, together: true, download: true };
    const runtime = setup({ capabilities: () => capabilities });
    runtime.player.loaded = true; runtime.player.view = {} as BrowserView;
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities?.quality, true);
    capabilities = { ...capabilities, quality: false };
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities?.quality, true);
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities?.quality, false);
    assert.equal(runtime.player.compatibility.capabilities?.playback, true);
    capabilities = { ...capabilities, quality: true };
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities?.quality, true);
    capabilities = { ...capabilities, quality: false };
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities?.quality, true);
  });
  it("reports unavailable page state without marking every feature incompatible", async () => {
    const runtime = setup({ capabilities: () => null });
    runtime.player.loaded = true; runtime.player.view = {} as BrowserView;
    await runtime.player.checkCompatibility(true);
    assert.equal(runtime.player.compatibility.capabilities, null);
    assert.match(runtime.player.compatibility.status, /尚未就绪/);
    assert.equal(runtime.bridgeDisables.length, 0);
  });
});

describe("player fullscreen modes", () => {
  it("fills the Steam window without calling desktop fullscreen", () => {
    const runtime = setup();
    runtime.request(true, true);
    assert.equal(runtime.player.windowFullscreen, true);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
    assert.deepEqual(runtime.toggles, []);
    runtime.request(false, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
    assert.deepEqual(runtime.toggles, []);
  });

  it("retains desktop fullscreen for ordinary clicks", () => {
    const runtime = setup();
    runtime.request(true, false);
    assert.equal(runtime.player.desktopFullscreen, true);
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
    runtime.request(false, false);
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });

  it("supports window fill without a desktop fullscreen API", () => {
    const runtime = setup({ desktopSupported: false });
    runtime.request(true, true);
    assert.equal(runtime.player.windowFullscreen, true);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
  });

  it("leaves desktop fullscreen before filling only the window", () => {
    const runtime = setup();
    runtime.request(true, false);
    runtime.request(true, true);
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.player.windowFullscreen, true);
  });

  it("clears window fill when closing the player", () => {
    const runtime = setup();
    runtime.request(true, true);
    runtime.player.close();
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.deepEqual(runtime.toggles, []);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });

  it("restores the Steam window when shutting down in desktop fullscreen", () => {
    const runtime = setup();
    runtime.request(true, false);
    runtime.player.shutdown();
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.player.desktopFullscreen, false);
  });

  it("does not hide the Steam header if desktop fullscreen fails", () => {
    const runtime = setup({ failToggle: true });
    runtime.request(true, false);
    runtime.player.render();
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });
});

describe("player shutdown", () => {
  it("destroys the view once without restoring web playback or reopening after a late tick", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(1);
    runtime.setPopup(popup);
    runtime.player.booted = true;
    runtime.player.tick();
    await runtime.settle();
    runtime.player.shutdown();
    const renders = runtime.models.length;
    runtime.player.shutdown();
    runtime.player.tick();
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.destroyed.length, 1);
    assert.equal(runtime.player.mode, "closed");
    assert.equal(runtime.player.booted, false);
    assert.equal(runtime.player.pendingOpen, false);
    assert.equal(runtime.models.length, renders);
    assert.equal(runtime.bridgeDisables.filter(change => change.restoreWeb === false).length, 2);
  });

  it("does not create a view when shutdown interrupts pending recovery", async () => {
    let release!: (value: null) => void;
    const retirement = new Promise<null>(resolve => { release = resolve; });
    const runtime = setup({ retire: () => retirement });
    const popup = runtime.createPopup(1);
    runtime.setPopup(popup);
    runtime.player.tick();
    runtime.player.shutdown();
    release(null);
    await runtime.settle();
    runtime.player.tick();
    assert.equal(runtime.created.length, 0);
    assert.equal(runtime.player.mode, "closed");
  });
});

describe("library menu actions", () => {
  it("opens settings for the main Steam window and closes playback only for the close action", () => {
    const windows: SteamWindow[] = [];
    const runtime = setup({ steamSettings: { entryStatus: () => "waiting", open: win => { windows.push(win); } } });
    const popup = runtime.createPopup(1);
    runtime.setPopup(popup);
    runtime.player.mode = "closed";
    runtime.player.tick();
    assert.ok(runtime.chromeHandlers);
    runtime.chromeHandlers.onSettings();
    assert.deepEqual(windows, [popup.window]);
    assert.equal(runtime.player.mode, "closed");
    runtime.player.mode = "collapsed";
    runtime.chromeHandlers.onClose();
    assert.equal(runtime.player.mode, "closed");
  });
});

describe("player view reuse after Big Picture", () => {
  it("does not restore or inject UI settings until the actual webpage is ready", async () => {
    let ready!: (value: boolean) => void;
    const snapshot: PlayerRecoverySnapshot = { href: PLAYER_URL, current: { resourceId: "123" }, queue: [], position: 82, playing: true, volume: 0.4, mode: "playCycle" };
    const runtime = setup({ ready: () => new Promise(resolve => { ready = resolve; }), retire: async () => snapshot });
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    runtime.created[0].callbacks.get("finished-request")?.(PLAYER_URL);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.evaluations, [PLAYER_READY_SCRIPT]);
    ready(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(runtime.evaluations.includes("scale"));
    assert.ok(runtime.evaluations.some(expression => expression.includes("const snapshot =")));
  });

  it("reloads a broken React page once without restoring into its incomplete store", async () => {
    const runtime = setup({ ready: async () => false });
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    record.callbacks.get("finished-request")?.(PLAYER_URL);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.loadedUrls, [PLAYER_URL]);
    assert.equal(runtime.player.loaded, false);
    record.callbacks.get("finished-request")?.(PLAYER_URL);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.loadedUrls, [PLAYER_URL]);
    assert.match(runtime.player.status, /初始化失败/);
    assert.ok(runtime.evaluations.every(expression => expression === PLAYER_READY_SCRIPT));
  });

  it("uses the exact official URL on creation and reload without touching the cookie URL", async () => {
    const runtime = setup();
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    assert.equal(runtime.created[0].options.strInitialURL, PLAYER_URL);
    runtime.player.reload();
    assert.deepEqual(runtime.loadedUrls, [PLAYER_URL]);
    assert.equal(new URL(runtime.created[0].options.strInitialURL!).search, "");
  });

  it("keeps the loaded page while the desktop popup is unavailable and reuses it on return", async () => {
    const runtime = setup();
    const original = runtime.createPopup(7);
    runtime.setPopup(original);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    record.callbacks.get("finished-request")?.(PLAYER_URL);
    const status = runtime.player.status;
    const sessionReleases = runtime.sessionReleases();

    runtime.setPopup(null);
    runtime.player.tick();
    assert.equal(runtime.player.view, record.view);
    assert.equal(runtime.player.loaded, true);

    const restored = runtime.createPopup(7);
    runtime.setPopup(restored);
    runtime.player.tick();
    runtime.player.open();

    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.destroyed.length, 0);
    assert.equal(runtime.player.view, record.view);
    assert.equal(runtime.player.owner, restored.window);
    assert.equal(runtime.player.loaded, true);
    assert.equal(runtime.player.status, status);
    assert.equal(runtime.sessionReleases(), sessionReleases);
    assert.equal(runtime.registrations(), 2);
    assert.equal(runtime.unregistrations(), 1);
    assert.ok(record.visible.includes(false));
    assert.equal(record.visible.at(-1), true);
  });

  it("reattaches when the exact same desktop popup returns after Big Picture", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    record.callbacks.get("finished-request")?.(PLAYER_URL);
    const sessionReleases = runtime.sessionReleases();
    const visibilityCount = record.visible.length;
    const boundsCount = record.bounds.length;

    runtime.setPopup(null);
    runtime.player.tick();
    runtime.player.tick();
    assert.equal(record.visible.length, visibilityCount);
    assert.equal(record.bounds.length, boundsCount);

    runtime.setPopup(popup);
    runtime.player.tick();
    assert.equal(record.visible[visibilityCount], false);
    assert.equal(record.visible.at(-1), true);
    assert.ok(record.bounds.length > boundsCount);
    assert.equal(runtime.registrations(), 2);
    assert.equal(runtime.unregistrations(), 1);
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.destroyed.length, 0);
    assert.equal(runtime.player.loaded, true);
    assert.equal(runtime.sessionReleases(), sessionReleases);

    const reattachedCount = record.visible.length;
    runtime.player.tick();
    assert.equal(record.visible.length, reattachedCount);
  });

  it("defers reattachment while the desktop document is hidden", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    const visibilityCount = record.visible.length;
    const boundsCount = record.bounds.length;

    Object.defineProperty(popup.window.document, "hidden", { value: true, configurable: true });
    runtime.player.tick();
    assert.equal(record.visible.length, visibilityCount);
    assert.equal(record.bounds.length, boundsCount);
    Object.defineProperty(popup.window.document, "hidden", { value: false });
    runtime.player.tick();
    assert.equal(record.visible[visibilityCount], false);
    assert.equal(record.visible.at(-1), true);
    assert.ok(record.bounds.length > boundsCount);
    assert.equal(runtime.created.length, 1);
  });

  it("remembers a visibility loss even if no polling tick sees the hidden desktop", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    const visibilityCount = record.visible.length;

    Object.defineProperty(popup.window.document, "hidden", { value: true, configurable: true });
    runtime.player.onVisibilityChange();
    Object.defineProperty(popup.window.document, "hidden", { value: false });
    runtime.player.open();
    assert.equal(record.visible[visibilityCount], false);
    assert.equal(record.visible.at(-1), true);
    assert.equal(runtime.created.length, 1);
  });

  it("reattaches after document replacement on the same WindowProxy", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    const visibilityCount = record.visible.length;

    Object.defineProperty(popup.window, "document", { value: runtime.createPopup(7).window.document });
    runtime.player.tick();
    assert.equal(record.visible[visibilityCount], false);
    assert.equal(record.visible.at(-1), true);
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.registrations(), 2);
    assert.equal(runtime.unregistrations(), 1);
  });

  it("reregisters a replacement popup that shares the same desktop window", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    const visibilityCount = record.visible.length;

    runtime.setPopup({ ...popup });
    runtime.player.tick();
    assert.equal(record.visible[visibilityCount], false);
    assert.equal(record.visible.at(-1), true);
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.registrations(), 2);
    assert.equal(runtime.unregistrations(), 1);
  });

  it("recreates the view when the native browser ID changes on the same desktop window", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();

    popup.window.SteamClient!.Browser!.GetBrowserID = () => 8;
    runtime.player.tick();
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.deepEqual(runtime.destroyed, [runtime.created[0].view]);
    assert.equal(runtime.created[1].options.parentPopupBrowserID, 8);
  });

  it("does not show a collapsed player with keep-alive disabled when the desktop returns", async () => {
    const runtime = setup({ keepAliveWhenCollapsed: false });
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    runtime.player.collapse();
    const record = runtime.created[0];
    const visibilityCount = record.visible.length;

    runtime.setPopup(null);
    runtime.player.tick();
    runtime.setPopup(popup);
    runtime.player.tick();
    assert.ok(record.visible.length > visibilityCount);
    assert.ok(record.visible.slice(visibilityCount).every(visible => !visible));
    assert.equal(runtime.player.mode, "collapsed");
    assert.equal(runtime.created.length, 1);
  });

  it("does not recreate or reregister the view for repeated opens of the same popup", async () => {
    const runtime = setup();
    const popup = runtime.createPopup(7);
    runtime.setPopup(popup);
    runtime.player.open();
    await runtime.settle();
    runtime.player.open();
    runtime.player.tick();
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.destroyed.length, 0);
    assert.equal(runtime.registrations(), 1);
    assert.equal(runtime.unregistrations(), 0);
  });

  it("reuses the loaded page when clicked before the next desktop polling tick", async () => {
    const runtime = setup();
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    const record = runtime.created[0];
    record.callbacks.get("finished-request")?.(PLAYER_URL);
    const restored = runtime.createPopup(7);
    runtime.setPopup(restored);
    runtime.player.open();
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.destroyed.length, 0);
    assert.equal(runtime.player.view, record.view);
    assert.equal(runtime.player.owner, restored.window);
    assert.equal(runtime.player.loaded, true);
  });

  it("recreates the view only when the native parent browser actually changes", async () => {
    const runtime = setup();
    const original = runtime.createPopup(7);
    const replacement = runtime.createPopup(8);
    runtime.player.ensureView(original.window, original);
    await runtime.settle();
    runtime.player.ensureView(replacement.window, replacement);
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.deepEqual(runtime.destroyed, [runtime.created[0].view]);
    assert.equal(runtime.created[1].options.parentPopupBrowserID, 8);
    assert.equal(runtime.player.owner, replacement.window);
  });

  it("destroys the native view during retirement instead of waiting until target cleanup has finished", async () => {
    let retire: (destroyNative?: () => void) => Promise<PlayerRecoverySnapshot | null> = async () => null;
    const runtime = setup({ retire: destroyNative => retire(destroyNative) });
    const original = runtime.createPopup(7);
    const replacement = runtime.createPopup(8);
    runtime.player.ensureView(original.window, original);
    await runtime.settle();
    const previous = runtime.created[0].view;
    retire = async destroyNative => {
      assert.equal(runtime.destroyed.length, 0);
      destroyNative?.();
      assert.deepEqual(runtime.destroyed, [previous]);
      return null;
    };
    runtime.player.ensureView(replacement.window, replacement);
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.deepEqual(runtime.destroyed, [previous]);
    assert.equal(runtime.player.owner, replacement.window);
  });

  it("ignores delayed close and load events from a replaced view", async () => {
    const runtime = setup();
    const original = runtime.createPopup(7);
    const replacement = runtime.createPopup(8);
    runtime.player.ensureView(original.window, original);
    await runtime.settle();
    const previous = runtime.created[0];
    runtime.player.ensureView(replacement.window, replacement);
    await runtime.settle();
    const status = runtime.player.status;

    previous.callbacks.get("finished-request")?.(PLAYER_URL);
    assert.equal(runtime.player.loaded, false);
    previous.callbacks.get("load-error")?.(-1, PLAYER_URL, "old error");
    assert.equal(runtime.player.status, status);
    previous.callbacks.get("before-close")?.();
    assert.equal(runtime.player.view, runtime.created[1].view);
    assert.equal(runtime.player.mode, "expanded");
  });

  it("still destroys the page on explicit close and creates a new one on reopen", async () => {
    const runtime = setup();
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    runtime.player.close();
    assert.equal(runtime.player.view, null);
    runtime.player.open();
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.deepEqual(runtime.destroyed, [runtime.created[0].view]);
  });

  it("waits for all old targets to close before creating a replacement", async () => {
    let release!: (snapshot: PlayerRecoverySnapshot | null) => void;
    let retire = async (): Promise<PlayerRecoverySnapshot | null> => null;
    const runtime = setup({ retire: () => retire() });
    const original = runtime.createPopup(7);
    runtime.setPopup(original);
    runtime.player.open();
    await runtime.settle();
    retire = () => new Promise(resolve => { release = resolve; });
    runtime.setPopup(runtime.createPopup(8));
    runtime.player.open();
    runtime.player.tick();
    runtime.player.open();
    assert.equal(runtime.created.length, 1);
    const snapshot: PlayerRecoverySnapshot = {
      href: PLAYER_URL + "?nemusic_view=legacy&page=playlist#queue",
      current: { resourceId: "123" },
      queue: [{ resourceId: "123" }],
      position: 82,
      playing: true,
      volume: 0.4,
      mode: "playCycle",
    };
    release(snapshot);
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.equal(runtime.created[1].options.strInitialURL, PLAYER_URL);
  });

  it("never creates another page when old target cleanup fails", async () => {
    const runtime = setup({ retire: async () => { throw new Error("old target still playing"); } });
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    runtime.player.tick();
    await runtime.settle();
    assert.equal(runtime.created.length, 0);
    assert.match(runtime.player.status, /old target still playing/);
  });

  it("does not reopen a view if closed while waiting for old target cleanup", async () => {
    let release!: (snapshot: null) => void;
    const runtime = setup({ retire: () => new Promise(resolve => { release = resolve; }) });
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    runtime.player.close();
    release(null);
    await runtime.settle();
    assert.equal(runtime.created.length, 0);
    assert.equal(runtime.player.mode, "closed");
  });

  it("recovers instead of closing the controller when Big Picture closes its parent window", async () => {
    const runtime = setup();
    const original = runtime.createPopup(7);
    runtime.setPopup(original);
    runtime.player.open();
    await runtime.settle();
    runtime.setPopup(null);
    Object.defineProperty(original.window, "closed", { value: true });
    runtime.created[0].callbacks.get("before-close")?.();
    assert.equal(runtime.player.view, null);
    assert.equal(runtime.player.mode, "expanded");
    assert.equal(runtime.player.pendingOpen, true);
    runtime.setPopup(runtime.createPopup(8));
    runtime.player.tick();
    await runtime.settle();
    assert.equal(runtime.created.length, 2);
    assert.ok(runtime.player.view);
  });

  for (const backend of ["mpv", "mpd"]) it(`mutes the replacement before restoring playback with ${backend}`, async () => {
    const snapshot: PlayerRecoverySnapshot = {
      href: PLAYER_URL,
      current: { resourceId: "123" },
      queue: [],
      position: 82,
      playing: true,
      volume: 0.4,
      mode: "playOrder",
    };
    const runtime = setup({ playbackBackend: backend, retire: async () => snapshot });
    runtime.setPopup(runtime.createPopup(7));
    runtime.player.open();
    await runtime.settle();
    runtime.created[0].callbacks.get("finished-request")?.(runtime.created[0].options.strInitialURL);
    await new Promise<void>(resolve => setImmediate(resolve));
    const muted = runtime.evaluations.indexOf("mpv-mute");
    const restored = runtime.evaluations.findIndex(expression => expression.includes("const snapshot ="));
    assert.ok(muted >= 0 && muted < restored);
    assert.match(runtime.player.status, /已接回/);
  });
});


describe("MPD backend switching", () => {
  it("keeps both external backends disabled in web mode even with mpv transitions saved", async () => {
    const runtime = setup();
    runtime.player.view = {} as BrowserView;
    Object.assign(runtime.player.settings, { mpvTransitionMode: "auto", mpvCrossfade: "standard", preloadNext: true });
    runtime.player.applyPlaybackBackend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.backendChanges, ["mpv:false", "mpd:false"]);
  });

  it("does not enable a pending external backend after switching back to web", async () => {
    const runtime = setup({ playbackBackend: "mpd" });
    runtime.player.view = {} as BrowserView;
    let release!: () => void;
    runtime.holdMpvStop(new Promise<void>(resolve => { release = resolve; }));
    runtime.player.applyPlaybackBackend();
    runtime.player.settings.playbackBackend = "web";
    runtime.player.applyPlaybackBackend();
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runtime.backendChanges.includes("mpv:true"), false);
    assert.equal(runtime.backendChanges.includes("mpd:true"), false);
  });

  it("waits for the previous backend to finish before enabling MPD", async () => {
    const runtime = setup({ playbackBackend: "mpd" });
    runtime.player.view = {} as BrowserView;
    let release!: () => void;
    runtime.holdMpvStop(new Promise<void>(resolve => { release = resolve; }));
    runtime.player.applyPlaybackBackend();
    assert.deepEqual(runtime.backendChanges, ["mpv:false"]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.backendChanges, ["mpv:false", "mpd:true"]);
  });

  it("does not start MPD if the player closes while the old backend stops", async () => {
    const runtime = setup({ playbackBackend: "mpd" });
    runtime.player.view = {} as BrowserView;
    let release!: () => void;
    runtime.holdMpvStop(new Promise<void>(resolve => { release = resolve; }));
    runtime.player.applyPlaybackBackend();
    runtime.player.shutdown();
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runtime.backendChanges.includes("mpd:true"), false);
  });
});

describe("persistent session restore policy", () => {
  const saved: PlayerRecoverySnapshot = { href: PLAYER_URL, current: { resourceId: "123" }, queue: [{ resourceId: "123" }, { resourceId: "456" }], position: 82, playing: true, volume: 0.4, mode: "playCycle" };
  async function restore(options: Parameters<typeof setup>[0]) {
    const runtime = setup(options); runtime.setPopup(runtime.createPopup(7)); runtime.player.open(); await runtime.settle();
    runtime.created[0].callbacks.get("finished-request")?.(PLAYER_URL); await new Promise<void>(resolve => setImmediate(resolve));
    return runtime.evaluations.find(expression => expression.includes("const snapshot =")) ?? "";
  }
  it("restores queue and position paused by default after restart", async () => {
    const script = await restore({ saved }); assert.match(script, /"position":82/); assert.match(script, /"playing":false/); assert.match(script, /456/);
  });
  it("only resumes automatically when enabled", async () => {
    assert.match(await restore({ saved, resumeOnRestore: true }), /"playing":true/);
  });
  it("does not restore persistent sessions or webpage checkpoints when disabled", async () => {
    assert.equal(await restore({ saved, checkpoint: saved, restoreSession: false }), "");
  });
  it("applies the auto-resume preference to a recent webpage checkpoint too", async () => {
    assert.match(await restore({ checkpoint: saved }), /"playing":false/);
  });
  it("keeps live in-process recovery playing across parent window changes", async () => {
    assert.match(await restore({ retire: async () => saved }), /"playing":true/);
  });
});
