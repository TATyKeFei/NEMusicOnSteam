import { PlayerChrome, type PlayerMode } from "./chrome.ts";
import { isPlayerDocument, PLAYER_URL, PLAYER_USER_AGENT } from "./constants.ts";
import { sameBounds, type Bounds } from "./layout.ts";
import { MprisBridge } from "./mpris.ts";
import { QualityBridge, type QualitySnapshot } from "./quality.ts";
import { browserStorage, readSettings, writeSettings, type PlayerSettings } from "./settings.ts";
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

export type PlayerSnapshot = {
  mode: PlayerMode;
  status: string;
  hasView: boolean;
  throttlingSupported: boolean | null;
  mprisStatus: string;
  quality: QualitySnapshot;
  settings: PlayerSettings;
};

export class PlayerController {
  private readonly chrome = new PlayerChrome();
  private readonly mpris = new MprisBridge(() => { this.open(); }, () => { this.close(); });
  private readonly quality = new QualityBridge();
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
  private throttleForced = false;
  private throttlingSupported: boolean | null = null;
  private lastBounds: Bounds | null = null;
  private lastThrottleAt = 0;
  private timer = 0;
  private resizeTarget: Window | null = null;
  private unregisterChild: (() => void) | null = null;
  private destroying = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    this.settings = readSettings(browserStorage());
    this.pendingOpen = this.settings.openOnStart;
    this.timer = window.setInterval(this.tick, TICK_MS);
    this.mpris.start();
    this.tick();
  }

  shutdown(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.unbindResize();
    this.pendingOpen = false;
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
      quality: this.quality.snapshot(),
      settings: { ...this.settings, launcher: { ...this.settings.launcher } },
    };
  }

  updateSettings(patch: Partial<PlayerSettings>): PlayerSettings {
    this.settings = { ...this.settings, ...patch, launcher: patch.launcher ?? this.settings.launcher };
    writeSettings(browserStorage(), this.settings);
    this.render();
    this.syncView(true);
    return this.snapshot().settings;
  }

  setQuality(value: number): void {
    this.quality.setQuality(value);
  }

  open(): string {
    this.boot();
    this.pendingOpen = true;
    const popup = findMainPopup();
    if (popup == null) {
      this.status = "Steam 主窗口还没准备好，出来之后会自动打开";
      return this.status;
    }
    return this.openOn(popup.window);
  }

  collapse(): string {
    if (this.view == null && this.mode === "closed") return this.status;
    this.pendingOpen = false;
    this.mode = "collapsed";
    this.status = this.settings.keepAliveWhenCollapsed ? "已收起，播放器仍在后台" : "已收起。这种收起会把页面藏起来，切歌可能停";
    this.render();
    this.syncView(true);
    return this.status;
  }

  close(): string {
    this.pendingOpen = false;
    this.mode = "closed";
    this.status = "已关闭";
    this.destroyView();
    this.forceThrottle(false);
    this.render();
    return this.status;
  }

  reload(): string {
    if (this.view == null) return this.open();
    this.loaded = false;
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
    const alreadyShowing = this.mode === "expanded" && this.loaded && this.view != null && this.owner === win;
    this.mode = "expanded";
    if (!alreadyShowing) this.status = "正在打开网页播放器";
    try {
      this.ensureChrome(win);
      this.ensureView(win, findMainPopup());
      this.render();
      this.syncView(true);
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
      if (popup != null) this.ensureChrome(popup.window);
      if (this.pendingOpen && popup != null) {
        this.openOn(popup.window);
        return;
      }
      if (this.mode !== "closed" && popup != null && (this.view == null || this.owner !== popup.window)) {
        this.ensureView(popup.window, popup);
      }
      this.render();
      this.syncView(false);
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
      onToolbarChange: () => this.syncView(false),
      onCollapse: () => this.collapse(),
      onReload: () => this.reload(),
      onClose: () => this.close(),
    });
    if (this.resizeTarget !== win) {
      this.unbindResize();
      this.resizeTarget = win;
      win.addEventListener("resize", this.onResize);
    }
  }

  private unbindResize(): void {
    this.resizeTarget?.removeEventListener("resize", this.onResize);
    this.resizeTarget = null;
  }

  private onResize = (): void => {
    this.render();
    this.syncView(false);
  };

  private ensureView(win: SteamWindow, popup: SteamPopup | null): void {
    const client = win.SteamClient?.BrowserView?.Create != null ? win.SteamClient : sharedSteamClient();
    const id = browserId(win.SteamClient) ?? browserId(client);
    if (client?.BrowserView?.Create == null || id == null) {
      throw new Error("这个 Steam 没有可用的 BrowserView，嵌不进去");
    }
    if (this.view != null && this.parentId === id && this.owner === win) return;
    this.destroyView();
    const created = client.BrowserView.Create({
      parentPopupBrowserID: id,
      strInitialURL: PLAYER_URL,
      strName: `${VIEW_NAME}-${nextViewId++}`,
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
    this.mpris.setEnabled(true);
    this.quality.setEnabled(true);
    this.client = client;
    this.parentId = id;
    this.owner = win;
    this.loaded = false;
    this.lastBounds = null;
    this.bindPopup(popup, win, created);
    created.on?.("finished-request", this.onFinishedRequest);
    created.on?.("load-error", this.onLoadError);
    created.on?.("before-close", this.onViewClosed);
  }

  private bindPopup(popup: SteamPopup | null, win: SteamWindow, view: BrowserView): void {
    this.unbindPopup();
    if (popup?.window !== win || popup.RegisterChildBrowserView == null) return;
    try {
      const registration = popup.RegisterChildBrowserView(view);
      this.unregisterChild = typeof registration?.Unregister === "function" ? registration.Unregister : null;
    } catch (error) {
      console.warn("[NEMusic] register child failed", error);
    }
  }

  private unbindPopup(): void {
    const unregister = this.unregisterChild;
    this.unregisterChild = null;
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
    this.status = "网页播放器已加载。登录只保存在 Steam 里";
    this.render();
  };

  private onLoadError = (code: unknown, url: unknown, description: unknown): void => {
    console.warn("[NEMusic] load-error", code, url, description);
    if (this.loaded) return;
    if (typeof url === "string" && url !== "" && !isPlayerDocument(url)) return;
    this.status = "页面加载失败，可以点刷新";
    this.render();
  };

  private onViewClosed = (): void => {
    if (this.destroying) return;
    this.unbindPopup();
    this.view = null;
    this.mpris.setEnabled(false);
    this.quality.setEnabled(false);
    this.parentId = null;
    this.client = null;
    this.loaded = false;
    this.mode = "closed";
    this.status = "播放器窗口被关掉了";
    this.forceThrottle(false);
    this.render();
  };

  toggleFromNav(): string {
    return this.open();
  }

  private render(): void {
    const bounds = this.chrome.render({
      mode: this.mode,
      status: this.status,
      keepAlive: this.settings.keepAliveWhenCollapsed,
    });
    if (bounds != null) this.applyBounds(bounds, false);
  }

  private syncView(force: boolean): void {
    const active = this.mode === "expanded" || (this.mode === "collapsed" && this.settings.keepAliveWhenCollapsed);
    if (!active || this.view == null) {
      if (this.mode === "collapsed" && this.view != null) {
        try {
          this.view.SetVisible(false);
          this.view.SetFocus?.(false);
        } catch (error) {
          console.warn("[NEMusic] hide failed", error);
        }
      }
      if (this.mode === "closed") this.forceThrottle(false);
      else this.refreshThrottle();
      return;
    }
    const bounds = this.chrome.render({
      mode: this.mode,
      status: this.status,
      keepAlive: this.settings.keepAliveWhenCollapsed,
    });
    if (bounds != null) this.applyBounds(bounds, force);
    this.refreshThrottle();
  }

  private applyBounds(bounds: Bounds, force: boolean): void {
    if (this.view == null) return;
    if (!force && sameBounds(this.lastBounds, bounds)) {
      try {
        this.view.SetVisible(true);
      } catch (error) {
        console.warn("[NEMusic] show failed", error);
      }
      return;
    }
    try {
      this.view.SetWindowStackingOrder?.(BROWSER_VIEW_STACK_TOP);
      this.view.SetBounds(bounds.x, bounds.y, bounds.width, bounds.height);
      this.view.SetVisible(true);
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

  private destroyView(): void {
    const view = this.view;
    const client = this.client ?? this.owner?.SteamClient ?? sharedSteamClient();
    this.destroying = true;
    this.unbindPopup();
    this.view = null;
    this.mpris.setEnabled(false);
    this.quality.setEnabled(false);
    this.parentId = null;
    this.client = null;
    this.loaded = false;
    this.lastBounds = null;
    try {
      if (view == null) return;
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

export function getPlayer(): PlayerController {
  singleton ??= new PlayerController();
  return singleton;
}

export function shutdownPlayer(): void {
  singleton?.shutdown();
  singleton = null;
}
