import { findModule } from "millennium";
import { PlayerChrome, type NavEntryStatus, type PlayerMode } from "../widget/chrome.ts";
import { isPlayerDocument, PLAYER_URL, PLAYER_USER_AGENT } from "../constants.ts";
import { DownloadBridge, type DownloadSnapshot } from "../download/download.ts";
import { sameBounds, type Bounds } from "../widget/layout.ts";
import { MprisBridge } from "../mpris/mpris.ts";
import { MpvBridge, MPV_MUTE_SCRIPT } from "../mpris/mpv.ts";
import { commandScript } from "../mpris/mpris-player.ts";
import { releasePlayerSession, preparePlayerTarget } from "./player-target.ts";
import { tryEvaluateInPlayer } from "./player-target.ts";
import { retirePlayerTargets } from "./player-recovery.ts";
import { PLAYER_READY_SCRIPT, PLAYER_RECOVERY_SCRIPT, PLAYER_RECOVERY_CHECKPOINT_SCRIPT, PLAYER_RECOVERY_CLEAR_SCRIPT, playerRestoreScript, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";
import { uiScaleScript } from "./ui-scale.ts";
import { RecognitionBridge } from "../recognition/recognition.ts";
import { FullscreenButtonBridge } from "../fullscreen/fullscreen.ts";
import { QualityBridge, type QualitySnapshot } from "../quality/quality.ts";
import { TogetherBridge, type TogetherSnapshot } from "../together/together.ts";
import type { IdentityVariant } from "../together/identity-player.ts";
import { browserStorage, readSettings, writeSettings, type PlayerSettings } from "../settings.ts";
import { STEAM_PAGE_FALLBACK_CLASSES, steamPageTransition, steamPageVisible, type SteamPageSelectors } from "./steam-page.ts";
import {
  BROWSER_VIEW_STACK_TOP,
  browserId,
  findMainPopup,
  setBackgroundThrottlingDisabled,
  sharedSteamClient,
  type BrowserView,
  type SteamClient,
  type SteamPopup,
  type SteamWindow,
} from "./steam.ts";
const TICK_MS = 400;
const THROTTLE_REFRESH_MS = 2000;
const VIEW_NAME = "NEMusicOnSteam";
let nextViewId = 1;

function steamPageClasses(): SteamPageSelectors {
  try {
    const css = findModule((module) => typeof module?.MainBrowserContainer === "string");
    if (css == null) return STEAM_PAGE_FALLBACK_CLASSES;
    return {
      main: typeof css.MainBrowserContainer === "string" ? css.MainBrowserContainer : STEAM_PAGE_FALLBACK_CLASSES.main,
      external: typeof css.ExternalBrowserContainer === "string" ? css.ExternalBrowserContainer : STEAM_PAGE_FALLBACK_CLASSES.external,
    };
  } catch (error) {
    console.warn("[NEMusic] Steam page classes", error);
    return STEAM_PAGE_FALLBACK_CLASSES;
  }
}

export type SteamSettingsStatus = { entryStatus: () => "native" | "injected" | "waiting" };

export type PlayerSnapshot = {
  mode: PlayerMode;
  status: string;
  hasView: boolean;
  throttlingSupported: boolean | null;
  mprisStatus: string;
  mpvStatus: string;
  recognitionStatus: string;
  navEntry: NavEntryStatus;
  settingsEntry: "native" | "injected" | "waiting";
  quality: QualitySnapshot;
  together: TogetherSnapshot;
  download: DownloadSnapshot;
  settings: PlayerSettings;
};

export class PlayerController {
  private readonly chrome = new PlayerChrome();
  private readonly mpris = new MprisBridge(() => { this.open(); }, () => { this.close(); }, () => this.settings.notificationMode);
  private readonly mpv = new MpvBridge({
    quality: () => this.settings.downloadQuality,
    commandWeb: async command => Boolean(await tryEvaluateInPlayer(commandScript(command), { userGesture: true, awaitPromise: true })),
  });
  private readonly recognition = new RecognitionBridge();
  private readonly fullscreenButton = new FullscreenButtonBridge();
  private readonly quality = new QualityBridge();
  private readonly together = new TogetherBridge();
  private readonly download = new DownloadBridge(() => ({
    quality: this.settings.downloadQuality,
    directory: this.settings.downloadDirectory,
    nameTemplate: this.settings.downloadNameTemplate,
    notificationMode: this.settings.notificationMode,
    downloadNotificationMode: this.settings.downloadNotificationMode,
  }));
  private steamPageSelectors: SteamPageSelectors = STEAM_PAGE_FALLBACK_CLASSES;
  private steamPageShown: boolean | null = null;
  private yieldedForSteamPage = false;
  private settings: PlayerSettings = readSettings(browserStorage());
  private mode: PlayerMode = "closed";
  private status = "还没打开";
  private view: BrowserView | null = null;
  private parentId: number | null = null;
  private owner: SteamWindow | null = null;
  private client: SteamClient | null = null;
  private booted = false;
  private pendingOpen = false;
  private loaded = false;
  private initializationReloaded = false;
  private desktopFullscreen = false;
  private windowFullscreen = false;
  private throttleForced = false;
  private throttlingSupported: boolean | null = null;
  private lastBounds: Bounds | null = null;
  private viewVisible = false;
  private lastThrottleAt = 0;
  private timer = 0;
  private resizeTarget: Window | null = null;
  private visibilityTarget: Document | null = null;
  private viewPopup: SteamPopup | null = null;
  private viewDocument: Document | null = null;
  private viewNeedsReattach = false;
  private unregisterChild: (() => void) | null = null;
  private destroying = false;
  private viewCreation: Promise<void> | null = null;
  private viewEpoch = 0;
  private recoverySnapshot: PlayerRecoverySnapshot | null = null;
  private restorePending: PlayerRecoverySnapshot | null = null;
  private recoveryBusy = false;
  private recoveryFailed = false;
  private lastRecoveryAt = 0;
  private readonly steamSettings: SteamSettingsStatus | null;

  constructor(steamSettings?: SteamSettingsStatus) {
    this.steamSettings = steamSettings ?? null;
  }

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    this.settings = readSettings(browserStorage());
    this.steamPageSelectors = steamPageClasses();
    this.pendingOpen = this.settings.openOnStart;
    this.timer = window.setInterval(this.tick, TICK_MS);
    this.mpris.start();
    this.mpv.start();
    this.tick();
  }

  shutdown(): void {
    if (this.desktopFullscreen || this.windowFullscreen) this.setFullscreen(false);
    window.clearInterval(this.timer);
    this.timer = 0;
    this.unbindWindow();
    this.pendingOpen = false;
    this.stopExternalPlayback();
    this.destroyView();
    void this.mpris.stop();
    this.forceThrottle(false);
    this.chrome.destroy();
    this.mode = "closed";
    this.booted = false;
    this.owner = null;
  }

  snapshot(): PlayerSnapshot {
    return {
      mode: this.mode,
      status: this.status,
      hasView: this.view != null,
      throttlingSupported: this.throttlingSupported,
      mprisStatus: this.mpris.getStatus(),
      mpvStatus: this.mpv.getStatus(),
      recognitionStatus: this.recognition.getStatus(),
      navEntry: this.chrome.navEntryStatus(),
      settingsEntry: this.steamSettings?.entryStatus() ?? "waiting",
      quality: this.quality.snapshot(),
      together: this.together.snapshot(),
      download: this.download.snapshot(),
      settings: { ...this.settings, launcher: { ...this.settings.launcher } },
    };
  }

  /** 返回刷新后的快照，调用方可以直接喂给 setState。 */
  updateSettings(patch: Partial<PlayerSettings>): PlayerSnapshot {
    this.settings = { ...this.settings, ...patch, launcher: patch.launcher ?? this.settings.launcher };
    writeSettings(browserStorage(), this.settings);
    if (patch.playbackBackend != null) this.applyPlaybackBackend();
    if (patch.uiScale != null) this.applyUiScale();
    this.syncView(true, this.render());
    return this.snapshot();
  }

  setQuality(value: number): void {
    this.quality.setQuality(value);
  }

  startTogether(): void {
    // 建房要用当前正在播的这首歌，先把播放器展开，不然用户看不到房间建在哪。
    this.open();
    this.together.start();
  }

  joinTogether(code: string): void {
    // 进房后页面会切到房间队列，展开播放器才能看到同步效果。
    this.open();
    this.together.join(code);
  }

  leaveTogether(): void {
    this.together.leave();
  }

  setTogetherIdentityVariant(variant: IdentityVariant): void {
    this.together.setIdentityVariant(variant);
  }

  downloadCurrentSong(): void {
    void this.download.download();
  }

  downloadPlayingList(): void {
    this.open();
    void this.download.downloadPlayingList();
  }

  open(): string {
    this.boot();
    this.recoveryFailed = false;
    this.yieldedForSteamPage = false;
    this.pendingOpen = true;
    const popup = findMainPopup();
    if (popup == null || popup.window.document.hidden === true) {
      this.viewNeedsReattach = true;
      this.status = "Steam 主窗口还没准备好，出来之后会自动打开";
      return this.status;
    }
    return this.openOn(popup.window);
  }

  collapse(): string {
    return this.collapseTo(this.settings.keepAliveWhenCollapsed ? "已收起，播放器仍在后台" : "已收起。收起会把页面藏起来，切歌可能停");
  }

  private collapseTo(status: string): string {
    if (this.view == null && this.mode === "closed") return this.status;
    this.pendingOpen = false;
    this.mode = "collapsed";
    this.status = status;
    this.syncView(true, this.render());
    return this.status;
  }

  private syncSteamPage(shown: boolean): void {
    const action = steamPageTransition(this.steamPageShown, shown, this.mode, this.yieldedForSteamPage);
    this.steamPageShown = shown;
    if (action === "none") return;
    if (action === "yield") {
      this.yieldedForSteamPage = true;
      this.collapseTo("Steam 打开了自己的网页，网易云让出画面，音乐继续");
      return;
    }
    this.open();
  }

  close(): string {
    if (this.desktopFullscreen || this.windowFullscreen) this.setFullscreen(false);
    this.pendingOpen = false;
    this.mode = "closed";
    this.status = "已关闭";
    // 关掉播放器要连 mpv 一起停：destroyView 只在换父窗口时也会走，那里音乐得继续。
    this.stopExternalPlayback();
    this.destroyView();
    this.recoverySnapshot = null;
    this.restorePending = null;
    this.forceThrottle(false);
    this.render();
    return this.status;
  }

  reload(): string {
    if (this.view == null) return this.open();
    this.loaded = false;
    this.initializationReloaded = false;
    this.status = "正在刷新";
    try {
      if (typeof this.view.Reload === "function") this.view.Reload();
      else this.view.LoadURL?.(PLAYER_URL);
    } catch (error) {
      this.status = `刷新失败：${errorText(error)}`;
    }
    this.render();
    return this.status;
  }

  private openOn(win: SteamWindow): string {
    this.pendingOpen = false;
    const alreadyShowing = this.mode === "expanded" && this.loaded && this.view != null;
    this.mode = "expanded";
    if (!alreadyShowing) this.status = "正在打开网页播放器";
    try {
      this.ensureChrome(win);
      this.ensureView(win, findMainPopup());
      this.syncView(true, this.render());
      this.focusView();
    } catch (error) {
      this.status = errorText(error);
      console.error("[NEMusic]", error);
    }
    return this.status;
  }

  private tick = (): void => {
    try {
      const popup = findMainPopup();
      const desktopAvailable = popup != null && popup.window.document.hidden !== true;
      if (!desktopAvailable) {
        this.viewNeedsReattach = true;
        this.steamPageShown = null;
      }
      if (desktopAvailable) this.ensureChrome(popup.window);
      if (this.pendingOpen && desktopAvailable) {
        this.openOn(popup.window);
        return;
      }
      if (this.mode !== "closed" && desktopAvailable) {
        this.ensureView(popup.window, popup);
      }
      this.fullscreenButton.refresh(this.setFullscreen);
      this.refreshRecoverySnapshot();
      if (!desktopAvailable) {
        if (this.mode !== "closed") this.refreshThrottle();
        return;
      }
      this.syncView(false, this.render());
      this.syncSteamPage(steamPageVisible(popup.window.document, this.steamPageSelectors));
    } catch (error) {
      this.status = errorText(error);
      console.error("[NEMusic]", error);
    }
  };

  private ensureChrome(win: SteamWindow): void {
    if (win.document?.body == null) return;
    this.chrome.mount(win.document, {
      onOpen: () => this.open(),
      onNavigateAway: () => {
        if (this.mode === "expanded") this.collapse();
      },
      onToolbarChange: () => this.syncView(false, this.render()),
      onCollapse: () => this.collapse(),
      onReload: () => this.reload(),
      onDownloadList: () => this.downloadPlayingList(),
      onClose: () => this.close(),
    });
    this.bindWindowEvents(win);
  }

  private bindWindowEvents(win: SteamWindow): void {
    if (this.resizeTarget !== win) {
      this.unbindWindow();
      this.resizeTarget = win;
      win.addEventListener("resize", this.onResize);
      win.addEventListener("blur", this.onWindowBlur);
    }
    const doc = win.document;
    if (this.visibilityTarget !== doc) {
      this.visibilityTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.visibilityTarget = doc;
      doc.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private unbindWindow(): void {
    this.resizeTarget?.removeEventListener("resize", this.onResize);
    this.resizeTarget?.removeEventListener("blur", this.onWindowBlur);
    this.resizeTarget = null;
    this.visibilityTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityTarget = null;
  }

  private onResize = (): void => {
    this.chrome.invalidateHeader();
    this.syncView(false, this.render());
  };

  private onWindowBlur = (): void => {
    this.chrome.dismissToolbar();
  };

  /**
   * 最小化窗口会把子 BrowserView 的画面一起带走，而 Steam 恢复时并不会把它放回去，于是
   * 我们的界面就显示在一片空白页面之上；工具条也会一直挂着，因为它永远收不到本该关闭
   * 它的那个 mouseleave。
   */
  private onVisibilityChange = (): void => {
    this.chrome.dismissToolbar();
    if (this.visibilityTarget?.hidden === true) {
      this.viewNeedsReattach = true;
      return;
    }
    this.reattachView();
  };

  /** 真正能让 Steam 重建画面的是一次隐藏/显示循环，再调一次 SetVisible(true) 没用。 */
  private reattachView(): void {
    const view = this.view;
    if (view == null) return;
    this.lastBounds = null;
    this.viewVisible = false;
    try {
      view.SetVisible(false);
      this.viewNeedsReattach = false;
    } catch (error) {
      console.warn("[NEMusic] reattach failed", error);
    }
    this.syncView(true, this.render());
  }

  private ensureView(win: SteamWindow, popup: SteamPopup | null): void {
    const client = win.SteamClient?.BrowserView?.Create != null ? win.SteamClient : sharedSteamClient();
    const id = browserId(win.SteamClient) ?? browserId(client);
    if (client?.BrowserView?.Create == null || id == null) {
      throw new Error("这个 Steam 没有可用的 BrowserView 嵌不进去。可能 Steam 更新了什么，请去 Github 查看是否有更新或反馈");
    }
    if (this.view != null && this.parentId === id) {
      if (this.owner !== win || this.viewPopup !== popup || this.viewDocument !== win.document || this.viewNeedsReattach) {
        this.client = client;
        this.owner = win;
        this.bindPopup(popup, win, this.view);
        this.chrome.invalidateHeader();
        this.reattachView();
      }
      return;
    }
    if (this.viewCreation != null || this.recoveryFailed) return;
    const previous = this.view;
    const previousClient = sharedSteamClient() ?? this.client;
    const fallback = this.recoverySnapshot;
    this.destroyView(false);
    const epoch = this.viewEpoch;
    this.status = "正在接回原播放器";
    const creation = this.createView(win, popup, client, id, previous, previousClient, fallback, epoch)
      .catch(error => {
        if (this.viewEpoch !== epoch) return;
        this.recoveryFailed = true;
        this.status = `播放器恢复失败：${errorText(error)}`;
        this.render();
        console.error("[NEMusic] player recovery", error);
      }).finally(() => {
        if (this.viewCreation === creation) this.viewCreation = null;
      });
    this.viewCreation = creation;
  }

  private async createView(
    win: SteamWindow,
    popup: SteamPopup | null,
    client: SteamClient,
    id: number,
    previous: BrowserView | null,
    previousClient: SteamClient | null,
    fallback: PlayerRecoverySnapshot | null,
    epoch: number,
  ): Promise<void> {
    let snapshot: PlayerRecoverySnapshot | null;
    let nativeDestroyed = false;
    const destroyPrevious = () => {
      if (previous == null || nativeDestroyed) return;
      nativeDestroyed = true;
      try {
        previousClient?.BrowserView?.Destroy?.(previous);
      } catch (error) {
        console.warn("[NEMusic] old view destroy failed", error);
      }
    };
    try {
      snapshot = await retirePlayerTargets(destroyPrevious) ?? fallback;
    } finally {
      destroyPrevious();
    }
    if (this.viewEpoch !== epoch || this.mode === "closed" || win.closed) return;
    const viewId = nextViewId++;
    await preparePlayerTarget(`${Date.now().toString(36)}-${viewId}`);
    if (this.viewEpoch !== epoch || win.closed) return;
    const created = client.BrowserView.Create({
      parentPopupBrowserID: id,
      strInitialURL: PLAYER_URL,
      strName: `${VIEW_NAME}-${viewId}`,
      strUserAgentIdentifier: "Valve Steam Client",
      strUserAgentOverride: PLAYER_USER_AGENT,
      bOnlyAllowTrustedPopups: false,
      bPreventCloseFromJavascript: true,
    });
    if (created == null) throw new Error("BrowserView.Create 没有返回画面");
    try {
      created.SetVisible(false);
      created.SetWindowStackingOrder?.(BROWSER_VIEW_STACK_TOP);
    } catch (error) {
      console.warn("[NEMusic] initial view setup failed", error);
    }
    this.view = created;
    this.viewVisible = false;
    this.client = client;
    this.parentId = id;
    this.owner = win;
    this.loaded = false;
    this.initializationReloaded = false;
    this.recoverySnapshot = snapshot;
    this.restorePending = snapshot;
    this.status = "正在打开网页播放器";
    this.lastBounds = null;
    this.bindPopup(popup, win, created);
    this.viewNeedsReattach = win.document.hidden === true;
    created.on?.("finished-request", url => {
      if (this.view === created) this.onFinishedRequest(url);
    });
    created.on?.("load-error", (code, url, description) => {
      if (this.view === created) this.onLoadError(code, url, description);
    });
    created.on?.("before-close", () => {
      if (this.view === created) this.onViewClosed();
    });
    if (!this.viewNeedsReattach) this.syncView(true, this.render());
    if (this.mode === "expanded") this.focusView();
  }

  private enableViewBridges(): void {
    this.mpris.setEnabled(true);
    this.applyPlaybackBackend();
    this.recognition.setEnabled(true);
    this.fullscreenButton.setEnabled(true);
    this.quality.setEnabled(true);
    this.together.setEnabled(true);
    this.download.setEnabled(true);
    this.applyUiScale();
  }

  private refreshRecoverySnapshot(): void {
    if (!this.loaded || this.view == null || this.restorePending != null || this.recoveryBusy) return;
    if (Date.now() - this.lastRecoveryAt < THROTTLE_REFRESH_MS) return;
    this.lastRecoveryAt = Date.now();
    this.recoveryBusy = true;
    const view = this.view;
    void tryEvaluateInPlayer(PLAYER_RECOVERY_SCRIPT).then(value => {
      const state = value as { snapshot?: PlayerRecoverySnapshot | null } | null;
      if (this.view === view && state?.snapshot) this.recoverySnapshot = state.snapshot;
    }).catch(error => {
      console.warn("[NEMusic] player checkpoint", error);
    }).finally(() => { this.recoveryBusy = false; });
  }

  private bindPopup(popup: SteamPopup | null, win: SteamWindow, view: BrowserView): void {
    this.unbindPopup();
    this.viewPopup = popup;
    this.viewDocument = win.document;
    if (popup?.window !== win || popup.RegisterChildBrowserView == null) return;
    try {
      const registration = popup.RegisterChildBrowserView(view);
      this.unregisterChild = typeof registration?.Unregister === "function" ? () => registration.Unregister() : null;
    } catch (error) {
      console.warn("[NEMusic] register child failed", error);
    }
  }

  private unbindPopup(): void {
    const unregister = this.unregisterChild;
    this.unregisterChild = null;
    this.viewPopup = null;
    this.viewDocument = null;
    if (unregister == null) return;
    try {
      unregister();
    } catch (error) {
      console.warn("[NEMusic] unregister child failed", error);
    }
  }

  private onFinishedRequest = (url: unknown): void => {
    if (this.loaded) return;
    if (typeof url === "string" && url !== "" && !isPlayerDocument(url)) return;
    this.loaded = true;
    const view = this.view;
    this.status = "等待网易云页面初始化";
    void this.restoreView(view);
    this.render();
  };

  private async restoreView(view: BrowserView | null): Promise<void> {
    let pageReady = false;
    try {
      pageReady = await tryEvaluateInPlayer(PLAYER_READY_SCRIPT, { awaitPromise: true }) === true;
      if (this.view !== view) return;
      if (!pageReady) {
        if (!this.initializationReloaded && view != null) {
          this.initializationReloaded = true;
          this.loaded = false;
          this.status = "网易云页面未完成初始化，正在重新加载";
          if (typeof view.Reload === "function") view.Reload();
          else view.LoadURL?.(PLAYER_URL);
          return;
        }
        throw new Error("网易云页面初始化失败，请点击刷新重试");
      }
      this.applyUiScale();
      const snapshot = this.restorePending ?? await tryEvaluateInPlayer(PLAYER_RECOVERY_CHECKPOINT_SCRIPT) as PlayerRecoverySnapshot | null;
      if (this.view !== view) return;
      if (snapshot != null) {
        this.restorePending = snapshot;
        this.recoverySnapshot = snapshot;
        if (this.settings.playbackBackend === "mpv") {
          const muted = await tryEvaluateInPlayer(MPV_MUTE_SCRIPT);
          if (this.view !== view) return;
          if (muted == null) throw new Error("无法静音新网页，未恢复播放以免与 mpv 重叠");
        }
        const restored = await tryEvaluateInPlayer(playerRestoreScript(snapshot), { userGesture: true, awaitPromise: true });
        if (this.view !== view) return;
        if (restored !== true) throw new Error("未能恢复原播放器状态");
        await tryEvaluateInPlayer(PLAYER_RECOVERY_CLEAR_SCRIPT);
        if (this.view !== view) return;
        this.status = "已接回原歌曲、播放队列和进度";
      } else {
        this.status = "网页播放器已加载。登录只保存在 Steam 里";
      }
    } catch (error) {
      if (this.view === view) this.status = `原播放状态恢复失败：${errorText(error)}`;
    } finally {
      if (this.view === view) {
        if (pageReady) {
          this.restorePending = null;
          this.enableViewBridges();
        }
        this.render();
      }
    }
  }

  private onLoadError = (code: unknown, url: unknown, description: unknown): void => {
    console.warn("[NEMusic] load-error", code, url, description);
    if (this.loaded) return;
    if (typeof url === "string" && url !== "" && !isPlayerDocument(url)) return;
    this.status = "页面加载失败，可以点刷新";
    this.render();
  };

  private onViewClosed = (): void => {
    if (this.destroying) return;
    const parentClosed = this.owner?.closed === true && this.booted;
    this.unbindPopup();
    this.view = null;
    if (this.desktopFullscreen || this.windowFullscreen) this.setFullscreen(false);
    this.mpris.setEnabled(false);
    if (!parentClosed) this.stopExternalPlayback();
    this.recognition.setEnabled(false);
    this.fullscreenButton.setEnabled(false);
    this.quality.setEnabled(false);
    this.together.setEnabled(false);
    this.download.setEnabled(false);
    releasePlayerSession();
    this.parentId = null;
    this.client = null;
    this.loaded = false;
    this.pendingOpen = parentClosed;
    if (!parentClosed) this.mode = "closed";
    this.status = parentClosed ? "等待 Steam 桌面窗口恢复，保留原播放状态" : "播放器窗口被关掉了";
    this.forceThrottle(false);
    this.viewVisible = false;
    this.render();
  };

  toggleFromNav(): string {
    return this.open();
  }

  private render(): Bounds | null {
    const bounds = this.chrome.render({
      mode: this.mode,
      status: this.status,
      keepAlive: this.settings.keepAliveWhenCollapsed,
      fullscreen: this.mode === "expanded" && (this.desktopFullscreen || this.windowFullscreen),
    });
    if (bounds != null) this.applyBounds(bounds, false);
    return bounds;
  }

  private applyPlaybackBackend(): void {
    if (this.restorePending != null) return;
    if (this.view != null && this.settings.playbackBackend === "mpv") {
      this.mpris.setExternalPlayback(this.mpv);
      this.mpv.setEnabled(true);
      return;
    }
    this.stopExternalPlayback();
  }

  private applyUiScale(): void {
    void tryEvaluateInPlayer(uiScaleScript(this.settings.uiScale), { awaitPromise: true }).catch(error => {
      console.warn("[NEMusic] UI scale", error);
    });
  }

  /** 播放器没了就得把音频还给页面，并让 MPRIS 回到直接读页面状态。 */
  private stopExternalPlayback(): void {
    this.mpris.setExternalPlayback(null);
    this.mpv.setEnabled(false);
  }

  // 直接复用 render() 已经算好的 bounds：排一次界面要对整个客户端文档做一次遍历，
  // 而 tick 里原本每帧会跑两遍，中间却什么都没变。
  private syncView(force: boolean, bounds: Bounds | null): void {
    const active = this.mode === "expanded" || (this.mode === "collapsed" && this.settings.keepAliveWhenCollapsed);
    if (!active || this.view == null) {
      if (this.mode === "collapsed" && this.view != null) {
        try {
          this.view.SetVisible(false);
          this.viewVisible = false;
          this.view.SetFocus?.(false);
        } catch (error) {
          console.warn("[NEMusic] hide failed", error);
        }
      }
      if (this.mode === "closed") this.forceThrottle(false);
      else this.refreshThrottle();
      return;
    }
    if (bounds != null) this.applyBounds(bounds, force);
    this.refreshThrottle();
  }

  private applyBounds(bounds: Bounds, force: boolean): void {
    if (this.view == null) return;
    if (!force && sameBounds(this.lastBounds, bounds)) {
      // SetVisible 要走客户端的 BrowserView IPC；tick 每秒要跑好几次，所以只在可见性
      // 真的需要翻转时才发。
      if (!this.viewVisible) {
        try {
          this.view.SetVisible(true);
          this.viewVisible = true;
        } catch (error) {
          console.warn("[NEMusic] show failed", error);
        }
      }
      return;
    }
    try {
      this.view.SetWindowStackingOrder?.(BROWSER_VIEW_STACK_TOP);
      this.view.SetBounds(bounds.x, bounds.y, bounds.width, bounds.height);
      this.view.SetVisible(true);
      this.viewVisible = true;
      if (this.mode === "collapsed") this.view.SetFocus?.(false);
      this.lastBounds = bounds;
    } catch (error) {
      console.warn("[NEMusic] SetBounds failed", error);
      this.status = "播放器画面定位失败，可以关掉再打开";
    }
  }

  private focusView(): void {
    try {
      this.owner?.SteamClient?.Browser?.NotifyUserActivation?.();
      sharedSteamClient()?.Browser?.NotifyUserActivation?.();
      this.view?.NotifyUserActivation?.();
      this.view?.SetFocus?.(true);
    } catch (error) {
      console.warn("[NEMusic] focus failed", error);
    }
  }

  /** 普通点击切桌面全屏；Shift+点击只让网易云铺满当前 Steam 窗口。 */
  private setFullscreen = (active: boolean, fillWindow = false): void => {
    const client = this.owner?.SteamClient ?? sharedSteamClient();
    const toggle = client?.Window?.ToggleFullScreen;
    if (!active) {
      const wasDesktopFullscreen = this.desktopFullscreen;
      this.desktopFullscreen = false;
      this.windowFullscreen = false;
      if (wasDesktopFullscreen && typeof toggle === "function") {
        try {
          toggle.call(client?.Window, false);
        } catch (error) {
          console.warn("[NEMusic] exit desktop fullscreen failed", error);
        }
      }
      this.syncView(true, this.render());
      return;
    }
    if (fillWindow) {
      if (this.desktopFullscreen) this.setFullscreen(false);
      this.desktopFullscreen = false;
      this.windowFullscreen = true;
      this.syncView(true, this.render());
      return;
    }
    if (typeof toggle !== "function") {
      this.status = "这版 Steam 不支持桌面全屏";
      this.desktopFullscreen = false;
      this.windowFullscreen = false;
      this.syncView(true, this.render());
      return;
    }
    try {
      this.windowFullscreen = false;
      this.desktopFullscreen = true;
      toggle.call(client.Window, true);
      this.syncView(true, this.render());
    } catch (error) {
      this.desktopFullscreen = false;
      this.windowFullscreen = false;
      this.status = `切换桌面全屏失败：${errorText(error)}`;
    }
  }

  private refreshThrottle(): void {
    if (!this.settings.disableBackgroundThrottling) {
      this.forceThrottle(false);
      return;
    }
    const now = Date.now();
    if (this.throttleForced && now - this.lastThrottleAt < THROTTLE_REFRESH_MS) return;
    this.lastThrottleAt = now;
    this.forceThrottle(true);
  }

  private forceThrottle(disabled: boolean): void {
    if (!disabled && !this.throttleForced) return;
    const main = setBackgroundThrottlingDisabled(this.owner?.SteamClient, disabled);
    const shared = setBackgroundThrottlingDisabled(sharedSteamClient(), disabled);
    const supported = main || shared;
    this.throttlingSupported = supported;
    if (disabled && !supported && !this.loaded) {
      this.status = "这版 Steam 不能关后台节流，最小化后可能播完不切歌";
    }
    this.throttleForced = disabled && supported;
  }

  private destroyView(destroyNative = true): void {
    this.viewEpoch++;
    const view = this.view;
    const client = sharedSteamClient() ?? this.client ?? this.owner?.SteamClient;
    this.destroying = true;
    this.unbindPopup();
    this.view = null;
    this.mpris.setEnabled(false);
    this.recognition.setEnabled(false);
    this.fullscreenButton.setEnabled(false);
    this.quality.setEnabled(false);
    this.together.setEnabled(false);
    this.download.setEnabled(false);
    releasePlayerSession();
    this.parentId = null;
    this.client = null;
    this.loaded = false;
    this.restorePending = null;
    this.lastBounds = null;
    this.viewVisible = false;
    this.viewNeedsReattach = false;
    try {
      if (view == null || !destroyNative) return;
      try {
        view.SetVisible(false);
      } catch {
        /* already gone */
      }
      try {
        client?.BrowserView?.Destroy?.(view);
      } catch (error) {
        console.warn("[NEMusic] destroy failed", error);
      }
    } finally {
      this.destroying = false;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: PlayerController | null = null;

export function getPlayer(steamSettings?: SteamSettingsStatus): PlayerController {
  singleton ??= new PlayerController(steamSettings);
  return singleton;
}

export function shutdownPlayer(): void {
  singleton?.shutdown();
  singleton = null;
}
