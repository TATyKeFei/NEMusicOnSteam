import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { SETTINGS_ICON } from "../widget/settings-icon.ts";

const source = stripTypeScriptTypes(readFileSync(new URL("./steam-button.ts", import.meta.url), "utf8")
  .replace(/^import [\s\S]*? from [^;]+;\n/gm, "").replace(/^export /gm, ""));

class Element {
  id = "";
  innerHTML = "";
  textContent = "";
  parentElement: Element | null = null;
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  readonly ownerDocument: unknown;
  private root: boolean;
  constructor(ownerDocument: unknown, root = false) { this.ownerDocument = ownerDocument; this.root = root; }
  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get nextElementSibling(): Element | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(key: string, value: () => void) { this.listeners.set(key, value); }
  removeEventListener(key: string, value: () => void) { if (this.listeners.get(key) === value) this.listeners.delete(key); }
  click() { this.listeners.get("click")?.(); }
  append(element: Element) { this.insertBefore(element, null); }
  insertBefore(element: Element, anchor: Element | null) {
    element.remove(); element.parentElement = this;
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert.ok(index >= 0); this.children.splice(index, 0, element);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  querySelector(_selector: string): Element | null { return null; }
}

function fixture(nested = false) {
  let poll: (() => void) | null = null, available = false, hidden = 0, clears = 0;
  const popups: { content: { close: () => void; dismiss: () => void }; parent: Element; options: Record<string, unknown> }[] = [];
  const doc: { head: Element; querySelector: () => Element | null; createElement: () => Element } = {
    head: null!, querySelector: () => controls, createElement: () => new Element(doc),
  };
  doc.head = new Element(doc, true);
  const body = new Element(doc, true), controls = new Element(doc), news = new Element(doc), notifications = new Element(doc);
  let newsSlot = news;
  if (nested) { newsSlot = new Element(doc); newsSlot.append(news); }
  controls.append(newsSlot); controls.append(notifications); body.append(controls);
  controls.querySelector = selector => {
    assert.match(selector, /AnnouncementsButton/);
    return news.isConnected ? news : null;
  };
  const Button = runInNewContext(`${source}; SteamMusicButton`, {
    SETTINGS_ICON, console,
    findModule: () => null,
    findMainPopup: () => available ? { window: { document: doc } } : null,
    showContextMenu: (content: typeof popups[number]["content"], parent: Element, options: Record<string, unknown>) => {
      popups.push({ content, parent, options });
      return { Hide() { hidden++; content.dismiss(); } };
    },
    window: { setInterval: (fn: () => void) => { poll = fn; return 1; }, clearInterval: () => { clears++; poll = null; } },
  }) as new (content: (close: () => void, dismiss: () => void) => unknown) => { start(): void; stop(): void };
  const entry = new Button((close, dismiss) => ({ close, dismiss }));
  return { entry, doc, body, controls, newsSlot, news, notifications, popups,
    button: () => controls.children.find(child => child.id === "nemusic-titlebar-button")!,
    show: () => { available = true; }, poll: () => poll?.(), hidden: () => hidden, clears: () => clears,
  };
}

describe("Steam music titlebar button", () => {
  it("waits for the main window and inserts the logo immediately before news", () => {
    for (const nested of [false, true]) {
      const bar = fixture(nested); bar.entry.start();
      assert.equal(bar.button(), undefined);
      bar.show(); bar.poll();
      assert.deepEqual(bar.controls.children, [bar.button(), bar.newsSlot, bar.notifications]);
      assert.equal(bar.button().innerHTML, SETTINGS_ICON);
      bar.poll(); bar.entry.start();
      assert.equal(bar.controls.children.length, 3);
      bar.entry.stop();
      assert.equal(bar.doc.head.children.length, 0);
      assert.deepEqual(bar.controls.children, [bar.newsSlot, bar.notifications]);
      assert.equal(bar.clears(), 1);
    }
  });

  it("opens a native popup, supports toggle and clears state after outside dismissal", () => {
    const bar = fixture(); bar.show(); bar.entry.start();
    bar.button().click();
    assert.equal(bar.popups.length, 1);
    assert.equal(bar.popups[0].parent, bar.button());
    assert.equal(bar.popups[0].options.bForcePopup, true);
    assert.equal(bar.popups[0].options.bRetainOnHide, false);
    assert.equal(bar.button().attributes.get("aria-expanded"), "true");
    bar.button().click(); assert.equal(bar.hidden(), 1);
    assert.equal(bar.button().attributes.get("aria-expanded"), "false");
    bar.button().click(); bar.popups[1].content.dismiss();
    assert.equal(bar.button().attributes.get("aria-expanded"), "false");
    bar.button().click(); assert.equal(bar.popups.length, 3);
    bar.popups[1].content.dismiss();
    assert.equal(bar.button().attributes.get("aria-expanded"), "true");
    bar.popups[2].content.close(); assert.equal(bar.hidden(), 2);
    bar.entry.stop();
  });

  it("reattaches after Steam rebuilds the header and closes popups on removal", () => {
    const bar = fixture(); bar.show(); bar.entry.start();
    const first = bar.button(); first.click(); first.remove(); bar.poll();
    assert.notEqual(bar.button(), first);
    assert.equal(bar.hidden(), 1);
    assert.equal(first.listeners.size, 0);
    assert.equal(bar.doc.head.children.length, 1);
    bar.button().click(); bar.body.remove();
    bar.entry.stop(); assert.equal(bar.hidden(), 2);
    assert.equal(bar.button(), undefined);
  });

  it("keeps an entry when Steam has no news button", () => {
    const bar = fixture(); bar.newsSlot.remove(); bar.show(); bar.entry.start();
    assert.deepEqual(bar.controls.children, [bar.button(), bar.notifications]);
    bar.entry.stop();
  });

  it("moves beside news when Steam shows the news button later", () => {
    const bar = fixture(); bar.newsSlot.remove(); bar.show(); bar.entry.start();
    bar.controls.append(bar.newsSlot); bar.poll();
    assert.deepEqual(bar.controls.children, [bar.notifications, bar.button(), bar.newsSlot]);
    bar.entry.stop();
  });
});
