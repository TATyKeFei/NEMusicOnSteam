import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PlayerChrome } from "./chrome.ts";
import { NAV_INACTIVE_ATTR, NAV_SELECTED_CLASS } from "./nav.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

type Counts = { buttonScans: number; styleWrites: number };

type Rect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

type FakeElement = {
  namespaceURI: string;
  ownerDocument: Document;
  isConnected: boolean;
  tagName: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  className: string;
  title: string;
  textContent: string;
  children: FakeElement[];
  parentElement: FakeElement | null;
  remove: () => void;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    [Symbol.iterator]: () => IterableIterator<string>;
  };
  append: (...nodes: FakeElement[]) => void;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  removeEventListener: () => void;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  contains: (node: unknown) => boolean;
  querySelector: () => null;
  querySelectorAll: (selector: string) => FakeElement[];
  getBoundingClientRect: () => Rect;
  dispatch: (type: string, event?: unknown) => void;
  clientWidth: number;
  clientHeight: number;
};

function subtree(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.children) {
    if (predicate(child)) found.push(child);
    found.push(...subtree(child, predicate));
  }
  return found;
}

/** Only the DOM surface chrome.ts touches, with counters on the two operations that stall Steam. */
function fakeElement(counts: Counts, tagName: string, rect: Rect): FakeElement {
  const style = new Proxy<Record<string, string>>({}, {
    set(target, key, value) {
      counts.styleWrites += 1;
      target[String(key)] = String(value);
      return true;
    },
    get(target, key) {
      if (key === "setProperty") return (name: string, value: string) => { counts.styleWrites += 1; target[name] = String(value); };
      return Reflect.get(target, key);
    },
  });
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const children: FakeElement[] = [];
  const element: FakeElement = {
    namespaceURI: XHTML,
    ownerDocument: null as unknown as Document,
    isConnected: true,
    tagName,
    style,
    dataset: {},
    className: "",
    title: "",
    textContent: "",
    children,
    parentElement: null,
    remove: () => {
      if (element.parentElement == null) return;
      element.parentElement.children = element.parentElement.children.filter(child => child !== element);
      element.parentElement = null;
    },
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      contains: (name) => classes.has(name),
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    append: (...nodes) => { for (const node of nodes) { node.parentElement = element; children.push(node); } },
    addEventListener: (type, handler) => { listeners.set(type, [...(listeners.get(type) ?? []), handler]); },
    removeEventListener: () => {},
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => { attributes.set(name, value); },
    removeAttribute: name => { attributes.delete(name); },
    contains: (node) => { for (let current = node as FakeElement | null; current != null; current = current.parentElement) if (current === element) return true; return false; },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "button" ? subtree(element, (child) => child.tagName === "BUTTON") : []),
    // A placed element reports the box it was actually given, so bounds read back like a browser.
    getBoundingClientRect: () => {
      const read = (name: string, fallback: number) => Number.parseFloat(String(style[name] ?? "")) || fallback;
      const left = read("left", rect.left);
      const top = read("top", rect.top);
      const width = read("width", rect.width);
      const height = read("height", rect.height);
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
    dispatch: (type, event = {}) => { for (const handler of listeners.get(type) ?? []) handler(event); },
    clientWidth: rect.width,
    clientHeight: rect.height,
  };
  return element;
}

function chromeFixture() {
  const counts: Counts = { buttonScans: 0, styleWrites: 0 };
  const clientRect = (): Rect => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
  const html = fakeElement(counts, "HTML", clientRect());
  const body = fakeElement(counts, "BODY", clientRect());
  const head = fakeElement(counts, "HEAD", clientRect());
  const host = fakeElement(counts, "DIV", { top: 0, left: 0, right: 1000, bottom: 40, width: 1000, height: 40 });
  const library = fakeElement(counts, "DIV", { top: 0, left: 100, right: 200, bottom: 40, width: 100, height: 40 });
  const community = fakeElement(counts, "DIV", { top: 0, left: 200, right: 300, bottom: 40, width: 100, height: 40 });
  library.textContent = "库";
  community.textContent = "社区";
  library.classList.add(NAV_SELECTED_CLASS, "nav-menu");
  community.classList.add("nav-menu");
  host.append(library, community);
  let navigations = 0;
  const doc = {
    documentElement: html,
    body,
    head,
    defaultView: {
      getComputedStyle: () => ({ display: "flex", flexDirection: "row", fontSize: "18px", textTransform: "uppercase", cursor: "pointer" }),
    },
    createElement: (tag: string) => fakeElement(counts, tag.toUpperCase(), clientRect()),
    querySelector: () => null,
    elementsFromPoint: () => [host],
    querySelectorAll: (selector: string) => {
      if (selector === "button") {
        counts.buttonScans += 1;
        return subtree(body, (child) => child.tagName === "BUTTON");
      }
      return [];
    },
  } as unknown as Document;
  host.ownerDocument = doc;
  const chrome = new PlayerChrome();
  chrome.mount(doc, {
    onOpen: () => {},
    onSettings: () => {},
    onNavigateAway: () => { navigations += 1; },
    onClose: () => {},
  });
  return {
    chrome,
    counts,
    host,
    head,
    library,
    community,
    navigations: () => navigations,
    close: () => chrome.render({ mode: "closed", status: "", keepAlive: true, fullscreen: false }),
    collapse: () => chrome.render({ mode: "collapsed", status: "", keepAlive: true, fullscreen: false }),
    open: () => chrome.render({ mode: "expanded", status: "", keepAlive: true, fullscreen: false }),
    fullscreen: () => chrome.render({ mode: "expanded", status: "", keepAlive: true, fullscreen: true }),
    slot: () => (body.children[0] as FakeElement).children[1],
  };
}

describe("Player chrome layout cost", () => {
  it("scans the client document for buttons once instead of on every render", () => {
    const player = chromeFixture();
    for (let render = 0; render < 50; render++) player.close();
    assert.equal(player.counts.buttonScans, 1);
  });

  it("does not rewrite any style once the layout has settled", () => {
    const player = chromeFixture();
    player.close();
    const settled = player.counts.styleWrites;
    for (let render = 0; render < 50; render++) player.close();
    assert.equal(player.counts.styleWrites, settled);
  });

  it("re-measures only when the window has been resized", () => {
    const player = chromeFixture();
    player.close();
    assert.equal(player.counts.buttonScans, 1);
    player.chrome.invalidateHeader();
    player.close();
    assert.equal(player.counts.buttonScans, 2);
  });

  it("places the player under Steam's header without adding a navigation entry", () => {
    const player = chromeFixture();
    const slot = player.slot();
    const bounds = player.open();
    assert.equal(slot.style.display, "block");
    assert.equal(slot.style.top, "40px");
    assert.equal(slot.style.width, "1000px");
    assert.deepEqual(bounds, { x: 0, y: 40, width: 1000, height: 560 });
    assert.equal(player.host.children.length, 2);
    assert.deepEqual(player.host.children.map(child => child.textContent), ["库", "社区"]);
  });

  it("uses the whole Steam client area in web fullscreen", () => {
    const player = chromeFixture();
    const bounds = player.fullscreen();
    assert.deepEqual(bounds, { x: 0, y: 0, width: 1000, height: 600 });
  });

  it("still yields the player when navigating to Steam's library", () => {
    const player = chromeFixture();
    player.open();
    player.host.dispatch("click", { target: player.library });
    assert.equal(player.navigations(), 1);
  });

  it("does not register a backend patch that inserts the old top navigation entry", () => {
    const backend = readFileSync(new URL("../../backend/main.lua", import.meta.url), "utf8");
    assert.doesNotMatch(backend, /NEMusicOnSteamNav|nemusic-nav-link|SuperNav/);
  });

  it("clears the library highlight while expanded and restores it when collapsed or closed", () => {
    const player = chromeFixture();
    player.open();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), "1");
    assert.equal(player.library.classList.contains("nav-menu"), true);
    assert.equal(player.community.classList.contains(NAV_SELECTED_CLASS), false);
    player.collapse();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
    player.open();
    player.close();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
  });

  it("keeps the inactive appearance when Steam rerenders on hover without waiting for another tick", () => {
    const player = chromeFixture();
    player.open();
    player.library.classList.remove(NAV_SELECTED_CLASS);
    player.library.classList.add(NAV_SELECTED_CLASS);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), "1");
    player.close();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
  });

  it("restores the selection before returning to Steam or unloading the plugin", () => {
    const player = chromeFixture();
    player.open();
    player.host.dispatch("click", { target: player.library });
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
    player.open();
    player.chrome.destroy();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
    assert.equal(player.head.children.length, 0);
  });

  it("leaves Steam's current route selection intact when it changes during playback", () => {
    const player = chromeFixture();
    player.open();
    player.library.classList.remove(NAV_SELECTED_CLASS);
    player.community.classList.add(NAV_SELECTED_CLASS);
    player.open();
    assert.equal(player.library.getAttribute(NAV_INACTIVE_ATTR), null);
    assert.equal(player.community.getAttribute(NAV_INACTIVE_ATTR), "1");
    player.close();
    assert.equal(player.library.classList.contains(NAV_SELECTED_CLASS), false);
    assert.equal(player.community.classList.contains(NAV_SELECTED_CLASS), true);
    assert.equal(player.community.getAttribute(NAV_INACTIVE_ATTR), null);
  });
});
