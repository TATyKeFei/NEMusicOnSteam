import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { qualityButtonScript, qualityButtonUpdateScript, qualityButtonResultScript } from "./quality-button.ts";
import { QUALITY_OPTIONS, qualityCommandScript } from "./quality-player.ts";
import { queueSortButtonScript } from "../queue/queue-sort-player.ts";
import { togetherButtonScript } from "../together/together-button.ts";

type TestEvent = { target: TestNode; key: string; preventDefault: () => void; stopPropagation: () => void };
type Mutation = { target: TestNode; type: string };

class TestNode {
  tagName: string;
  id = "";
  className = "";
  innerHTML = "";
  type = "";
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: TestNode[] = [];
  parentElement: TestNode | null = null;
  rect = { top: 714, left: 940, width: 28, height: 28 };
  listeners = new Map<string, ((event: TestEvent) => void)[]>();
  onFocus: (() => void) | null = null;
  ownerDocument = { defaultView: { getComputedStyle: (node: TestNode) => ({ display: node.hidden ? "none" : "block", visibility: "visible", opacity: "1" }) } };
  private text = "";

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get title(): string { return this.getAttribute("title") ?? ""; }
  set title(value: string) { this.setAttribute("title", value); }
  get isConnected(): boolean { return this.tagName === "BODY" || this.parentElement?.isConnected === true; }
  get nextElementSibling(): TestNode | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  get previousElementSibling(): TestNode | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; for (const child of this.children) child.parentElement = null; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return name === "id" ? this.id : this.attributes.get(name) ?? null; }
  focus(): void { this.onFocus?.(); }
  getBoundingClientRect() { return { ...this.rect, width: this.hidden ? 0 : this.rect.width, height: this.hidden ? 0 : this.rect.height }; }

  append(...nodes: TestNode[]): void {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }

  insertBefore(node: TestNode, sibling: TestNode): void {
    node.remove();
    node.parentElement = this;
    this.children.splice(this.children.indexOf(sibling), 0, node);
  }

  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }

  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const rule = part.trim();
      if (rule.startsWith("#")) return this.id === rule.slice(1);
      if (rule.startsWith(".")) return this.className.split(/\s+/).includes(rule.slice(1));
      const attribute = /^\[([^=\]*^]+)([*^]?=)?(?:"([^"]*)")?\]$/.exec(rule);
      if (attribute) {
        const value = this.getAttribute(attribute[1]);
        if (!attribute[2]) return value != null;
        if (attribute[2] === "*=") return value?.includes(attribute[3]) === true;
        if (attribute[2] === "^=") return value?.startsWith(attribute[3]) === true;
        return value === attribute[3];
      }
      return this.tagName === rule.toUpperCase();
    });
  }

  closest(selector: string): TestNode | null {
    for (let node: TestNode | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  querySelectorAll(selector: string): TestNode[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }

  querySelector(selector: string): TestNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type: string, listener: (event: TestEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: (event: TestEvent) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(handler => handler !== listener)); }
  dispatch(type: string, details: Partial<TestEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, key: "", preventDefault() {}, stopPropagation() {}, ...details });
  }
}

function fixture() {
  const body = new TestNode("body");
  const events = new TestNode("document");
  const bar = new TestNode("div");
  const play = new TestNode("button");
  play.id = "btn_pc_minibar_play";
  play.rect.left = 580;
  const volume = new TestNode("button");
  const volumeIcon = new TestNode("svg");
  volumeIcon.title = "音量";
  volume.append(volumeIcon);
  const share = new TestNode("button");
  share.title = "分享";
  share.rect.left = 180;
  const state = {
    host: { isAnonymous: false, isPlusVip: true },
    setting: { quantity: { listenReg: 320, listenAnon: 128, download: 999 } },
    playing: { resourceTrackId: "123", resourceDuration: 240, playingVolume: 0.4, resourcePlayingQuality: 999, playingState: 1 },
  };
  const actions: { type: string; payload: Record<string, unknown> }[] = [];
  const store = { getState: () => state, dispatch: async (action: typeof actions[number]) => { actions.push(action); Object.assign(state.setting.quantity, action.payload); } };
  (play as unknown as Record<string, unknown>).__reactFiber$quality = { memoizedProps: { store }, return: null };
  bar.append(share, play, volume);
  body.append(bar);
  let activeElement: TestNode | null = null;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const observers = new Set<(mutations: Mutation[]) => void>();
  const windowEvents = new TestNode("window");
  const context = {
    document: {
      body,
      get activeElement() { return activeElement; },
      querySelector: body.querySelector.bind(body),
      querySelectorAll: body.querySelectorAll.bind(body),
      createElement: (tag: string) => { const node = new TestNode(tag); node.onFocus = () => { activeElement = node; }; return node; },
      createTextNode: (text: string) => { const node = new TestNode("#text"); node.textContent = text; return node; },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    window: {
      innerWidth: 1200, innerHeight: 800,
      setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: (id: number) => { timers.delete(id); },
      requestAnimationFrame: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
    MutationObserver: class {
      callback: (mutations: Mutation[]) => void;
      constructor(callback: (mutations: Mutation[]) => void) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
  };
  const run = (script: string) => runInNewContext(script, context);
  const button = () => body.querySelector("[data-nemusic-quality-button]")!;
  const menu = () => body.querySelector("[data-nemusic-quality-menu]")!;
  return {
    body, bar, play, volume, volumeIcon, state, actions, events, timers, observers, windowEvents, run, button, menu,
    install: () => run(qualityButtonScript()),
    item: (value: number) => menu().querySelector(`[data-nemusic-quality-item="${value}"]`)!,
    mutate: (target: TestNode, type = "childList") => { for (const callback of observers) callback([{ target, type }]); },
    flush: () => { for (let attempt = 0; attempt < 30 && timers.size; attempt++) { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); } },
  };
}

describe("playback quality button", () => {
  it("uses the supplied SVG and mounts immediately before the outer volume button", () => {
    const player = fixture();
    player.install();
    assert.equal(player.button().nextElementSibling, player.volume);
    assert.deepEqual(player.volume.children, [player.volumeIcon]);
    assert.equal(player.button().title, "音质设置");
    const asset = readFileSync(new URL("../../assets/icon/sound_quality.svg", import.meta.url), "utf8");
    const pathData = (svg: string) => [...svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(pathData(player.button().innerHTML), pathData(asset));
    assert.match(player.button().innerHTML, /fill="currentColor"/);
    player.install();
    player.run(qualityButtonUpdateScript());
    assert.equal(player.bar.querySelectorAll("[data-nemusic-quality-button]").length, 1);
  });

  it("ignores volume controls outside the right side of the playback bar", () => {
    const player = fixture();
    player.volume.hidden = true;
    const unrelated = new TestNode("button");
    unrelated.title = "音量";
    unrelated.rect.top = 250;
    player.body.append(unrelated);
    player.install();
    assert.equal(player.button(), null);
    player.volume.hidden = false;
    player.volumeIcon.title = "";
    player.volume.setAttribute("data-log", '{"oid":"btn_pc_minibar_volume"}');
    player.run(qualityButtonUpdateScript());
    assert.equal(player.button().nextElementSibling, player.volume);
  });

  it("shows every quality option, the saved preference, and the actual quality separately", () => {
    const player = fixture();
    player.install();
    player.button().dispatch("click");
    assert.equal(player.menu().getAttribute("role"), "menu");
    assert.equal(player.button().getAttribute("aria-expanded"), "true");
    assert.equal(player.menu().querySelectorAll("[data-nemusic-quality-item]").length, QUALITY_OPTIONS.length);
    assert.match(player.menu().querySelector("[data-nemusic-quality-current]")!.textContent, /无损 · SQ/);
    assert.equal(player.item(320).getAttribute("aria-checked"), "true");
    assert.equal(player.item(999).getAttribute("aria-checked"), "false");
    player.state.setting.quantity.listenReg = 1999;
    player.state.playing.resourcePlayingQuality = 320;
    player.run(qualityButtonUpdateScript());
    assert.equal(player.item(1999).getAttribute("aria-checked"), "true");
    assert.match(player.menu().querySelector("[data-nemusic-quality-current]")!.textContent, /极高/);
  });

  it("queues one request and uses the existing quality command without changing download quality", async () => {
    const player = fixture();
    player.install();
    player.button().dispatch("click");
    player.item(1999).dispatch("click");
    assert.equal(player.menu(), null);
    const requested = player.run(qualityButtonUpdateScript());
    assert.equal(requested.action, 1999);
    assert.equal(player.run(qualityButtonUpdateScript()).action, null);
    player.button().dispatch("click");
    assert.equal(player.item(999).disabled, true);
    player.item(999).dispatch("click");
    assert.equal(player.run(qualityButtonUpdateScript()).action, null);
    const result = await player.run(qualityCommandScript(1999));
    player.run(qualityButtonResultScript(result.message));
    assert.equal(player.item(1999).getAttribute("aria-checked"), "true");
    assert.equal(player.item(999).disabled, false);
    assert.equal(player.state.setting.quantity.download, 999);
    assert.equal(player.actions.length, 1);
  });

  it("reports rejected selections and unlocks the menu for another attempt", async () => {
    const player = fixture();
    player.state.host.isAnonymous = true;
    player.install();
    player.button().dispatch("click");
    player.item(999).dispatch("click");
    await assert.rejects(player.run(qualityCommandScript(999)), /登录/);
    player.run(qualityButtonResultScript("请先登录"));
    assert.equal(player.actions.length, 0);
    assert.match(player.body.querySelector("[data-nemusic-quality-toast]")!.textContent, /请先登录/);
    player.button().dispatch("click");
    assert.equal(player.item(128).disabled, false);
  });

  it("heals the same button after the bar is rebuilt and coexists with together", () => {
    const player = fixture();
    player.install();
    const button = player.button();
    button.remove();
    player.mutate(player.bar);
    player.flush();
    assert.equal(player.button(), button);
    assert.equal(button.nextElementSibling, player.volume);
    player.run(togetherButtonScript());
    assert.equal(button.nextElementSibling, player.volume);
    assert.ok(player.bar.querySelector("[data-nemusic-together-button]"));
    assert.equal(player.body.querySelectorAll("[data-nemusic-quality-button]").length, 1);
  });

  it("stays put next to the queue sort button instead of fighting over the volume slot", () => {
    const player = fixture();
    player.install();
    player.run(queueSortButtonScript(true));
    const sorted = player.body.querySelector("[data-nemusic-queue-sort-button]")!;
    const quality = player.button();
    // 排序按钮站在音质按钮正左边，两个按钮紧挨音量键。
    assert.equal(sorted.nextElementSibling, quality);
    assert.equal(quality.nextElementSibling, player.volume);
    const before = [...player.bar.children];
    // 页面每次抖动都会触发双方补挂。回归：两条脚本都要求「紧贴音量键左边」时，
    // 每帧互相把对方挤开，两个按钮的点击全部落空。
    for (let round = 0; round < 3; round++) {
      player.mutate(player.bar);
      player.flush();
    }
    assert.deepEqual([...player.bar.children], before);
  });

  it("dismisses with outside clicks and Escape, and cleans up listeners and observers", () => {
    const player = fixture();
    player.install();
    player.button().dispatch("click");
    player.events.dispatch("click", { target: player.item(128) });
    assert.ok(player.menu());
    player.events.dispatch("click", { target: player.body });
    assert.equal(player.menu(), null);
    player.button().dispatch("click");
    player.events.dispatch("keydown", { key: "Escape" });
    assert.equal(player.menu(), null);
    assert.equal(player.button().getAttribute("aria-expanded"), "false");
    player.button().dispatch("click");
    player.run("window.__nemusicQualityButton.destroy()");
    player.flush();
    assert.equal(player.button(), null);
    assert.equal(player.menu(), null);
    assert.equal(player.observers.size, 0);
    assert.ok([...player.events.listeners.values(), ...player.windowEvents.listeners.values()].every(listeners => listeners.length === 0));
  });
});
