import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LibraryEntry, LIBRARY_ENTRY_ID, LIBRARY_ENTRY_FALLBACK_CLASSES } from "./library.ts";
import type { PlayerMode } from "./chrome.ts";

type TestEvent = {
  key: string;
  target: TestElement | null;
  stopPropagation: () => void;
  preventDefault: () => void;
};

class TestElement {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  id = "";
  type = "";
  title = "";
  className = "";
  textContent = "";
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: TestEvent) => void)[]>();
  onFocus: (() => void) | null = null;
  private root: boolean;

  constructor(root = false) { this.root = root; }

  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true; }
  get lastElementChild(): TestElement | null { return this.children.at(-1) ?? null; }
  querySelector(): null { return null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  focus(): void { this.onFocus?.(); }
  contains(target: TestElement | null): boolean {
    for (let node = target; node != null; node = node.parentElement) if (node === this) return true;
    return false;
  }

  append(...nodes: TestElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (this.parentElement == null) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }

  addEventListener(type: string, handler: (event: TestEvent) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    if (!handlers.includes(handler)) this.listeners.set(type, [...handlers, handler]);
  }

  removeEventListener(type: string, handler: (event: TestEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(listener => listener !== handler));
  }

  dispatch(type: string, details: Partial<Pick<TestEvent, "key" | "target">> = {}): boolean {
    let stopped = false;
    for (const handler of this.listeners.get(type) ?? []) handler({
      key: details.key ?? "",
      target: details.target ?? this,
      stopPropagation: () => { stopped = true; },
      preventDefault: () => {},
    });
    return stopped;
  }
}

function fixture() {
  const body = new TestElement(true);
  const head = new TestElement(true);
  let list = new TestElement();
  const games = new TestElement();
  list.append(games);
  let available = false;
  let opens = 0;
  let closes = 0;
  let settings = 0;
  let focused: TestElement | null = null;
  const events = new TestElement();
  const doc = {
    head,
    get activeElement() { return focused; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    createElement: () => {
      const element = new TestElement();
      element.onFocus = () => { focused = element; };
      return element;
    },
    querySelector: (selector: string) => {
      assert.equal(selector, `.${LIBRARY_ENTRY_FALLBACK_CLASSES.container}`);
      return available ? list : null;
    },
  } as unknown as Document;
  const entry = new LibraryEntry();
  return {
    entry, head, games, events,
    get focused() { return focused; },
    get list() { return list; },
    showLibrary() { available = true; body.append(list); },
    hideLibrary() { available = false; list.remove(); },
    replaceLibrary() { list.remove(); list = new TestElement(); body.append(list); },
    render(mode: PlayerMode = "closed") {
      entry.render(doc, mode, { onOpen: () => { opens++; }, onSettings: () => { settings++; }, onClose: () => { closes++; } }, LIBRARY_ENTRY_FALLBACK_CLASSES);
    },
    row: () => list.lastElementChild!,
    opens: () => opens,
    closes: () => closes,
    settings: () => settings,
  };
}

describe("library music entry", () => {
  it("waits for the library and adds one row after the game list", () => {
    const library = fixture();
    library.render();
    assert.equal(library.head.children.length, 0);
    library.showLibrary();
    for (let tick = 0; tick < 50; tick += 1) library.render();
    assert.equal(library.list.children.length, 2);
    assert.equal(library.list.children[0], library.games);
    assert.equal(library.row().id, LIBRARY_ENTRY_ID);
    assert.equal(library.row().children[0].children[1].textContent, "网易云音乐");
    assert.equal(library.head.children.length, 1);
    assert.match(library.head.children[0].textContent, /flex: 0 0 32px/);
  });

  it("opens the player from its label and toggles a settings and close menu from the grid", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    const [open, toggle, menu] = library.row().children;
    open.dispatch("click");
    toggle.dispatch("click");
    assert.equal(library.opens(), 1);
    assert.equal(library.closes(), 0);
    assert.equal(toggle.attributes.get("aria-expanded"), "true");
    assert.equal(menu.attributes.get("role"), "menu");
    assert.deepEqual(menu.children.map(item => item.textContent), ["设置", "关闭"]);
    for (let tick = 0; tick < 5; tick += 1) library.render();
    assert.equal(toggle.attributes.get("aria-expanded"), "true");
    toggle.dispatch("click");
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    library.render("expanded");
    assert.equal(open.attributes.get("aria-pressed"), "true");
    assert.equal(toggle.attributes.get("aria-label"), "展开菜单");
    toggle.dispatch("click");
    menu.children[1].dispatch("click");
    assert.equal(library.closes(), 1);
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    library.render("collapsed");
    assert.equal(open.attributes.get("aria-pressed"), "false");
    open.dispatch("click");
    assert.equal(library.opens(), 2);
  });

  it("opens settings from the menu without opening or closing the player", () => {
    const library = fixture();
    library.showLibrary();
    library.render("collapsed");
    const [, toggle, menu] = library.row().children;
    toggle.dispatch("click");
    menu.children[0].dispatch("click");
    assert.equal(library.settings(), 1);
    assert.equal(library.opens(), 0);
    assert.equal(library.closes(), 0);
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
  });

  it("dismisses on outside clicks, Escape, Tab, and player mode changes", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    const [, toggle, menu] = library.row().children;
    toggle.dispatch("click");
    library.events.dispatch("pointerdown", { target: menu.children[0] });
    assert.equal(toggle.attributes.get("aria-expanded"), "true");
    library.events.dispatch("pointerdown");
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    toggle.dispatch("click");
    assert.equal(library.events.dispatch("keydown", { key: "Escape" }), true);
    assert.equal(library.focused, toggle);
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    toggle.dispatch("click");
    library.events.dispatch("keydown", { key: "Tab" });
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    toggle.dispatch("click");
    library.render("expanded");
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    toggle.dispatch("click");
    library.hideLibrary();
    library.render();
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
  });

  it("opens and navigates the menu with arrow keys", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    const [, toggle, menu] = library.row().children;
    library.row().dispatch("keydown", { key: "ArrowDown", target: toggle });
    assert.equal(toggle.attributes.get("aria-expanded"), "true");
    assert.equal(library.focused, menu.children[0]);
    library.row().dispatch("keydown", { key: "ArrowDown", target: menu.children[0] });
    assert.equal(library.focused, menu.children[1]);
    library.row().dispatch("keydown", { key: "ArrowDown", target: menu.children[1] });
    assert.equal(library.focused, menu.children[0]);
    library.events.dispatch("keydown", { key: "Escape" });
    library.row().dispatch("keydown", { key: "ArrowUp", target: toggle });
    assert.equal(library.focused, menu.children[1]);
  });

  it("restores the bottom row after Steam rebuilds its children or library page", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    const row = library.row();
    row.remove();
    library.render();
    assert.equal(library.row(), row);
    library.hideLibrary();
    library.render();
    library.showLibrary();
    library.list.append(new TestElement());
    library.render();
    assert.equal(library.row(), row);
    assert.equal(library.head.children.length, 1);
    library.replaceLibrary();
    library.render();
    assert.equal(library.row(), row);
    assert.equal(library.list.children.length, 1);
  });

  it("keeps entry clicks and keyboard events out of Steam's game list handlers", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    for (const type of ["click", "keydown", "keyup"]) assert.equal(library.row().dispatch(type), true);
    assert.ok(library.row().children.slice(0, 2).every(button => button.type === "button"));
    assert.ok(library.row().children[2].children.every(button => button.type === "button"));
  });

  it("removes the entry and styles on shutdown and can mount again", () => {
    const library = fixture();
    library.showLibrary();
    library.render("expanded");
    library.row().children[1].dispatch("click");
    library.entry.destroy();
    assert.deepEqual(library.list.children, [library.games]);
    assert.equal(library.head.children.length, 0);
    assert.ok(Array.from(library.events.listeners.values()).every(handlers => handlers.length === 0));
    library.render("expanded");
    assert.equal(library.row().children[0].attributes.get("aria-pressed"), "true");
    assert.equal(library.head.children.length, 1);
  });
});
