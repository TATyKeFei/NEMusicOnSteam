import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LibraryEntry, LIBRARY_ENTRY_ID, LIBRARY_ENTRY_FALLBACK_CLASSES } from "./library.ts";
import type { PlayerMode } from "./chrome.ts";

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
  listeners = new Map<string, ((event: { stopPropagation: () => void }) => void)[]>();
  private root: boolean;

  constructor(root = false) { this.root = root; }

  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true; }
  get lastElementChild(): TestElement | null { return this.children.at(-1) ?? null; }
  querySelector(): null { return null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }

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

  addEventListener(type: string, handler: (event: { stopPropagation: () => void }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  dispatch(type: string): boolean {
    let stopped = false;
    for (const handler of this.listeners.get(type) ?? []) handler({ stopPropagation: () => { stopped = true; } });
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
  const doc = {
    head,
    createElement: () => new TestElement(),
    querySelector: (selector: string) => {
      assert.equal(selector, `.${LIBRARY_ENTRY_FALLBACK_CLASSES.container}`);
      return available ? list : null;
    },
  } as unknown as Document;
  const entry = new LibraryEntry();
  return {
    entry, head, games,
    get list() { return list; },
    showLibrary() { available = true; body.append(list); },
    hideLibrary() { available = false; list.remove(); },
    replaceLibrary() { list.remove(); list = new TestElement(); body.append(list); },
    render(mode: PlayerMode = "closed") {
      entry.render(doc, mode, { onOpen: () => { opens++; }, onClose: () => { closes++; } }, LIBRARY_ENTRY_FALLBACK_CLASSES);
    },
    row: () => list.lastElementChild!,
    opens: () => opens,
    closes: () => closes,
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

  it("opens from either button and closes the expanded player from the grid", () => {
    const library = fixture();
    library.showLibrary();
    library.render();
    const [open, toggle] = library.row().children;
    open.dispatch("click");
    toggle.dispatch("click");
    assert.equal(library.opens(), 2);
    library.render("expanded");
    assert.equal(open.attributes.get("aria-pressed"), "true");
    assert.equal(toggle.attributes.get("aria-label"), "关闭网易云音乐");
    toggle.dispatch("click");
    assert.equal(library.closes(), 1);
    library.render("collapsed");
    assert.equal(open.attributes.get("aria-pressed"), "false");
    assert.equal(toggle.attributes.get("aria-label"), "展开网易云音乐");
    toggle.dispatch("click");
    assert.equal(library.opens(), 3);
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
    assert.ok(library.row().children.every(button => button.type === "button"));
  });

  it("removes the entry and styles on shutdown and can mount again", () => {
    const library = fixture();
    library.showLibrary();
    library.render("expanded");
    library.entry.destroy();
    assert.deepEqual(library.list.children, [library.games]);
    assert.equal(library.head.children.length, 0);
    library.render("expanded");
    assert.equal(library.row().children[0].attributes.get("aria-pressed"), "true");
    assert.equal(library.head.children.length, 1);
  });
});
