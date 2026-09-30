import type { PlayerMode } from "../widget/chrome.ts";

export type SteamPageSelectors = {
  main: string | null;
  external: string | null;
};

export const STEAM_PAGE_FALLBACK_CLASSES: SteamPageSelectors = {
  main: "_2B7WsaKHDSav8vpQUxkVRB",
  external: "_3FyI1bPLZwRkUBI_SScY6s",
};

export type SteamPageAction = "yield" | "restore" | "none";

function classVisible(doc: Document, className: string | null): boolean {
  if (className == null) return false;
  const token = className.split(/\s+/)[0] ?? "";
  if (token === "") return false;
  const view = doc.defaultView;
  for (const element of Array.from(doc.getElementsByClassName(token))) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    if (view?.getComputedStyle(element).visibility === "hidden") continue;
    return true;
  }
  return false;
}

export function steamPageVisible(doc: Document | null | undefined, selectors: SteamPageSelectors): boolean {
  if (doc == null) return false;
  return classVisible(doc, selectors.main) || classVisible(doc, selectors.external);
}

export function steamPageTransition(
  previous: boolean | null,
  shown: boolean,
  mode: PlayerMode,
  yielded: boolean,
): SteamPageAction {
  if (previous == null || previous === shown) return "none";
  if (shown) return mode === "expanded" ? "yield" : "none";
  return yielded ? "restore" : "none";
}
