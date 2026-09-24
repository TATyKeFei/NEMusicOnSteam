import { findModule } from "millennium";
import type { ReactNode } from "react";
import { steamGlobals } from "./steam.ts";

type MountedPage = { dialog: HTMLElement; button: HTMLButtonElement; dispose: () => void };

const FALLBACK_CLASSES = {
  SettingsModal: "_3few7361SOf4k_YuKCmM62",
  PagedSettingsDialog_PageList: "gNwozyl1BAcDyyhUKvx1Y",
  PagedSettingsDialog_PageListItem: "_2mL2HfT5AkDXRi1YBnRWKa",
  PagedSettingDialog_ContentColumn: "ZjHHXZlnZhCahNrBFplWc",
  Active: "_1ELdDY5kb5jxjXe-FpWBo5",
};

export class SteamSettingsEntry {
  private timer = 0;
  private readonly mounted = new Map<Document, MountedPage>();
  private classes = FALLBACK_CLASSES;

  constructor(private readonly content: () => ReactNode) {}

  start(): void {
    if (this.timer) return;
    const layout = findModule(module => typeof module?.PagedSettingsDialog_PageList === "string");
    const settings = findModule(module => typeof module?.SettingsModal === "string");
    this.classes = { ...FALLBACK_CLASSES, ...layout, ...settings };
    this.timer = window.setInterval(() => this.sync(), 500);
    this.sync();
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
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
      if (!doc || popup.window?.closed || this.mounted.has(doc)) continue;
      const dialog = doc.querySelector<HTMLElement>(this.selector("SettingsModal"));
      if (!dialog) continue;
      const list = dialog.querySelector<HTMLElement>(this.selector("PagedSettingsDialog_PageList"));
      const column = dialog.querySelector<HTMLElement>(this.selector("PagedSettingDialog_ContentColumn"));
      if (!list || !column || list.textContent?.includes("网易云音乐")) continue;
      try {
        this.mounted.set(doc, this.mount(dialog, list, column));
      } catch (error) {
        console.warn("[NEMusic] Steam settings entry", error);
      }
    }
  }

  private mount(dialog: HTMLElement, list: HTMLElement, column: HTMLElement): MountedPage {
    const doc = dialog.ownerDocument;
    const button = doc.createElement("button");
    button.id = "nemusic-settings-entry";
    button.type = "button";
    button.className = this.classes.PagedSettingsDialog_PageListItem;
    button.textContent = "♫　网易云音乐";
    Object.assign(button.style, { width: "100%", border: "0", font: "inherit", textAlign: "left", cursor: "pointer", flexShrink: "0" });
    const page = doc.createElement("section");
    page.id = "nemusic-settings-page";
    page.setAttribute("aria-label", "网易云音乐");
    Object.assign(page.style, { overflowY: "auto", flex: "1", minWidth: "0", padding: "24px", boxSizing: "border-box" });
    const title = doc.createElement("h2");
    title.textContent = "网易云音乐";
    Object.assign(title.style, { margin: "0 0 24px", fontSize: "22px", color: "#fff" });
    const content = doc.createElement("div");
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
        column.append(page);
        root = window.SP_REACTDOM.createRoot(content);
        root!.render(this.content());
      } catch (error) {
        dismiss();
        console.error("[NEMusic] Steam settings page", error);
      }
    };
    button.addEventListener("click", onClick);
    list.addEventListener("click", onNavigate, true);
    list.append(button);
    return {
      dialog,
      button,
      dispose: () => {
        dismiss();
        list.removeEventListener("click", onNavigate, true);
        button.removeEventListener("click", onClick);
        button.remove();
      },
    };
  }
}
