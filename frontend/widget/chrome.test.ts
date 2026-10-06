import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlayerChrome } from "./chrome.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

type Counts = { buttonScans: number; styleWrites: number };

type Rect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

type FakeElement = {
  namespaceURI: string;
  tagName: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  className: string;
  title: string;
  textContent: string;
  children: FakeElement[];
  parentElement: FakeElement | null;
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
  contains: (node: unknown) => boolean;
  querySelector: () => null;
  querySelectorAll: (selector: string) => FakeElement[];
  getBoundingClientRect: () => Rect;
  dispatch: (type: string) => void;
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
    tagName,
    style,
    dataset: {},
    className: "",
    title: "",
    textContent: "",
    children,
    parentElement: null,
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
    dispatch: (type) => { for (const handler of listeners.get(type) ?? []) handler({}); },
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
  const host = fakeElement(counts, "DIV", { top: 0, left: 0, right: 1000, bottom: 40, width: 1000, height: 40 });
  const link = fakeElement(counts, "DIV", { top: 0, left: 900, right: 1000, bottom: 40, width: 100, height: 40 });
  link.dataset = {};
  host.append(link);
  let toolbarChanges = 0;
  const doc = {
    documentElement: html,
    body,
    defaultView: { clearTimeout: () => {}, setTimeout: () => 0 },
    createElement: (tag: string) => fakeElement(counts, tag.toUpperCase(), clientRect()),
    querySelector: (selector: string) => (selector === "#nemusic-nav-link" ? link : null),
    querySelectorAll: (selector: string) => {
      if (selector === "button") {
        counts.buttonScans += 1;
        return subtree(body, (child) => child.tagName === "BUTTON");
      }
      return selector === "#nemusic-nav-link" ? [link] : [];
    },
  } as unknown as Document;
  const chrome = new PlayerChrome();
  chrome.mount(doc, {
    onOpen: () => {},
    onNavigateAway: () => {},
    onToolbarChange: () => { toolbarChanges += 1; },
    onCollapse: () => {},
    onReload: () => {},
    onClose: () => {},
  });
  return {
    chrome,
    counts,
    toolbarChanges: () => toolbarChanges,
    close: () => chrome.render({ mode: "closed", status: "", keepAlive: true, fullscreen: false }),
    open: () => chrome.render({ mode: "expanded", status: "", keepAlive: true, fullscreen: false }),
    fullscreen: () => chrome.render({ mode: "expanded", status: "", keepAlive: true, fullscreen: true }),
    slot: () => (body.children[0] as FakeElement).children[1],
    bar: () => (body.children[0] as FakeElement).children[2],
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

  it("parks the player under the header and unhides the command bar on hover", () => {
    const player = chromeFixture();
    const slot = player.slot();
    const bounds = player.open();
    assert.equal(slot.style.display, "block");
    assert.equal(slot.style.top, "40px");
    assert.equal(slot.style.width, "1000px");
    assert.deepEqual(bounds, { x: 0, y: 40, width: 1000, height: 560 });
    assert.equal(player.bar().style.display, "none");
    player.bar().dispatch("mouseenter");
    assert.equal(player.toolbarChanges(), 1);
    player.open();
    assert.equal(player.bar().style.display, "flex");
  });

  it("uses the whole Steam client area in web fullscreen", () => {
    const player = chromeFixture();
    const bounds = player.fullscreen();
    assert.deepEqual(bounds, { x: 0, y: 0, width: 1000, height: 600 });
  });

  it("closes the command bar when the window goes away instead of leaving it stuck open", () => {
    const player = chromeFixture();
    player.open();
    player.bar().dispatch("mouseenter");
    player.open();
    assert.equal(player.bar().style.display, "flex");
    player.chrome.dismissToolbar();
    player.open();
    assert.equal(player.bar().style.display, "none");
  });
});
