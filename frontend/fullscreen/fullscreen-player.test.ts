import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { fullscreenButtonScript, fullscreenButtonStateScript, fullscreenButtonUpdateScript } from "./fullscreen-player.ts";

type Rect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

class Element {
  textContent = "";
  type = "";
  title = "";
  innerHTML = "";
  parentElement: Element | null = null;
  nextSibling: Element | null = null;
  isConnected = false;
  style: { cssText: string; display?: string } = { cssText: "" };
  readonly children: Element[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: { preventDefault(): void; stopPropagation(): void }) => void)[]>();
  private readonly rect: Rect;

  constructor(rect: Rect, attributes: Record<string, string> = {}) {
    this.rect = rect;
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: { preventDefault(): void; stopPropagation(): void }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event: { shiftKey?: boolean } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ ...event, preventDefault() {}, stopPropagation() {} });
  }
  getBoundingClientRect() { return this.rect; }
  append(child: Element) { this.insertBefore(child, null); }
  insertAdjacentElement(_where: string, child: Element) { this.insertBefore(child, this.nextSibling); }
  insertBefore(child: Element, _next: Element | null) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
  }
  remove() { this.isConnected = false; }
  contains(node: Element) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }
}

function setup() {
  const toolbar = new Element({ top: 16, left: 220, right: 1000, bottom: 60, width: 780, height: 44 });
  const parent = new Element({ top: 20, left: 240, right: 540, bottom: 56, width: 300, height: 36 });
  const search = new Element({ top: 20, left: 275, right: 500, bottom: 54, width: 225, height: 34 }, { placeholder: "搜索" });
  const unrelated = new Element({ top: 20, left: 780, right: 812, bottom: 54, width: 32, height: 34 });
  parent.parentElement = toolbar;
  search.parentElement = parent;
  toolbar.children.push(parent);
  parent.children.push(search);
  const documentListeners = new Map<string, ((event: { key?: string; preventDefault(): void; stopPropagation(): void }) => void)[]>();
  const body = new Element({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
  let topAtSearch: Element | null = search;
  const context = {
    window: { innerWidth: 1000, addEventListener() {} } as Record<string, unknown>,
    document: {
      documentElement: {},
      body,
      querySelectorAll: () => [unrelated, search],
      elementFromPoint: () => topAtSearch,
      createElement: () => new Element({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      addEventListener: (type: string, listener: (event: { key?: string; preventDefault(): void; stopPropagation(): void }) => void) => {
        documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
      },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0,
    clearTimeout() {},
  };
  const installed = runInNewContext(fullscreenButtonScript(), context);
  return {
    context,
    body,
    toolbar,
    parent,
    search,
    unrelated,
    documentListeners,
    installed,
    coverSearch: (element: Element | null) => { topAtSearch = element; },
  };
}

describe("全屏按钮", () => {
  it("插在完整搜索框的外侧，忽略右上角的其他图标", () => {
    const { context, body, toolbar, parent, search, unrelated, installed } = setup();
    assert.equal(installed, true);
    assert.equal(parent.children.length, 1, "按钮不能塞进搜索控件");
    assert.equal(toolbar.children.length, 1, "按钮不能参与顶栏布局");
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].getAttribute("data-nemusic-fullscreen-button"), "1");
    assert.match(body.children[0].style.cssText, /position:fixed/);
    assert.match(body.children[0].style.cssText, /z-index:2147483645/);
    assert.match(body.children[0].style.cssText, /pointer-events:auto/);
    assert.equal(unrelated.parentElement, null);
    assert.equal(runInNewContext(fullscreenButtonUpdateScript(), context), true);
    assert.equal(body.children.length, 1);
  });

  it("被网页自己的弹窗覆盖时隐藏，回到播放器页面后恢复", () => {
    const { context, body, search, coverSearch } = setup();
    const overlay = new Element({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
    coverSearch(overlay);
    assert.equal(runInNewContext(fullscreenButtonUpdateScript(), context), true);
    assert.equal(body.children[0].style.display, "none");
    coverSearch(search);
    assert.equal(runInNewContext(fullscreenButtonUpdateScript(), context), true);
    assert.equal(body.children[0].style.display, "flex");
  });

  it("点击和 Escape 各生成一次桌面全屏请求", () => {
    const { context, body, documentListeners } = setup();
    const button = body.children[0];
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: false, fillWindow: false, request: 0 });
    button.dispatch("click");
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: true, fillWindow: false, request: 1 });
    for (const listener of documentListeners.get("keydown") ?? []) listener({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: false, fillWindow: false, request: 2 });
  });

  it("按住 Shift 点击时只请求铺满当前窗口", () => {
    const { context, body } = setup();
    const button = body.children[0];
    button.dispatch("click", { shiftKey: true });
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: true, fillWindow: true, request: 1 });
    assert.match(button.title, /退出窗口铺满/);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    button.dispatch("click");
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: false, fillWindow: false, request: 2 });
  });

  it("Escape 退出窗口铺满并清理模式标记", () => {
    const { context, body, documentListeners } = setup();
    body.children[0].dispatch("click", { shiftKey: true });
    for (const listener of documentListeners.get("keydown") ?? []) listener({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: false, fillWindow: false, request: 2 });
  });

  it("Shift 鼠标事件序列只生成一个窗口铺满请求", () => {
    const { context, body } = setup();
    const button = body.children[0];
    button.dispatch("pointerdown", { shiftKey: true });
    button.dispatch("mousedown", { shiftKey: true });
    button.dispatch("click", { shiftKey: true });
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: true, fillWindow: true, request: 1 });
  });

  it("没有 pointerdown 时 mousedown 和 click 也只切换一次", () => {
    const { context, body } = setup();
    body.children[0].dispatch("mousedown", { shiftKey: true });
    body.children[0].dispatch("click", { shiftKey: true });
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(fullscreenButtonStateScript(), context))), { active: true, fillWindow: true, request: 1 });
  });

  it("按全屏状态切换两套图标", () => {
    const { body } = setup();
    const paths = (name: string) => [...readFileSync(new URL(`../../assets/icon/${name}`, import.meta.url), "utf8").matchAll(/ d="([^"]+)"/g)]
      .map(match => match[1]);
    const actual = () => [...body.children[0].innerHTML.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(actual(), paths("full_sceen.svg"));
    body.children[0].dispatch("click");
    assert.deepEqual(actual(), paths("exit_full_sceen.svg"));
  });
});
