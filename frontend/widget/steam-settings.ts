import { findModule } from "millennium";
import type { ReactNode } from "react";
import { sharedSteamClient, steamGlobals, type SteamWindow } from "../player/steam.ts";
import { SETTINGS_ICON } from "./settings-icon.ts";

type MountedPage = { dialog: HTMLElement; button: HTMLElement; dispose: () => void };

const FALLBACK_CLASSES = {
  SettingsModal: "_3few7361SOf4k_YuKCmM62",
  PagedSettingsDialog_PageList: "_18QCu-7MTzd51UpVbYysDy",
  PagedSettingsDialog_PageListItem: "_1-vlriAtKYDViAEunue4VO",
  PageListItem_Icon: "_1rD8X96FdnksZLvRRlEiCR",
  PageListItem_Title: "_2PPbMrzl8PKBwpkjYs9b0i",
  PagedSettingDialog_ContentColumn: "OX7USkJ5dDP_icD00Gal6",
  Active: "_2DpXjzK3WWsOtUWUrcuOG7",
};

export class SteamSettingsEntry {
  private timer = 0;
  private readonly mounted = new Map<Document, MountedPage>();
  private classes = FALLBACK_CLASSES;
  private nativeSeen = false;
  private injected = false;
  private pendingOpen = false;
  private readonly content: () => ReactNode;

  constructor(content: () => ReactNode) {
    this.content = content;
  }

  /** 设置页是来自 Lua 补丁，还是我们自己注入的 DOM。 */
  entryStatus(): "native" | "injected" | "waiting" {
    if (this.nativeSeen) return "native";
    return this.injected ? "injected" : "waiting";
  }

  open(win: SteamWindow): void {
    this.pendingOpen = true;
    const client = win.SteamClient?.URL?.ExecuteSteamURL != null ? win.SteamClient : sharedSteamClient();
    client?.URL?.ExecuteSteamURL?.("steam://open/settings");
    this.sync();
  }

  start(): void {
    if (this.timer) return;
    const layout = findModule(module => typeof module?.PagedSettingsDialog_PageList === "string" && typeof module?.ResponsivePageList === "string")
      ?? findModule(module => typeof module?.PagedSettingsDialog_PageList === "string");
    const settings = findModule(module => typeof module?.SettingsModal === "string");
    this.classes = { ...FALLBACK_CLASSES, ...layout, ...settings };
    // 为了一个用户很少打开的对话框，无休止地 GetPopups() 再对每个 popup 做一次
    // querySelector。
    this.timer = window.setInterval(() => this.sync(), 1000);
    this.sync();
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.pendingOpen = false;
    for (const page of this.mounted.values()) page.dispose();
    this.mounted.clear();
  }

  private selector(key: keyof typeof FALLBACK_CLASSES): string {
    return `.${key}, .${this.classes[key].split(" ")[0]}`;
  }

  private sync(): void {
    for (const [doc, page] of this.mounted) {
      if (!page.dialog.isConnected || !page.button.isConnected || doc.defaultView?.closed) {
        page.dispose();
        this.mounted.delete(doc);
      }
    }
    for (const popup of Array.from(steamGlobals().g_PopupManager?.GetPopups?.() ?? [])) {
      const doc = popup.window?.document;
      if (!doc || popup.window?.closed) continue;
      const mounted = this.mounted.get(doc);
      if (mounted != null) {
        this.selectRequestedPage(mounted.button);
        continue;
      }
      const dialog = doc.querySelector<HTMLElement>(this.selector("SettingsModal"));
      if (!dialog) continue;
      const list = dialog.querySelector<HTMLElement>(this.selector("PagedSettingsDialog_PageList"));
      const column = dialog.querySelector<HTMLElement>(this.selector("PagedSettingDialog_ContentColumn"));
      if (!list || !column) continue;
      if (list.textContent?.includes("网易云音乐")) {
        // Lua 补丁加的设置路由已经在列表里放了一个入口，说明补丁生效了。
        this.nativeSeen = true;
        if (this.pendingOpen) {
          const button = Array.from(list.querySelectorAll<HTMLElement>(this.selector("PagedSettingsDialog_PageListItem")))
            .find(item => item.textContent?.includes("网易云音乐"));
          if (button != null) this.selectRequestedPage(button);
        }
        continue;
      }
      try {
        const page = this.mount(dialog, list, column);
        this.mounted.set(doc, page);
        this.injected = true;
        this.selectRequestedPage(page.button);
      } catch (error) {
        console.warn("[NEMusic] Steam settings entry", error);
      }
    }
  }

  private selectRequestedPage(button: HTMLElement): void {
    if (!this.pendingOpen) return;
    this.pendingOpen = false;
    button.click();
  }

  private mount(dialog: HTMLElement, list: HTMLElement, column: HTMLElement): MountedPage {
    const doc = dialog.ownerDocument;
    const button = doc.createElement("div");
    button.id = "nemusic-settings-entry";
    button.tabIndex = 0;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.setAttribute("aria-controls", "nemusic-settings-page");
    button.className = this.classes.PagedSettingsDialog_PageListItem;
    button.style.flexShrink = "0";
    const icon = doc.createElement("div");
    icon.className = this.classes.PageListItem_Icon;
    icon.innerHTML = SETTINGS_ICON;
    const label = doc.createElement("div");
    label.className = this.classes.PageListItem_Title;
    label.textContent = "网易云音乐";
    button.append(icon, label);
    const page = doc.createElement("section");
    page.id = "nemusic-settings-page";
    page.setAttribute("aria-label", "网易云音乐");
    page.setAttribute("role", "tabpanel");
    page.setAttribute("aria-labelledby", button.id);
    Object.assign(page.style, { position: "absolute", inset: "0", display: "flex", flexDirection: "column", overflow: "hidden", minHeight: "0", minWidth: "0", padding: "24px", boxSizing: "border-box" });
    const title = doc.createElement("h2");
    title.textContent = "网易云音乐";
    Object.assign(title.style, { margin: "0 0 24px", fontSize: "22px", color: "#fff", flexShrink: "0" });
    const content = doc.createElement("div");
    Object.assign(content.style, { display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: "0", minWidth: "0" });
    page.append(title, content);
    let root: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
    const hidden = new Map<HTMLElement, string>();
    const activeClasses = this.classes.Active.split(" ");
    const selected = new Map<HTMLElement, string>();
    const dismiss = () => {
      root?.unmount();
      root = null;
      page.remove();
      for (const [element, display] of hidden) element.style.display = display;
      hidden.clear();
      for (const [element, className] of selected) element.className = className;
      selected.clear();
      button.classList.remove(...activeClasses);
      button.removeAttribute("aria-current");
      button.setAttribute("aria-selected", "false");
    };
    const onNavigate = (event: Event) => {
      if (!event.composedPath().includes(button)) dismiss();
    };
    const onClick = () => {
      if (root) return;
      try {
        for (const element of Array.from(column.children) as HTMLElement[]) {
          hidden.set(element, element.style.display);
          element.style.display = "none";
        }
        for (const element of Array.from(list.querySelectorAll<HTMLElement>(this.selector("Active")))) {
          selected.set(element, element.className);
          element.classList.remove(...activeClasses, "Active");
        }
        button.classList.add(...activeClasses);
        button.setAttribute("aria-current", "page");
        button.setAttribute("aria-selected", "true");
        column.append(page);
        root = window.SP_REACTDOM.createRoot(content);
        root!.render(this.content());
      } catch (error) {
        dismiss();
        console.error("[NEMusic] Steam settings page", error);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      button.click();
    };
    button.addEventListener("click", onClick);
    button.addEventListener("keydown", onKeyDown);
    list.addEventListener("click", onNavigate, true);
    list.append(button);
    return {
      dialog,
      button,
      dispose: () => {
        dismiss();
        list.removeEventListener("click", onNavigate, true);
        button.removeEventListener("click", onClick);
        button.removeEventListener("keydown", onKeyDown);
        button.remove();
      },
    };
  }
}
