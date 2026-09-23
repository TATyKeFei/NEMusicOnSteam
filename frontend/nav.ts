export const NAV_LINK_ID = "nemusic-nav-link";
export const NAV_MODE_ATTR = "data-nemusic-mode";

export function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml";
}

export type NavRowSnapshot = {
  top: number;
  height: number;
  width: number;
  flexRow: boolean;
  labels: string[];
  styledItems?: number;
  overflowHidden?: boolean;
};

export function navLabel(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 16) return null;
  return cleaned;
}

export function isSupernavItemStyle(fontSize: number, textTransform: string, cursor: string): boolean {
  return Number.isFinite(fontSize) && fontSize >= 16 && fontSize <= 22 && textTransform === "uppercase" && cursor === "pointer";
}

export function scoreNavRow(row: NavRowSnapshot): number {
  if (!row.flexRow) return 0;
  if (row.top < 0 || row.top > 120) return 0;
  if (row.height < 20 || row.height > 64) return 0;
  if (row.width < 280) return 0;
  const styled = row.styledItems ?? 0;
  if (row.overflowHidden && styled < 2) return 0;
  if (row.top < 24 && styled < 2) return 0;
  const labels = row.labels.map(navLabel).filter((label): label is string => label != null);
  if (labels.length < 2 && styled < 2) return 0;
  const count = Math.max(labels.length, styled);
  return (styled >= 2 ? 1000 : 0) + count * 100 + Math.round(row.top);
}

export function headerHeightFromNav(navBottom: number | null, fallback: number): number {
  if (navBottom == null || !Number.isFinite(navBottom)) return fallback;
  const rounded = Math.round(navBottom);
  if (rounded < 28 || rounded > 140) return fallback;
  return rounded;
}

export function readNavRow(row: HTMLElement): NavRowSnapshot {
  const rect = row.getBoundingClientRect();
  const view = row.ownerDocument.defaultView;
  const style = view?.getComputedStyle(row);
  const labels: string[] = [];
  let styledItems = 0;
  for (const child of Array.from(row.children)) {
    if (!isHtmlElement(child) || child.id === NAV_LINK_ID) continue;
    const childStyle = view?.getComputedStyle(child);
    if (
      childStyle != null &&
      isSupernavItemStyle(Number.parseFloat(childStyle.fontSize), childStyle.textTransform, childStyle.cursor)
    ) {
      styledItems += 1;
    }
    const label = navLabel(child.textContent ?? "");
    if (label == null) continue;
    const childRect = child.getBoundingClientRect();
    if (childRect.width < 16 || childRect.height < 12) continue;
    labels.push(label);
  }
  return {
    top: rect.top,
    height: rect.height,
    width: rect.width,
    flexRow: style?.display === "flex" && !style.flexDirection.startsWith("column"),
    labels,
    styledItems,
    overflowHidden: style?.overflowX === "hidden" || style?.overflowY === "hidden",
  };
}

export function findSupernavRow(doc: Document): HTMLElement | null {
  const view = doc.defaultView;
  const width = doc.documentElement.clientWidth;
  if (view == null || width < 280) return null;
  const seen = new Set<HTMLElement>();
  let best: HTMLElement | null = null;
  let bestScore = 0;
  const xSamples = [96, Math.round(width * 0.22), Math.round(width * 0.38), Math.round(width * 0.54)];
  for (const y of [8, 18, 30, 36, 46, 54, 62, 74]) {
    for (const x of xSamples) {
      for (const node of doc.elementsFromPoint(x, y)) {
        if (!isHtmlElement(node)) continue;
        let current: HTMLElement | null = node;
        for (let depth = 0; depth < 8 && current != null; depth += 1) {
          if (!seen.has(current)) {
            seen.add(current);
            const score = scoreNavRow(readNavRow(current));
            if (score > bestScore) {
              best = current;
              bestScore = score;
            }
          }
          current = current.parentElement;
        }
      }
    }
  }
  return best;
}

export function sharedClasses(classNames: string[]): string {
  const sets = classNames
    .map((name) => new Set(name.split(/\s+/).filter(Boolean)))
    .filter((set) => set.size > 0);
  const first = sets[0];
  if (first == null) return "";
  return [...first].filter((name) => sets.every((set) => set.has(name))).join(" ");
}

export function navTextItems(host: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of Array.from(host.children)) {
    if (!isHtmlElement(child) || child.id === NAV_LINK_ID) continue;
    if (navLabel(child.textContent ?? "") == null) continue;
    items.push(child);
  }
  return items;
}
