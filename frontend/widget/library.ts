import type { PlayerMode } from "./chrome.ts";
import { isHtmlElement } from "./nav.ts";

export const LIBRARY_ENTRY_ID = "nemusic-library-entry";

export type LibraryEntryClasses = {
  container: string;
  bar: string;
  label: string;
  icon: string;
};

export const LIBRARY_ENTRY_FALLBACK_CLASSES: LibraryEntryClasses = {
  container: "_3x1HklzyDs4TEjACrRO2tB",
  bar: "_3pSPluBgf0NeR1kkCLWMhR",
  label: "_3O48LaKWcabKx07xdrt1TH",
  icon: "_1ooROmAgkhoBH_o65yl9dJ",
};

type LibraryHandlers = {
  onOpen: () => void;
  onSettings: () => void;
  onClose: () => void;
};

const LIBRARY_ICON = "<svg viewBox=\"0 0 1024 1024\" aria-hidden=\"true\" fill=\"currentColor\"><path d=\"M627.086668 5.114963c28.132297-7.672445 58.822075-7.672445 86.954372 0 33.24726 7.672445 63.937038 23.017334 89.511853 43.477186 10.229926 7.672445 17.902371 15.344889 23.017334 28.132297 7.672445 17.902371 5.114963 38.362223-5.114963 53.707112-7.672445 12.787408-23.017334 23.017334-40.919704 25.574815-12.787408 2.557482-25.574815 0-38.362223-7.672445-5.114963-2.557482-10.229926-10.229926-17.902371-12.787407-17.902371-10.229926-35.804741-20.459852-56.264593-17.902371-15.344889 0-28.132297 7.672445-35.804742 17.902371-10.229926 10.229926-12.787408 23.017334-10.229926 35.804741 7.672445 25.574815 12.787408 53.707112 20.459853 79.281927 51.14963 2.557482 99.741779 15.344889 143.218965 40.919704 40.919704 25.574815 79.281927 58.822075 109.971705 97.184298 25.574815 33.24726 46.034667 71.609483 56.264593 112.529187 12.787408 43.477186 17.902371 89.511853 12.787408 132.989039-2.557482 38.362223-10.229926 74.166964-23.017334 109.971705-33.24726 84.39689-92.069335 161.121336-171.351261 209.713485-56.264593 35.804741-122.759113 58.822075-189.253633 66.49452-46.034667 5.114963-92.069335 5.114963-138.104002-2.557482-94.626816-15.344889-181.581188-61.379556-250.633189-130.431558-66.49452-66.49452-112.529187-153.448891-132.989039-245.518225-7.672445-69.052001-7.672445-138.104002 7.672445-207.156004 17.902371-81.839409 61.379556-161.121336 117.644149-222.500892 48.592149-51.14963 107.414224-89.511853 171.351262-117.64415 7.672445-2.557482 12.787408-5.114963 20.459852-7.672444 15.344889-2.557482 30.689778 0 43.477186 10.229926 17.902371 12.787408 25.574815 33.24726 23.017334 53.707112-2.557482 20.459852-17.902371 38.362223-35.804741 46.034667-63.937038 25.574815-122.759113 69.052001-163.678818 122.759113C205.102218 373.392302 179.527402 432.214377 171.854958 493.593933c-7.672445 61.379556 0 122.759113 20.459852 181.581188 30.689778 84.39689 94.626816 156.006373 173.908743 196.926077 48.592149 25.574815 102.299261 38.362223 156.006373 38.362223 43.477186 0 89.511853-7.672445 130.431558-23.017334 35.804741-12.787408 71.609483-33.24726 99.741779-58.822074 28.132297-23.017334 51.14963-53.707112 66.494519-84.396891 7.672445-15.344889 17.902371-33.24726 20.459853-51.14963 15.344889-51.14963 17.902371-107.414224 2.557481-158.563854-12.787408-43.477186-38.362223-81.839409-71.609482-109.971706-15.344889-12.787408-30.689778-25.574815-48.592149-35.804741-15.344889-7.672445-30.689778-15.344889-48.592149-17.902371 12.787408 46.034667 23.017334 92.069335 35.804741 135.546521 2.557482 10.229926 5.114963 23.017334 5.114963 33.24726 2.557482 46.034667-15.344889 94.626816-46.034667 130.431557-28.132297 33.24726-69.052001 58.822075-112.529187 66.49452-46.034667 10.229926-97.184298 0-138.104002-25.574815-38.362223-25.574815-66.49452-63.937038-81.839409-104.856743-7.672445-23.017334-12.787408-48.592149-12.787407-74.166964-2.557482-56.264593 12.787408-109.971705 43.477185-156.006373 35.804741-53.707112 94.626816-92.069335 158.563855-109.971705-5.114963-17.902371-10.229926-35.804741-12.787408-53.707112-12.787408-38.362223-10.229926-81.839409 7.672445-115.086668 10.229926-20.459852 23.017334-38.362223 40.919704-51.149631C583.609483 25.574815 604.069335 12.787408 627.086668 5.114963m-148.333928 414.312006c-17.902371 17.902371-28.132297 40.919704-33.24726 63.937038-5.114963 20.459852-5.114963 43.477186 0 66.49452 5.114963 23.017334 17.902371 46.034667 38.362223 61.379556 15.344889 10.229926 35.804741 15.344889 56.264594 10.229926 35.804741-5.114963 63.937038-38.362223 63.937038-74.166964-2.557482-7.672445-2.557482-17.902371-5.114963-25.574815-12.787408-48.592149-25.574815-99.741779-38.362223-148.333928-30.689778 7.672445-58.822075 23.017334-81.839409 46.034667z\"/></svg>";

const STYLE = `
#${LIBRARY_ENTRY_ID} {
  position: relative;
  display: flex;
  flex: 0 0 32px;
  min-height: 32px;
  margin: 4px 6px 6px;
  gap: 4px;
  font: 13px 'Motiva Sans', Arial, Helvetica, sans-serif;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}
#${LIBRARY_ENTRY_ID} button {
  appearance: none;
  box-sizing: border-box;
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background-color: #3e4047;
  color: #dcdedf;
  font: 13px 'Motiva Sans', Arial, Helvetica, sans-serif;
  text-align: left;
  cursor: pointer;
}
#${LIBRARY_ENTRY_ID} button:first-child { flex: 1; overflow: hidden; }
#${LIBRARY_ENTRY_ID} button:hover { background-color: #4a4e57; color: #fff; }
#${LIBRARY_ENTRY_ID} button:focus-visible { outline: 2px solid #1a9fff; outline-offset: -2px; }
#${LIBRARY_ENTRY_ID} button[aria-pressed="true"] { color: #fff; }
#${LIBRARY_ENTRY_ID} .nemusic-library-icon { pointer-events: none; }
#${LIBRARY_ENTRY_ID} .nemusic-library-icon svg {
  inset-inline-start: auto;
  inset-inline-end: 12px;
  top: -40px;
  width: 112px;
  height: 112px;
  color: #9b9b9b;
  opacity: 0.18;
}
#${LIBRARY_ENTRY_ID} .nemusic-library-label {
  position: relative;
  color: inherit;
  margin: 0 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
#${LIBRARY_ENTRY_ID} .nemusic-library-toggle {
  flex: 0 0 32px;
  display: grid;
  grid-template-columns: repeat(2, 9px);
  grid-template-rows: repeat(2, 9px);
  align-content: center;
  justify-content: center;
  gap: 4px;
}
#${LIBRARY_ENTRY_ID} .nemusic-library-toggle span { width: 9px; height: 9px; background: currentColor; }
#${LIBRARY_ENTRY_ID} .nemusic-library-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 20;
  display: none;
  min-width: 160px;
  padding: 8px 0;
  box-sizing: border-box;
  flex-direction: column;
  gap: 0;
  border: 0;
  border-radius: 0;
  background: #3d4450;
  box-shadow: 0 8px 26px 2px rgba(0, 0, 0, 0.2);
}
#${LIBRARY_ENTRY_ID}[data-menu-open="true"] .nemusic-library-menu { display: flex; }
#${LIBRARY_ENTRY_ID} .nemusic-library-menu button {
  flex: 0 0 auto;
  width: 100%;
  height: 35px;
  min-height: 35px;
  padding: 8px 18px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #dcdedf;
  font: inherit;
  line-height: 19px;
  text-align: left;
  cursor: pointer;
}
#${LIBRARY_ENTRY_ID} .nemusic-library-menu button:hover,
#${LIBRARY_ENTRY_ID} .nemusic-library-menu button:focus-visible {
  background: #dcdedf;
  color: #3d4450;
  outline: none;
}
`;

export class LibraryEntry {
  private host: HTMLElement | null = null;
  private doc: Document | null = null;
  private row: HTMLDivElement | null = null;
  private openButton: HTMLButtonElement | null = null;
  private toggleButton: HTMLButtonElement | null = null;
  private menu: HTMLDivElement | null = null;
  private style: HTMLStyleElement | null = null;
  private mode: PlayerMode | null = null;
  private menuOpen = false;
  private handlers: LibraryHandlers | null = null;

  render(doc: Document, mode: PlayerMode, handlers: LibraryHandlers, classes: LibraryEntryClasses): void {
    this.handlers = handlers;
    if (!this.host?.isConnected) {
      this.setMenuOpen(false);
      const host = doc.querySelector(`.${classes.container}`);
      this.host = host != null && isHtmlElement(host) ? host : null;
    }
    if (this.host == null) {
      this.setMenuOpen(false);
      return;
    }
    if (this.row == null) this.create(doc, classes);
    if (this.row!.parentElement !== this.host || this.host.lastElementChild !== this.row) this.host.append(this.row!);
    if (this.mode === mode) return;
    this.mode = mode;
    this.setMenuOpen(false);
    const active = mode === "expanded";
    this.openButton!.setAttribute("aria-pressed", String(active));
    this.openButton!.title = mode === "collapsed" ? "网易云正在后台，点击展开" : "打开网易云音乐";
  }

  destroy(): void {
    this.setMenuOpen(false);
    this.row?.remove();
    this.style?.remove();
    this.host = null;
    this.doc = null;
    this.row = null;
    this.openButton = null;
    this.toggleButton = null;
    this.menu = null;
    this.style = null;
    this.handlers = null;
    this.mode = null;
    this.menuOpen = false;
  }

  private create(doc: Document, classes: LibraryEntryClasses): void {
    this.doc = doc;
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.append(style);
    this.style = style;

    const row = doc.createElement("div");
    row.id = LIBRARY_ENTRY_ID;
    row.addEventListener("click", event => event.stopPropagation());
    row.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!this.toggleButton?.contains(event.target as Node) && !this.menu?.contains(event.target as Node)) return;
      event.preventDefault();
      const wasOpen = this.menuOpen;
      this.setMenuOpen(true);
      const items = Array.from(this.menu!.children) as HTMLButtonElement[];
      const current = items.indexOf(doc.activeElement as HTMLButtonElement);
      const index = !wasOpen || current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
        : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[index].focus();
    });
    row.addEventListener("keyup", event => event.stopPropagation());

    const open = doc.createElement("button");
    open.type = "button";
    open.className = classes.bar;
    open.setAttribute("aria-label", "网易云音乐");
    const decoration = doc.createElement("div");
    decoration.className = `${classes.icon} nemusic-library-icon`;
    decoration.setAttribute("aria-hidden", "true");
    decoration.innerHTML = LIBRARY_ICON;
    open.append(decoration);
    const label = doc.createElement("span");
    label.className = `${classes.label} nemusic-library-label`;
    label.textContent = "网易云音乐";
    open.append(label);
    open.addEventListener("click", () => {
      this.setMenuOpen(false);
      this.handlers?.onOpen();
    });

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", `${LIBRARY_ENTRY_ID}-menu`);
    toggle.setAttribute("aria-label", "展开菜单");
    toggle.title = "展开菜单";
    toggle.className = "nemusic-library-toggle";
    for (let index = 0; index < 4; index += 1) {
      const square = doc.createElement("span");
      square.setAttribute("aria-hidden", "true");
      toggle.append(square);
    }
    toggle.addEventListener("click", () => this.setMenuOpen(!this.menuOpen));

    const menu = doc.createElement("div");
    menu.id = `${LIBRARY_ENTRY_ID}-menu`;
    menu.className = "nemusic-library-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "网易云音乐菜单");
    const settings = doc.createElement("button");
    settings.type = "button";
    settings.setAttribute("role", "menuitem");
    settings.textContent = "设置";
    settings.addEventListener("click", () => {
      this.setMenuOpen(false);
      this.handlers?.onSettings();
    });
    const close = doc.createElement("button");
    close.type = "button";
    close.setAttribute("role", "menuitem");
    close.textContent = "关闭";
    close.addEventListener("click", () => {
      this.setMenuOpen(false);
      this.handlers?.onClose();
    });
    menu.append(settings, close);
    row.append(open, toggle, menu);
    this.row = row;
    this.openButton = open;
    this.toggleButton = toggle;
    this.menu = menu;
    this.setMenuOpen(false);
  }

  private setMenuOpen(open: boolean): void {
    if (this.row == null || this.toggleButton == null) return;
    this.menuOpen = open;
    this.row.setAttribute("data-menu-open", String(open));
    this.toggleButton.setAttribute("aria-expanded", String(open));
    this.toggleButton.setAttribute("aria-label", open ? "收起菜单" : "展开菜单");
    this.toggleButton.title = open ? "收起菜单" : "展开菜单";
    if (open) {
      this.doc?.addEventListener("pointerdown", this.onOutsidePointer, true);
      this.doc?.addEventListener("keydown", this.onMenuKey, true);
    } else {
      this.doc?.removeEventListener("pointerdown", this.onOutsidePointer, true);
      this.doc?.removeEventListener("keydown", this.onMenuKey, true);
    }
  }

  private onOutsidePointer = (event: PointerEvent): void => {
    if (this.row?.contains(event.target as Node)) return;
    this.setMenuOpen(false);
  };

  private onMenuKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" && event.key !== "Tab") return;
    const focusInMenu = this.menu?.contains(this.doc?.activeElement ?? null) === true;
    this.setMenuOpen(false);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.toggleButton?.focus();
    } else if (focusInMenu) {
      this.toggleButton?.focus();
    }
  };
}
