import { ROOT_ID } from "../constants.ts";
import { headerHeightFromButtons, parkedBounds, type Bounds, type ButtonRect } from "./layout.ts";
import { findSupernavRow, headerHeightFromNav, NAV_INACTIVE_ATTR, NAV_INACTIVE_STYLE, NAV_SELECTED_CLASS, navTextItems } from "./nav.ts";
import { LibraryEntry, LIBRARY_ENTRY_FALLBACK_CLASSES, type LibraryEntryClasses } from "./library.ts";

export type PlayerMode = "closed" | "expanded" | "collapsed";

export type ChromeHandlers = {
  onOpen: () => void;
  onSettings: () => void;
  onNavigateAway: () => void;
  onClose: () => void;
};

export type ChromeModel = {
  mode: PlayerMode;
  status: string;
  keepAlive: boolean;
  fullscreen: boolean;
};

type Display = "block" | "none";

const placed = new WeakMap<HTMLElement, { box: string; display: Display }>();

function place(element: HTMLElement, bounds: Bounds, display: Display): void {
  const box = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  const previous = placed.get(element);
  if (previous != null && previous.box === box && previous.display === display) return;
  placed.set(element, { box, display });
  element.style.position = "fixed";
  element.style.left = `${bounds.x}px`;
  element.style.top = `${bounds.y}px`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
  element.style.right = "auto";
  element.style.bottom = "auto";
  element.style.display = display;
}

export class PlayerChrome {
  private readonly library = new LibraryEntry();
  private libraryClasses = LIBRARY_ENTRY_FALLBACK_CLASSES;
  private doc: Document | null = null;
  private root: HTMLDivElement | null = null;
  private page: HTMLDivElement | null = null;
  private slot: HTMLDivElement | null = null;
  private navigationHost: HTMLElement | null = null;
  private selectedNavClass = NAV_SELECTED_CLASS;
  private inactiveNavigation = new Set<HTMLElement>();
  private navigationStyle: HTMLStyleElement | null = null;
  private handlers: ChromeHandlers | null = null;
  private headerHeight: number | null = null;

  mount(doc: Document, handlers: ChromeHandlers, libraryClasses: LibraryEntryClasses = LIBRARY_ENTRY_FALLBACK_CLASSES, selectedNavClass = NAV_SELECTED_CLASS): void {
    this.libraryClasses = libraryClasses;
    this.selectedNavClass = selectedNavClass;
    if (this.doc === doc && this.root?.isConnected) {
      this.handlers = handlers;
      return;
    }
    this.destroy();
    this.doc = doc;
    this.handlers = handlers;
    const navigationStyle = doc.createElement("style");
    navigationStyle.textContent = NAV_INACTIVE_STYLE;
    doc.head.append(navigationStyle);
    this.navigationStyle = navigationStyle;
    const root = doc.createElement("div");
    root.id = ROOT_ID;
    root.style.position = "fixed";
    root.style.left = "0";
    root.style.top = "0";
    root.style.width = "0";
    root.style.height = "0";
    root.style.overflow = "visible";
    root.style.zIndex = "100000";
    root.style.pointerEvents = "none";

    const page = doc.createElement("div");
    page.style.background = "#1b2838";
    page.style.pointerEvents = "auto";

    const slot = doc.createElement("div");
    slot.style.pointerEvents = "none";
    slot.style.visibility = "hidden";

    root.append(page, slot);
    doc.body.append(root);
    this.root = root;
    this.page = page;
    this.slot = slot;
  }

  destroy(): void {
    this.library.destroy();
    this.bindNavigation(null);
    this.navigationStyle?.remove();
    this.navigationStyle = null;
    this.root?.remove();
    this.doc = null;
    this.root = null;
    this.page = null;
    this.slot = null;
    this.headerHeight = null;
  }

  render(model: ChromeModel): Bounds | null {
    const doc = this.doc;
    const page = this.page;
    const slot = this.slot;
    if (doc == null || page == null || slot == null) return null;
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    if (width < 100 || height < 100) return null;

    if (!this.navigationHost?.isConnected) this.bindNavigation(findSupernavRow(doc));
    const nav = this.navigationHost;
    this.library.render(doc, model.mode, this.handlers!, this.libraryClasses);
    const expanded = model.mode === "expanded";
    this.paintNavigation(expanded);
    const parked = model.mode === "collapsed" && model.keepAlive;
    const header = model.fullscreen ? 0 : headerHeightFromNav(nav?.getBoundingClientRect().bottom ?? null, this.headerFallback(doc));
    const pageBox: Bounds = { x: 0, y: header, width, height: Math.max(1, height - header) };
    if (expanded) {
      place(page, pageBox, "block");
      place(slot, pageBox, "block");
    } else {
      place(page, pageBox, "none");
      place(slot, parked ? parkedBounds(width, height) : { x: 0, y: 0, width: 1, height: 1 }, parked ? "block" : "none");
    }

    if (!expanded && !parked) return null;
    const rect = slot.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  private bindNavigation(host: HTMLElement | null): void {
    if (this.navigationHost === host) return;
    this.restoreNavigation();
    this.navigationHost?.removeEventListener("click", this.onNavClick, true);
    this.navigationHost = host;
    this.headerHeight = null;
    host?.addEventListener("click", this.onNavClick, true);
  }

  private onNavClick = (event: MouseEvent): void => {
    const host = this.navigationHost;
    const target = event.target;
    if (host == null || target == null || !navTextItems(host).some(item => item.contains(target as Node))) return;
    this.restoreNavigation();
    this.handlers?.onNavigateAway();
  };

  private paintNavigation(expanded: boolean): void {
    if (!expanded || this.navigationHost == null) {
      this.restoreNavigation();
      return;
    }
    const selectedClasses = this.selectedNavClass.split(/\s+/).filter(Boolean);
    const selectedItems = new Set(navTextItems(this.navigationHost).filter(item => selectedClasses.some(name => item.classList.contains(name))));
    for (const item of this.inactiveNavigation) {
      if (selectedItems.has(item)) continue;
      item.removeAttribute(NAV_INACTIVE_ATTR);
      this.inactiveNavigation.delete(item);
    }
    for (const item of selectedItems) {
      if (item.getAttribute(NAV_INACTIVE_ATTR) !== "1") item.setAttribute(NAV_INACTIVE_ATTR, "1");
      this.inactiveNavigation.add(item);
    }
  }

  private restoreNavigation(): void {
    for (const item of this.inactiveNavigation) item.removeAttribute(NAV_INACTIVE_ATTR);
    this.inactiveNavigation.clear();
  }

  invalidateHeader(): void {
    this.headerHeight = null;
  }

  private headerFallback(doc: Document): number {
    this.headerHeight ??= headerHeightFromButtons(this.topButtons(doc));
    return this.headerHeight;
  }

  private topButtons(doc: Document): ButtonRect[] {
    const rects: ButtonRect[] = [];
    for (const button of Array.from(doc.querySelectorAll("button"))) {
      if (this.root?.contains(button)) continue;
      const rect = button.getBoundingClientRect();
      rects.push({ top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
    }
    return rects;
  }
}
