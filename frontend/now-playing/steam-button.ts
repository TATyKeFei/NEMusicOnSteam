import { findModule, showContextMenu } from "millennium";
import type { ContextMenuInstance } from "millennium";
import type { ReactNode } from "react";
import { findMainPopup } from "../player/steam.ts";
import { SETTINGS_ICON } from "../widget/settings-icon.ts";

export const MUSIC_BUTTON_ID = "nemusic-titlebar-button";
const FALLBACK_CLASSES = {
  TitleBarControls: "_3cykd-VfN_xBxf3Qxriccm",
  AnnouncementsButton: "_5wILZhsLODVwGfcJ0hKmJ",
};

const STYLE = `
#${MUSIC_BUTTON_ID} {
  appearance: none; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto; width: 42px; height: 24px; min-height: 24px; padding: 0 12px; margin: 0 8px 0 0;
  border: 0; border-radius: 2px; background: #df2946; color: #fff; cursor: pointer;
  -webkit-app-region: no-drag; pointer-events: auto;
}
#${MUSIC_BUTTON_ID}:hover, #${MUSIC_BUTTON_ID}[aria-expanded="true"] { background: #f13e5b; }
#${MUSIC_BUTTON_ID}:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
#${MUSIC_BUTTON_ID} svg { width: 18px; height: 18px; flex: 0 0 auto; pointer-events: none; }
`;

/** 独立原生弹窗可以显示在网易云 BrowserView 上方。 */
export class SteamMusicButton {
  private timer = 0;
  private button: HTMLButtonElement | null = null;
  private style: HTMLStyleElement | null = null;
  private popup: ContextMenuInstance | null = null;
  private popupId = 0;
  private classes = FALLBACK_CLASSES;
  private readonly content: (close: () => void, dismissed: () => void) => ReactNode;

  constructor(content: (close: () => void, dismissed: () => void) => ReactNode) {
    this.content = content;
  }

  start(): void {
    if (this.timer) return;
    const classes = findModule(module => typeof module?.AnnouncementsButton === "string" && typeof module?.TitleBarControls === "string");
    this.classes = { ...FALLBACK_CLASSES, ...classes };
    this.timer = window.setInterval(() => this.sync(), 1000);
    this.sync();
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.unmount();
  }

  private selector(key: keyof typeof FALLBACK_CLASSES): string {
    return `.${key}, .${this.classes[key].split(" ")[0]}`;
  }

  private sync(): void {
    const doc = findMainPopup()?.window.document;
    if (this.button?.isConnected && this.button.ownerDocument === doc) {
      const controls = this.button.parentElement!;
      const news = controls.querySelector<HTMLElement>(this.selector("AnnouncementsButton"));
      const anchor = this.newsSlot(controls, news);
      if (anchor && this.button.nextElementSibling !== anchor) controls.insertBefore(this.button, anchor);
      return;
    }
    this.unmount();
    if (!doc) return;
    const controls = doc.querySelector<HTMLElement>(this.selector("TitleBarControls"));
    if (!controls) return;
    const news = controls.querySelector<HTMLElement>(this.selector("AnnouncementsButton"));
    const anchor = this.newsSlot(controls, news);
    const button = doc.createElement("button");
    button.id = MUSIC_BUTTON_ID;
    button.type = "button";
    button.title = "网易云音乐 · 歌曲面板";
    button.setAttribute("aria-label", "网易云音乐：打开歌曲面板");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = SETTINGS_ICON;
    button.addEventListener("click", this.toggle);
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.append(style);
    controls.insertBefore(button, anchor ?? controls.firstChild);
    this.button = button;
    this.style = style;
  }

  private newsSlot(controls: HTMLElement, news: HTMLElement | null): HTMLElement | null {
    let slot = news;
    while (slot?.parentElement && slot.parentElement !== controls) slot = slot.parentElement;
    return slot;
  }

  private toggle = (): void => {
    if (this.popup) { this.close(); return; }
    if (!this.button) return;
    const id = ++this.popupId;
    const dismissed = () => {
      if (id !== this.popupId) return;
      this.popup = null;
      this.button?.setAttribute("aria-expanded", "false");
    };
    this.button.setAttribute("aria-expanded", "true");
    try {
      this.popup = showContextMenu(this.content(() => { if (id === this.popupId) this.close(); }, dismissed), this.button, {
        bForcePopup: true, bPreferPopLeft: true, bOverlapHorizontal: true,
        bPreferPopTop: false, bShiftToFitWindow: true, bRetainOnHide: false,
        strClassName: "nemusic-song-popup", title: "网易云音乐 · 歌曲面板",
      });
    } catch (error) {
      dismissed();
      console.warn("[NEMusic] song panel", error);
    }
  };

  private close(): void {
    const popup = this.popup;
    this.popup = null;
    this.popupId++;
    this.button?.setAttribute("aria-expanded", "false");
    popup?.Hide();
  }

  private unmount(): void {
    this.close();
    this.button?.removeEventListener("click", this.toggle);
    this.button?.remove();
    this.style?.remove();
    this.button = null;
    this.style = null;
  }
}
