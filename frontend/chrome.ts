import { ROOT_ID } from "./constants.ts";
import { headerHeightFromButtons, parkedBounds, type Bounds, type ButtonRect } from "./layout.ts";
import { findSupernavRow, headerHeightFromNav, isHtmlElement, NAV_LINK_ID, NAV_MODE_ATTR, navTextItems, sharedClasses } from "./nav.ts";

export type PlayerMode = "closed" | "expanded" | "collapsed";

export type ChromeHandlers = {
  onOpen: () => void;
  onNavigateAway: () => void;
  onToolbarChange: () => void;
  onCollapse: () => void;
  onReload: () => void;
  onClose: () => void;
};

export type ChromeModel = {
  mode: PlayerMode;
  status: string;
  keepAlive: boolean;
};

function buttonStyle(button: HTMLButtonElement): void {
  button.type = "button";
  button.style.appearance = "none";
  button.style.margin = "0";
  button.style.border = "0";
  button.style.background = "transparent";
  button.style.height = "100%";
  button.style.flex = "1";
  button.style.padding = "0 8px";
  button.style.textAlign = "center";
  button.style.cursor = "pointer";
  button.style.userSelect = "none";
  button.style.pointerEvents = "auto";
}

function place(element: HTMLElement, bounds: Bounds, hidden: boolean): void {
  element.style.position = "fixed";
  element.style.left = `${bounds.x}px`;
  element.style.top = `${bounds.y}px`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
  element.style.right = "auto";
  element.style.bottom = "auto";
  element.style.display = hidden ? "none" : "block";
}

function linkTitle(mode: PlayerMode): string {
  if (mode === "expanded") return "网易云音乐";
  if (mode === "collapsed") return "网易云正在后台，点击展开";
  return "打开网易云音乐";
}

export class PlayerChrome {
  private doc: Document | null = null;
  private root: HTMLDivElement | null = null;
  private page: HTMLDivElement | null = null;
  private slot: HTMLDivElement | null = null;
  private bar: HTMLDivElement | null = null;
  private toolbarTrigger: HTMLElement | null = null;
  private toolbarOpen = false;
  private toolbarTimer = 0;
  private deselected = new Map<HTMLElement, string[]>();
  private link: HTMLDivElement | null = null;
  private linkLabel: HTMLElement | null = null;
  private linkMark: HTMLElement | null = null;
  private navHost: HTMLElement | null = null;
  private navObserver: MutationObserver | null = null;
  private navigationHost: HTMLElement | null = null;
  private handlers: ChromeHandlers | null = null;

  mountedDocument(): Document | null {
    return this.doc;
  }

  mount(doc: Document, handlers: ChromeHandlers): void {
    if (this.doc === doc && this.root?.isConnected) {
      this.handlers = handlers;
      return;
    }
    this.destroy();
    this.doc = doc;
    this.handlers = handlers;
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

    const bar = doc.createElement("div");
    bar.style.display = "none";
    bar.style.boxSizing = "border-box";
    bar.style.background = "#3d4450";
    bar.style.color = "#ffffff";
    bar.style.font = "14px/17px 'Motiva Sans', Arial, Helvetica, sans-serif";
    bar.style.fontWeight = "400";
    bar.style.flexDirection = "column";
    bar.style.padding = "4px 0";
    bar.style.zIndex = "100001";
    bar.style.pointerEvents = "auto";
    bar.style.userSelect = "none";

    const collapse = this.commandButton(doc, "收起", () => this.handlers?.onCollapse());
    const reload = this.commandButton(doc, "刷新", () => this.handlers?.onReload());
    const close = this.commandButton(doc, "关闭", () => this.handlers?.onClose());
    bar.append(collapse, reload, close);
    bar.addEventListener("mouseenter", this.openToolbar);
    bar.addEventListener("mouseleave", this.scheduleToolbarClose);

    root.append(page, slot, bar);
    doc.body.append(root);
    this.root = root;
    this.page = page;
    this.slot = slot;
    this.bar = bar;
  }

  destroy(): void {
    const doc = this.doc;
    if (doc != null) doc.documentElement.removeAttribute(NAV_MODE_ATTR);
    this.restoreSelection();
    this.bindToolbar(null);
    this.clearToolbarTimer();
    this.toolbarOpen = false;
    this.bindNavigation(null);
    this.removeFallback();
    this.root?.remove();
    this.doc = null;
    this.root = null;
    this.page = null;
    this.slot = null;
    this.bar = null;
  }

  render(model: ChromeModel): Bounds | null {
    const doc = this.doc;
    const page = this.page;
    const slot = this.slot;
    const bar = this.bar;
    if (doc == null || page == null || slot == null || bar == null) return null;
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    if (width < 100 || height < 100) return null;

    this.publishMode(doc, model.mode);
    const nav = this.ensureNavLink(doc);
    this.bindNavigation(nav);
    const navLink = doc.querySelector(`#${NAV_LINK_ID}`);
    const toolbarLink = navLink != null && isHtmlElement(navLink) ? navLink : null;
    this.bindToolbar(toolbarLink);
    this.styleToolbar(nav);
    this.paintSelection(nav, model.mode === "expanded");
    this.paintNavLink(model);
    const expanded = model.mode === "expanded";
    const parked = model.mode === "collapsed" && model.keepAlive;
    const header = headerHeightFromNav(nav?.getBoundingClientRect().bottom ?? null, headerHeightFromButtons(this.topButtons(doc)));
    if (expanded) {
      place(page, { x: 0, y: header, width, height: Math.max(1, height - header) }, false);
      if (this.toolbarOpen) {
        const linkRect = this.toolbarTrigger?.getBoundingClientRect();
        const barWidth = 180;
        place(bar, {
          x: Math.max(0, Math.min(width - barWidth, Math.round(linkRect?.left ?? width - barWidth))),
          y: Math.round(linkRect?.bottom ?? header),
          width: barWidth,
          height: 104,
        }, false);
        bar.style.display = "flex";
      } else bar.style.display = "none";
      place(slot, { x: 0, y: header, width, height: Math.max(1, height - header) }, false);
    } else {
      this.toolbarOpen = false;
      page.style.display = "none";
      bar.style.display = "none";
      place(slot, parked ? parkedBounds(width, height) : { x: 0, y: 0, width: 1, height: 1 }, !parked);
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

  private publishMode(doc: Document, mode: PlayerMode): void {
    const root = doc.documentElement;
    const visibleMode = mode === "collapsed" ? "closed" : mode;
    if (root.getAttribute(NAV_MODE_ATTR) !== visibleMode) root.setAttribute(NAV_MODE_ATTR, visibleMode);
  }

  private bindNavigation(host: HTMLElement | null): void {
    if (this.navigationHost === host) return;
    this.navigationHost?.removeEventListener("click", this.onNavClick, true);
    this.navigationHost = host;
    host?.addEventListener("click", this.onNavClick, true);
  }

  private onNavClick = (event: MouseEvent): void => {
    const host = this.navigationHost;
    const target = event.target;
    if (host == null || target == null || !navTextItems(host).some((item) => item.contains(target as Node))) return;
    this.handlers?.onNavigateAway();
  };

  private bindToolbar(trigger: Element | null): void {
    const next = trigger != null && isHtmlElement(trigger) ? trigger : null;
    if (this.toolbarTrigger === next) return;
    this.toolbarTrigger?.removeEventListener("mouseenter", this.openToolbar);
    this.toolbarTrigger?.removeEventListener("mouseleave", this.scheduleToolbarClose);
    this.toolbarTrigger = next;
    next?.addEventListener("mouseenter", this.openToolbar);
    next?.addEventListener("mouseleave", this.scheduleToolbarClose);
  }

  private clearToolbarTimer(): void {
    this.doc?.defaultView?.clearTimeout(this.toolbarTimer);
    this.toolbarTimer = 0;
  }

  private openToolbar = (): void => {
    this.clearToolbarTimer();
    if (this.doc?.documentElement.getAttribute(NAV_MODE_ATTR) !== "expanded" || this.toolbarOpen) return;
    this.toolbarOpen = true;
    this.handlers?.onToolbarChange();
  };

  private styleToolbar(host: HTMLElement | null): void {
    if (this.bar == null) return;
    for (const button of Array.from(this.bar.querySelectorAll("button"))) {
      button.className = "";
      button.style.display = "block";
      button.style.flex = "1 1 0";
      button.style.width = "100%";
      button.style.height = "32px";
      button.style.padding = "0 14px";
      button.style.color = "#dcdedf";
      button.style.font = "14px/32px 'Motiva Sans', Arial, Helvetica, sans-serif";
      button.style.textAlign = "left";
      button.style.background = "transparent";
      button.addEventListener("mouseenter", () => { button.style.background = "#23262e"; button.style.color = "#ffffff"; });
      button.addEventListener("mouseleave", () => { button.style.background = "transparent"; button.style.color = "#dcdedf"; });
    }
  }

  private scheduleToolbarClose = (): void => {
    this.clearToolbarTimer();
    this.toolbarTimer = this.doc?.defaultView?.setTimeout(() => {
      this.toolbarOpen = false;
      this.handlers?.onToolbarChange();
    }, 120) ?? 0;
  };

  private restoreSelection(): void {
    for (const [item, classes] of this.deselected) item.classList.add(...classes);
    this.deselected.clear();
  }

  private paintSelection(host: HTMLElement | null, expanded: boolean): void {
    if (!expanded || host == null) {
      this.restoreSelection();
      return;
    }
    const items = navTextItems(host);
    const nativeItem = this.doc?.querySelector(`#${NAV_LINK_ID} > div`);
    const link = this.toolbarTrigger ?? (nativeItem != null && isHtmlElement(nativeItem) ? nativeItem : null);
    const selectedClasses = link == null ? [] : [...link.classList].filter((name) => items.some((item) => item.classList.contains(name)));
    const commonClasses = sharedClasses(items.map((item) => item.className)).split(/\s+/);
    let selected = selectedClasses.filter((name) => !commonClasses.includes(name));
    if (selected.length === 0 && link?.dataset.nemusicFallback === "1") {
      const isBlue = (item: HTMLElement): boolean => {
        const color = item.ownerDocument.defaultView?.getComputedStyle(item.firstElementChild ?? item).color ?? "";
        const channels = color.match(/\d+/g)?.map(Number) ?? [];
        return channels.length >= 3 && channels[2] > channels[1] * 1.2 && channels[1] > channels[0] * 1.3;
      };
      const activeItem = items.find(isBlue);
      if (activeItem != null) {
        for (const name of [...activeItem.classList].filter((value) => !commonClasses.includes(value))) {
          activeItem.classList.remove(name);
          const changesColor = !isBlue(activeItem);
          activeItem.classList.add(name);
          if (changesColor) selected = [name];
        }
      }
    }
    for (const item of items) {
      const removed = selected.filter((name) => item.classList.contains(name));
      if (removed.length === 0) continue;
      item.classList.remove(...removed);
      this.deselected.set(item, removed);
    }
  }

  private nativeNavLink(doc: Document): HTMLElement | null {
    for (const node of Array.from(doc.querySelectorAll(`#${NAV_LINK_ID}`))) {
      if (isHtmlElement(node) && node.dataset.nemusicFallback !== "1") return node;
    }
    return null;
  }

  private removeFallback(): void {
    this.navObserver?.disconnect();
    this.navObserver = null;
    this.link?.remove();
    this.link = null;
    this.linkLabel = null;
    this.linkMark = null;
    this.navHost = null;
  }

  private ensureNavLink(doc: Document): HTMLElement | null {
    const native = this.nativeNavLink(doc);
    if (native != null) {
      this.removeFallback();
      return native.parentElement ?? native;
    }
    const found = findSupernavRow(doc);
    const host = found ?? (this.navHost?.isConnected ? this.navHost : null);
    if (host == null) return null;
    if (this.link == null || !this.link.isConnected) this.createNavLink(doc, host);
    else if (this.link.parentElement !== host) host.append(this.link);
    this.watchNavHost(host);
    return host;
  }

  private createNavLink(doc: Document, host: HTMLElement): void {
    this.link?.remove();
    const samples = navTextItems(host);
    const sampleLabels = samples.map((item) => item.querySelector("div")).filter((item): item is HTMLDivElement => item?.tagName === "DIV");
    const link = doc.createElement("div");
    link.id = NAV_LINK_ID;
    link.dataset.nemusicFallback = "1";
    link.className = sharedClasses(samples.map((item) => item.className));
    link.role = "button";
    link.tabIndex = 0;
    link.style.marginLeft = "auto";
    link.style.flex = "0 0 auto";
    link.style.position = "relative";
    link.style.cursor = "pointer";
    link.style.userSelect = "none";
    link.style.pointerEvents = "auto";
    link.style.setProperty("-webkit-app-region", "no-drag");
    if (samples.length === 0) {
      link.style.height = "100%";
      link.style.display = "flex";
      link.style.alignItems = "center";
      link.style.padding = "0 10px";
      link.style.font = "500 18px/32px 'Motiva Sans', 'Noto Sans', Helvetica, sans-serif";
      link.style.color = "#dcdedf";
    }

    const label = doc.createElement("div");
    const labelClass = sharedClasses(sampleLabels.map((item) => item.className));
    if (labelClass !== "") label.className = labelClass;
    label.textContent = "网易云";
    const mark = doc.createElement("span");
    mark.style.position = "absolute";
    mark.style.left = "10px";
    mark.style.right = "10px";
    mark.style.bottom = "0";
    mark.style.height = "3px";
    mark.style.borderRadius = "3px";
    mark.style.background = "#1a9fff";
    mark.style.display = "none";
    link.append(label, mark);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers?.onOpen();
    });
    link.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      this.handlers?.onOpen();
    });
    host.append(link);
    this.link = link;
    this.linkLabel = label;
    this.linkMark = mark;
  }

  private watchNavHost(host: HTMLElement): void {
    if (this.navHost === host && this.navObserver != null) return;
    this.navObserver?.disconnect();
    this.navHost = host;
    this.navObserver = new MutationObserver(() => {
      if (this.nativeNavLink(host.ownerDocument) != null) {
        this.removeFallback();
        return;
      }
      const link = this.link;
      if (link != null && link.parentElement !== host) host.append(link);
    });
    this.navObserver.observe(host, { childList: true });
  }

  private paintNavLink(model: ChromeModel): void {
    const label = this.linkLabel;
    const link = this.link;
    const mark = this.linkMark;
    if (label == null || link == null || mark == null) return;
    const active = model.mode === "expanded";
    const title = linkTitle(model.mode);
    link.title = title;
    link.setAttribute("aria-label", title);
    link.setAttribute("aria-pressed", active ? "true" : "false");
    label.textContent = "网易云";
    label.style.color = active ? "#1a9fff" : "";
    label.style.textShadow = active ? "0 0 1px #1a9fff" : "";
    mark.style.display = active ? "block" : "none";
  }

  private commandButton(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
    const button = doc.createElement("button");
    const text = doc.createElement("div");
    text.textContent = label;
    button.append(text);
    buttonStyle(button);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
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
