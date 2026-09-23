import { CONTROL_BAR_HEIGHT, DEFAULT_HEADER_HEIGHT, PARKED_SIZE } from "./constants.ts";

export type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ButtonRect = {
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export function clampHeaderHeight(measured: number | null): number {
  if (measured == null || !Number.isFinite(measured)) return DEFAULT_HEADER_HEIGHT;
  const rounded = Math.round(measured);
  if (rounded < 28 || rounded > 140) return DEFAULT_HEADER_HEIGHT;
  return rounded;
}

export function headerHeightFromButtons(rects: ButtonRect[]): number {
  let bottom = 0;
  for (const rect of rects) {
    if (rect.top > 8) continue;
    if (rect.width < 36 || rect.height < 18 || rect.height > 80) continue;
    if (rect.bottom > bottom) bottom = rect.bottom;
  }
  return clampHeaderHeight(bottom > 0 ? bottom : null);
}

export function expandedBounds(viewportWidth: number, viewportHeight: number, headerHeight: number): Bounds {
  const top = clampHeaderHeight(headerHeight) + CONTROL_BAR_HEIGHT;
  return {
    x: 0,
    y: top,
    width: Math.max(1, Math.round(viewportWidth)),
    height: Math.max(1, Math.round(viewportHeight - top)),
  };
}

export function barBounds(viewportWidth: number, headerHeight: number): Bounds {
  return {
    x: 0,
    y: clampHeaderHeight(headerHeight),
    width: Math.max(1, Math.round(viewportWidth)),
    height: CONTROL_BAR_HEIGHT,
  };
}

export function parkedBounds(viewportWidth: number, viewportHeight: number): Bounds {
  const inset = 12;
  return {
    x: Math.max(0, Math.round(viewportWidth) - PARKED_SIZE - inset),
    y: Math.max(0, Math.round(viewportHeight) - PARKED_SIZE - inset),
    width: PARKED_SIZE,
    height: PARKED_SIZE,
  };
}

export function sameBounds(left: Bounds | null, right: Bounds | null): boolean {
  if (left == null || right == null) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
