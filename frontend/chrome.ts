import { ROOT_ID } from "./constants.ts";
import { barBounds, expandedBounds, headerHeightFromButtons, parkedBounds, type Bounds, type ButtonRect } from "./layout.ts";
import { clampLauncher, type LauncherPosition } from "./settings.ts";

export type PlayerMode = "closed" | "expanded" | "collapsed";

export type ChromeHandlers = {
  onOpen: () => void;
  onCollapse: () => void;
  onReload: () => void;
  onClose: () => void;
  onMove: (position: LauncherPosition) => void;
};

export type ChromeModel = {
  mode: PlayerMode;
  status: string;
  launcherText: string;
  launcher: LauncherPosition;
  keepAlive: boolean;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  moved: boolean;
};

const DRAG_THRESHOLD = 4;

function buttonStyle(button: HTMLButtonElement, filled: boolean): void {
  button.type = "button";
  button.style.appearance = "none";
  button.style.margin = "0";
  button.style.border = filled ? "1px solid rgba(230, 0, 38, 0.85)" : "1px solid rgba(255, 255, 255, 0.16)";
  button.style.background = filled ? "#c40d2e" : "#2a475e";
  button.style.color = "#ffffff";
  button.style.borderRadius = filled ? "999px" : "2px";
  button.style.font = "12px/24px 'Motiva Sans', Arial, Helvetica, sans-serif";
  button.style.height = filled ? "32px" : "24px";
  button.style.padding = filled ? "0 14px" : "0 10px";
  button.style.cursor = "pointer";
  button.style.userSelect = "none";
  button.style.pointerEvents = "auto";
  button.style.boxShadow = filled ? "0 8px 24px rgba(0, 0, 0, 0.35)" : "none";
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

export class PlayerChrome {
  private doc: Document | null = null;
  private root: HTMLDivElement | null = null;
  private slot: HTMLDivElement | null = null;
  private bar: HTMLDivElement | null = null;
  private statusNode: HTMLSpanElement | null = null;
  private launcher: HTMLButtonElement | null = null;
  private drag: DragState | null = null;
  private suppressClick = false;
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

    const slot = doc.createElement("div");
    slot.style.pointerEvents = "none";
    slot.style.visibility = "hidden";

    const bar = doc.createElement("div");
    bar.style.display = "none";
    bar.style.boxSizing = "border-box";
    bar.style.alignItems = "center";
    bar.style.gap = "8px";
    bar.style.padding = "0 10px";
    bar.style.background = "#171a21";
    bar.style.color = "#ffffff";
    bar.style.borderBottom = "1px solid rgba(255, 255, 255, 0.08)";
    bar.style.font = "12px/36px 'Motiva Sans', Arial, Helvetica, sans-serif";
    bar.style.pointerEvents = "auto";
    bar.style.userSelect = "none";

    const title = doc.createElement("span");
    title.textContent = "网易云音乐";
    title.style.fontWeight = "600";
    const host = doc.createElement("span");
    host.textContent = "music.163.com";
    host.style.opacity = "0.55";
    const status = doc.createElement("span");
    status.style.flex = "1";
    status.style.minWidth = "0";
    status.style.overflow = "hidden";
    status.style.whiteSpace = "nowrap";
    status.style.textOverflow = "ellipsis";
    status.style.opacity = "0.8";

    const collapse = this.commandButton(doc, "收起", () => this.handlers?.onCollapse());
    const reload = this.commandButton(doc, "刷新", () => this.handlers?.onReload());
    const close = this.commandButton(doc, "关闭", () => this.handlers?.onClose());
    bar.append(title, host, status, collapse, reload, close);

    const launcher = doc.createElement("button");
    launcher.textContent = "网易云";
    launcher.title = "打开网易云音乐。按住可以拖位置。";
    launcher.setAttribute("aria-label", "打开网易云音乐");
    buttonStyle(launcher, true);
    launcher.style.position = "fixed";
    launcher.style.zIndex = "1";
    launcher.addEventListener("pointerdown", this.onPointerDown);
    launcher.addEventListener("pointermove", this.onPointerMove);
    launcher.addEventListener("pointerup", this.onPointerUp);
    launcher.addEventListener("pointercancel", this.onPointerCancel);
    launcher.addEventListener("click", this.onClick);

    root.append(slot, bar, launcher);
    doc.body.append(root);
    this.root = root;
    this.slot = slot;
    this.bar = bar;
    this.statusNode = status;
    this.launcher = launcher;
  }

  destroy(): void {
    this.root?.remove();
    this.doc = null;
    this.root = null;
    this.slot = null;
    this.bar = null;
    this.statusNode = null;
    this.launcher = null;
    this.drag = null;
  }

  render(model: ChromeModel): Bounds | null {
    const doc = this.doc;
    const slot = this.slot;
    const bar = this.bar;
    const launcher = this.launcher;
    if (doc == null || slot == null || bar == null || launcher == null) return null;
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    if (width < 100 || height < 100) return null;

    const expanded = model.mode === "expanded";
    const parked = model.mode === "collapsed" && model.keepAlive;
    const header = headerHeightFromButtons(this.topButtons(doc));
    if (this.statusNode != null) this.statusNode.textContent = model.status;
    launcher.textContent = model.launcherText;
    launcher.style.display = expanded ? "none" : "block";
    this.placeLauncher(launcher, model.launcher, width, height);

    if (expanded) {
      place(bar, barBounds(width, header), false);
      bar.style.display = "flex";
      place(slot, expandedBounds(width, height, header), false);
    } else {
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

  private commandButton(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
    const button = doc.createElement("button");
    button.textContent = label;
    buttonStyle(button, false);
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

  private placeLauncher(launcher: HTMLButtonElement, position: LauncherPosition, viewportWidth: number, viewportHeight: number): void {
    const boxWidth = launcher.offsetWidth || 72;
    const boxHeight = launcher.offsetHeight || 32;
    const clamped = clampLauncher(position, viewportWidth, viewportHeight, boxWidth, boxHeight);
    launcher.style.left = `${clamped.left}px`;
    launcher.style.right = "auto";
    if ("top" in clamped) {
      launcher.style.top = `${clamped.top}px`;
      launcher.style.bottom = "auto";
      return;
    }
    launcher.style.top = "auto";
    launcher.style.bottom = `${clamped.bottom}px`;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.launcher == null) return;
    const rect = this.launcher.getBoundingClientRect();
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
    try {
      this.launcher.setPointerCapture?.(event.pointerId);
    } catch {
      /* pointer capture is optional */
    }
    event.stopPropagation();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const launcher = this.launcher;
    if (drag == null || launcher == null || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    launcher.style.left = `${Math.round(drag.originLeft + deltaX)}px`;
    launcher.style.top = `${Math.round(drag.originTop + deltaY)}px`;
    launcher.style.bottom = "auto";
    event.stopPropagation();
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.finishPointer(event, true);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.finishPointer(event, false);
  };

  private finishPointer(event: PointerEvent, activate: boolean): void {
    const drag = this.drag;
    const launcher = this.launcher;
    if (drag == null || launcher == null || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (!drag.moved) {
      if (!activate) return;
      this.suppressClick = true;
      this.handlers?.onOpen();
      return;
    }
    this.suppressClick = true;
    const rect = launcher.getBoundingClientRect();
    this.handlers?.onMove({ left: Math.round(rect.left), top: Math.round(rect.top) });
  };

  private onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    this.handlers?.onOpen();
  };
}
