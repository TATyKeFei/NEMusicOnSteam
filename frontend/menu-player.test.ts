import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { MENU_HELPERS_SCRIPT, MENU_TICK_SCRIPT, menuToastScript } from "./menu-player.ts";

type Song = { id: number; name: string; artist: string };
type Helpers = { asSong: (value: unknown) => Song | null; findSongFromProps: (props: unknown) => Song | null };

function helpers(): Helpers {
  return runInNewContext(MENU_HELPERS_SCRIPT, {}) as Helpers;
}

/** Objects built inside the vm belong to another realm, so compare them after a JSON round trip. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** The v1 API shape. */
const V1_SONG = { id: 186963, name: "惑星ラビット", ar: [{ id: 1, name: "Yunomi" }, { id: 2, name: "TORIENA" }], al: { id: 3, name: "EP" }, dt: 223000 };

type TickResult = { installed: boolean; menus: number; songs: number; pending: Song[]; error?: string };

function pageStub() {
  const listeners: string[] = [];
  const intervals: number[] = [];
  const window: Record<string, unknown> = {};
  const document = {
    body: { children: [], appendChild: () => {} },
    documentElement: {},
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, querySelectorAll: () => [], children: [] }),
    addEventListener: (type: string) => {
      listeners.push(type);
    },
  };
  const context: Record<string, unknown> = {
    window,
    document,
    WeakSet,
    Date,
    Math,
    clearTimeout: () => {},
    setTimeout: () => 0,
    setInterval: (handler: unknown) => {
      intervals.push(1);
      return 1;
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  return {
    context,
    window,
    listeners,
    intervals,
    run: () => runInNewContext(MENU_TICK_SCRIPT, context) as TickResult,
    api: () => (window.__nemusicDownload ?? null) as { pending: Song[] } | null,
  };
}

// ---------------------------------------------------------------------------
// A tiny DOM stand-in, enough for the scanner: element tree, selectors,
// computed style, listeners and timers. React fibers are plain properties.
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

type NodeOptions = { class?: string; text?: string };

class FakeNode {
  readonly tagName: string;
  readonly nodeType = 1;
  readonly children: FakeNode[] = [];
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};
  parentElement: FakeNode | null = null;
  isConnected = true;
  id = "";
  private ownText: string;

  constructor(tagName: string, options: NodeOptions = {}) {
    this.tagName = tagName.toUpperCase();
    this.ownText = options.text ?? "";
    if (options.class) this.attributes.class = options.class;
  }

  get className(): string {
    return this.attributes.class ?? "";
  }

  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value ?? "";
    // Mirror the real DOM: assigning text wipes the children.
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
  }

  get nextElementSibling(): FakeNode | null {
    const parent = this.parentElement;
    if (!parent) return null;
    return parent.children[parent.children.indexOf(this) + 1] ?? null;
  }

  appendChild(node: FakeNode): FakeNode {
    node.parentElement = this;
    node.isConnected = true;
    this.children.push(node);
    return node;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    if (reference == null) return this.appendChild(node);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(node);
    node.parentElement = this;
    node.isConnected = true;
    this.children.splice(index, 0, node);
    return node;
  }

  cloneNode(deep: boolean): FakeNode {
    const clone = new FakeNode(this.tagName.toLowerCase(), { text: this.ownText });
    for (const [name, value] of Object.entries(this.attributes)) clone.attributes[name] = value;
    if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, handler: Listener): void {
    (this.listeners[type] ??= []).push(handler);
  }

  getBoundingClientRect() {
    return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
  }

  querySelector(selector: string): FakeNode | null {
    return queryNodes(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return queryNodes(this, selector);
  }
}

function descendants(root: FakeNode): FakeNode[] {
  const found: FakeNode[] = [];
  const walk = (node: FakeNode) => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function matchesPart(node: FakeNode, part: string): boolean {
  if (part === "*") return true;
  const attribute = /^\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]$/.exec(part);
  if (attribute) {
    const actual = node.getAttribute(attribute[1]);
    if (actual == null) return false;
    if (attribute[2] == null) return true;
    return attribute[2] === "*" ? actual.includes(attribute[3]) : actual === attribute[3];
  }
  return node.tagName.toLowerCase() === part.toLowerCase();
}

function queryNodes(root: FakeNode, selector: string): FakeNode[] {
  const parts = selector.split(",").map(part => part.trim()).filter(Boolean);
  return descendants(root).filter(node => parts.some(part => matchesPart(node, part)));
}

const MENU_LABELS = ["播放", "下一首播放", "查看评论(57)", "收藏", "分享", "复制链接", "从歌单中删除"];
const MENU_SONG = { id: 987654, name: "列表里的歌", ar: [{ id: 1, name: "列表里的歌手" }] };
const MENU_SONG_PLAIN = { id: 987654, name: "列表里的歌", artist: "列表里的歌手" };

function songMenu(labels: string[]): FakeNode {
  const menu = new FakeNode("ul", { class: "m-menu" });
  for (const label of labels) {
    const item = new FakeNode("li", { class: "m-item" });
    const icon = new FakeNode("span", { class: "u-icon" });
    icon.appendChild(new FakeNode("svg", { class: "u-svg" }));
    item.appendChild(icon);
    item.appendChild(new FakeNode("span", { class: "m-label", text: label }));
    menu.appendChild(item);
  }
  return menu;
}

/** A list row whose "···" button carries the fiber React would have put there. */
function songRow(props: Record<string, unknown>): { row: FakeNode; more: FakeNode } {
  const row = new FakeNode("div", { class: "row" });
  const more = new FakeNode("button", { class: "more" });
  (more as unknown as Record<string, unknown>)["__reactFiber$test"] = { memoizedProps: props, return: null };
  row.appendChild(more);
  return { row, more };
}

function find(root: FakeNode, selector: string): FakeNode {
  const node = root.querySelector(selector);
  assert.ok(node, `expected to find ${selector}`);
  return node;
}

function fakePage() {
  let clock = 0;
  const documentElement = new FakeNode("html");
  const body = new FakeNode("body");
  const app = new FakeNode("div", { class: "app" });
  documentElement.appendChild(body);
  body.appendChild(app);

  const created: FakeNode[] = [];
  const documentListeners: { type: string; handler: Listener }[] = [];
  const intervals: Listener[] = [];
  const window: Record<string, unknown> = {};

  const document = {
    body,
    documentElement,
    querySelectorAll: (selector: string) => queryNodes(documentElement, selector),
    getElementById: (id: string) => descendants(documentElement).find(node => node.id === id) ?? null,
    createElement: (tag: string) => {
      const node = new FakeNode(tag);
      created.push(node);
      return node;
    },
    addEventListener: (type: string, handler: Listener) => {
      documentListeners.push({ type, handler });
    },
  };

  const context: Record<string, unknown> = {
    window,
    document,
    Date: { now: () => clock },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (handler: Listener) => {
      intervals.push(handler);
      return intervals.length;
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      padding: "8px",
      font: "14px Arial",
      color: "rgb(0, 0, 0)",
      lineHeight: "20px",
    }),
  };

  return {
    context,
    created,
    attach: (node: FakeNode) => app.appendChild(node),
    advance: (ms: number) => {
      clock += ms;
    },
    intervalCount: () => intervals.length,
    clickListenerCount: () => documentListeners.filter(entry => entry.type === "click").length,
    click: (node: FakeNode) => {
      for (const entry of documentListeners) if (entry.type === "click") entry.handler({ target: node });
    },
    tick: () => {
      for (const handler of intervals) handler(null);
    },
    run: () => runInNewContext(MENU_TICK_SCRIPT, context) as TickResult,
  };
}

describe("identifying the song behind a menu", () => {
  it("reads a track from the v1 shape", () => {
    assert.deepEqual(plain(helpers().asSong(V1_SONG)), { id: 186963, name: "惑星ラビット", artist: "Yunomi, TORIENA" });
  });

  it("reads a track from the shape the current player uses", () => {
    const song = helpers().asSong({ id: "3389430943", name: " 咸咸的 ", artists: [{ name: "uzakin" }, { name: "Soda纯白" }], album: { id: 1 } });
    assert.deepEqual(plain(song), { id: 3389430943, name: "咸咸的", artist: "uzakin, Soda纯白" });
  });

  it("accepts plain singer names and a duration instead of an artist list", () => {
    const helpers_ = helpers();
    assert.equal(helpers_.asSong({ id: 7, name: "歌", singer: ["甲", "乙"], dt: 1000 })?.artist, "甲, 乙");
    assert.equal(helpers_.asSong({ id: 7, name: "歌", duration: 1000 })?.artist, "");
  });

  it("rejects a playlist, an album, or anything that is not a track", () => {
    const { asSong } = helpers();
    assert.equal(asSong({ id: 5, name: "我喜欢的音乐", trackCount: 34, coverImgUrl: "x" }), null);
    assert.equal(asSong({ id: 5, name: "某个专辑", artists: [] }), null);
    assert.equal(asSong({ id: 5, name: "歌" }), null);
  });

  it("rejects ids and names it cannot trust", () => {
    const { asSong } = helpers();
    for (const id of [0, -1, NaN, "abc", null, undefined]) assert.equal(asSong({ ...V1_SONG, id }), null);
    for (const name of ["", "   ", 12, null]) assert.equal(asSong({ ...V1_SONG, name }), null);
    assert.equal(asSong([V1_SONG]), null);
    assert.equal(asSong("186963"), null);
    assert.equal(asSong(null), null);
  });

  it("finds a song nested in the props the menu receives", () => {
    const { findSongFromProps } = helpers();
    assert.equal(findSongFromProps(V1_SONG)?.id, 186963);
    assert.equal(findSongFromProps({ song: V1_SONG, index: 3 })?.id, 186963);
    assert.equal(findSongFromProps({ data: { song: V1_SONG } })?.id, 186963);
    assert.equal(findSongFromProps({ props: { track: V1_SONG } })?.id, 186963);
    assert.equal(findSongFromProps({ detail: { payload: { item: V1_SONG } } })?.id, 186963);
    assert.equal(findSongFromProps({ row: { song: V1_SONG } }), null, "an unknown key must not be searched");
  });

  it("never picks a song out of a list", () => {
    const { findSongFromProps } = helpers();
    assert.equal(findSongFromProps({ songs: [V1_SONG, { ...V1_SONG, id: 2 }] }), null);
    assert.equal(findSongFromProps({ data: [V1_SONG] }), null);
    assert.equal(findSongFromProps({ list: { songs: [V1_SONG] } }), null);
  });

  it("does not dig past its depth limit or loop forever", () => {
    const { findSongFromProps } = helpers();
    assert.equal(findSongFromProps({ a: { b: { c: { d: { e: V1_SONG } } } } }), null);
    const looped: Record<string, unknown> = { song: null };
    looped.data = looped;
    assert.equal(findSongFromProps(looped), null);
  });

  it("prefers the song the props were handed over a nested one", () => {
    const { findSongFromProps } = helpers();
    assert.equal(findSongFromProps({ song: V1_SONG, data: { song: { ...V1_SONG, id: 999 } } })?.id, 186963);
  });
});

describe("menu scanner installation", () => {
  it("installs once, listens for clicks, and keeps the counters", () => {
    const page = pageStub();
    const first = page.run();
    assert.equal(first.installed, true);
    assert.deepEqual(plain(first.pending), []);
    assert.equal(page.listeners.filter(type => type === "click").length, 1);
    assert.equal(page.intervals.length, 1);
    assert.ok(page.api());

    const second = page.run();
    assert.equal(second.installed, true);
    assert.equal(page.listeners.length, 1, "a second tick must not stack another listener");
    assert.equal(page.intervals.length, 1, "a second tick must not stack another interval");
  });

  it("hands back whatever the user asked for and clears the queue", () => {
    const page = pageStub();
    page.run();
    const song = { id: 186963, name: "惑星ラビット", artist: "Yunomi" };
    page.api()?.pending.push(song);
    assert.deepEqual(plain(page.run().pending), [song]);
    assert.deepEqual(plain(page.run().pending), []);
  });

  it("reports a broken page instead of throwing into the caller", () => {
    const result = runInNewContext(MENU_TICK_SCRIPT, {}) as TickResult;
    assert.equal(result.installed, false);
    assert.match(String(result.error), /window/);
    assert.deepEqual(plain(result.pending), []);
  });

  it("exposes a toast the frontend can call, and tolerates a page without one", () => {
    assert.equal(runInNewContext(menuToastScript("已保存"), { window: {} }), false);
    const page = pageStub();
    page.run();
    const messages: { textContent: string }[] = [];
    const box = { style: {}, textContent: "" };
    (page.context.document as { getElementById: unknown }).getElementById = () => box;
    (page.context.document as { body: unknown }).body = { children: [], appendChild: (element: { textContent: string }) => messages.push(element) };
    assert.equal(runInNewContext(menuToastScript("要下载的歌"), page.context), true);
    assert.equal(box.textContent, "要下载的歌");
  });
});

describe("menu scanning against a fake page", () => {
  it("injects a 下载 item after 复制链接 and queues the song it belongs to", () => {
    const page = fakePage();
    const menu = songMenu(MENU_LABELS);
    const { row, more } = songRow({ song: MENU_SONG });
    page.attach(row);
    page.attach(menu);

    const installed = page.run();
    assert.equal(installed.installed, true);
    assert.equal(page.intervalCount(), 1);
    assert.equal(page.clickListenerCount(), 1, "one capture listener remembers the clicked row");

    page.click(more);
    page.tick();

    const item = find(menu, "[data-nemusic-download]");
    assert.equal(item.textContent, "下载");
    assert.equal(menu.children.indexOf(item), MENU_LABELS.indexOf("复制链接") + 1, "it lands right after 复制链接");
    const icons = item.querySelectorAll("svg, [class*='icon']");
    assert.ok(icons.length > 0, "the clone keeps the original icon");
    assert.ok(icons.every(icon => icon.style.display === "none"), "the icon is hidden so only the label shows");

    const counters = page.run();
    assert.equal(counters.menus, 1);
    assert.equal(counters.songs, 1);

    const clicks = item.listeners.click ?? [];
    assert.equal(clicks.length, 1, "a clone has no React fiber, so it carries its own listener");
    clicks[0]({ preventDefault() {}, stopPropagation() {}, target: item });
    assert.deepEqual(plain(page.run().pending), [MENU_SONG_PLAIN]);
    assert.equal(
      page.created.find(node => node.id === "nemusic-download-toast")?.textContent,
      "正在准备下载 列表里的歌手 - 列表里的歌",
    );
  });

  it("leaves the menu alone when the row is not actually a song", () => {
    const page = fakePage();
    const menu = songMenu(MENU_LABELS);
    const { row, more } = songRow({ data: { playlist: { id: 5, name: "我喜欢的音乐", trackCount: 34, coverImgUrl: "x" } } });
    page.attach(row);
    page.attach(menu);

    page.run();
    page.click(more);
    page.tick();

    assert.equal(menu.querySelector("[data-nemusic-download]"), null, "guessing a song would download the wrong file");
    const counters = page.run();
    assert.equal(counters.menus, 1, "the menu was recognised");
    assert.equal(counters.songs, 0, "but no song could be identified");
  });

  it("ignores a menu that has no song actions", () => {
    const page = fakePage();
    const menu = songMenu(["播放", "从歌单中删除"]);
    const { row, more } = songRow({ song: MENU_SONG });
    page.attach(row);
    page.attach(menu);

    page.run();
    page.click(more);
    page.tick();

    assert.equal(menu.querySelector("[data-nemusic-download]"), null);
    const counters = page.run();
    assert.equal(counters.menus, 0);
    assert.equal(counters.songs, 0);
  });

  it("never stacks a second 下载 item on a later tick", () => {
    const page = fakePage();
    const menu = songMenu(MENU_LABELS);
    const { row, more } = songRow({ song: MENU_SONG });
    page.attach(row);
    page.attach(menu);

    page.run();
    page.click(more);
    page.tick();
    page.tick();
    page.tick();

    const injected = menu.children.filter(child => child.getAttribute("data-nemusic-download") != null);
    assert.equal(injected.length, 1);
    const counters = page.run();
    assert.equal(counters.menus, 1, "one menu is counted once");
    assert.equal(counters.songs, 1, "and only one download is offered");
  });

  it("forgets a click that happened before the menu window", () => {
    const page = fakePage();
    const menu = songMenu(MENU_LABELS);
    const { row, more } = songRow({ song: MENU_SONG });
    page.attach(row);
    page.attach(menu);

    page.run();
    page.click(more);
    page.advance(4001);
    page.tick();

    assert.equal(menu.querySelector("[data-nemusic-download]"), null);
    assert.equal(page.run().menus, 0);
  });
});
