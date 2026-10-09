import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { ChromeModel } from "../widget/chrome.ts";
import type { Bounds } from "../widget/layout.ts";
import { sameBounds } from "../widget/layout.ts";
import { isPlayerDocument, PLAYER_URL } from "../constants.ts";
import { browserId, type BrowserView, type BrowserViewCreateOptions, type SteamPopup, type SteamWindow } from "./steam.ts";
import { PLAYER_READY_SCRIPT, PLAYER_RECOVERY_SCRIPT, PLAYER_RECOVERY_CHECKPOINT_SCRIPT, PLAYER_RECOVERY_CLEAR_SCRIPT, playerRestoreScript, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";

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
};

function setup(options: { desktopSupported?: boolean; failToggle?: boolean; playbackBackend?: string; keepAliveWhenCollapsed?: boolean; ready?: () => Promise<boolean>; retire?: (destroyNative?: () => void) => Promise<PlayerRecoverySnapshot | null> } = {}) {
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
  let onFullscreenRequest: ((active: boolean, fillWindow: boolean) => void) | null = null;
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
    setEnabled() {}
    setExternalPlayback() {}
    async stop() {}
  }
  const ControllerClass = runInNewContext(`${source}; PlayerController`, {
    PlayerChrome: class {
      mount() {}
      render(model: ChromeModel) {
        models.push(model);
        if (model.mode === "expanded") return { x: 0, y: 64, width: 1920, height: 1016 };
        if (model.mode === "collapsed" && model.keepAlive) return { x: 1916, y: 1076, width: 4, height: 4 };
        return null;
      }
      invalidateHeader() {}
      dismissToolbar() {}
      destroy() {}
    },
    MprisBridge: FakeBridge,
    MpvBridge: FakeBridge,
    MPV_MUTE_SCRIPT: "mpv-mute",
    RecognitionBridge: FakeBridge,
    QualityBridge: FakeBridge,
    TogetherBridge: FakeBridge,
    DownloadBridge: FakeBridge,
    FullscreenButtonBridge: class extends FakeBridge {
      refresh(callback: (active: boolean, fillWindow: boolean) => void) { onFullscreenRequest = callback; }
    },
    STEAM_PAGE_FALLBACK_CLASSES: {},
    readSettings: () => ({ keepAliveWhenCollapsed: options.keepAliveWhenCollapsed ?? true, disableBackgroundThrottling: false, playbackBackend: options.playbackBackend ?? "web" }),
    browserStorage: () => null,
    findModule: () => null,
    browserId,
    sameBounds,
    BROWSER_VIEW_STACK_TOP: 1,
    PLAYER_URL,
    PLAYER_USER_AGENT: "Steam",
    isPlayerDocument,
    sharedSteamClient: () => client,
    findMainPopup: () => popup,
    steamPageVisible: () => false,
    steamPageTransition: () => "none",
    tryEvaluateInPlayer: async (expression: string) => {
      evaluations.push(expression);
      if (expression === PLAYER_READY_SCRIPT) return options.ready ? options.ready() : true;
      return expression.includes("const snapshot =") || expression === "mpv-mute" ? true : null;
    },
    uiScaleScript: () => "scale",
    releasePlayerSession() { sessionReleases++; },
    preparePlayerTarget: async () => {},
    PLAYER_RECOVERY_SCRIPT,
    PLAYER_READY_SCRIPT,
    PLAYER_RECOVERY_CHECKPOINT_SCRIPT,
    PLAYER_RECOVERY_CLEAR_SCRIPT,
    playerRestoreScript,
    retirePlayerTargets: options.retire ?? (async () => null),
    window: { setInterval: () => 1, clearInterval() {} },
    console: { warn() {}, error() {} },
  }) as new () => Controller;
  const player = new ControllerClass();
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

  it("mutes the replacement before restoring playback with the mpv backend", async () => {
    const snapshot: PlayerRecoverySnapshot = {
      href: PLAYER_URL,
      current: { resourceId: "123" },
      queue: [],
      position: 82,
      playing: true,
      volume: 0.4,
      mode: "playOrder",
    };
    const runtime = setup({ playbackBackend: "mpv", retire: async () => snapshot });
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
