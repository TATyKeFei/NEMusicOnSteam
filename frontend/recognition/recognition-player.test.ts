import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { recognitionScript, recognitionUpdateScript } from "./recognition-player.ts";

/** vm 里造出来的对象原型和测试进程不是一回事，深比较前先拍平。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fakeInput(rect: { top: number; left: number; width: number; height: number }, placeholder = "", header = "#page_pc_main_nav") {
  const parent = new Element();
  const input = {
    parentElement: parent,
    placeholder,
    getAttribute: (name: string) => (name === "placeholder" ? placeholder : null),
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    closest: (selector: string) => header && selector.split(", ").includes(header) ? parent : null,
  };
  return input;
}

function anchorFixture(inputs: unknown[]) {
  // 查询只返回仍在 DOM 中的按钮，以覆盖重复刷新、重挂载及旧版本升级。
  const created: Element[] = [];
  const context = {
    window: {} as any,
    document: {
      body: new Element(),
      activeElement: new Element(),
      createElement: () => {
        const element = new Element();
        created.push(element);
        return element;
      },
      addEventListener() {},
      querySelectorAll: (selector: string) => selector === '[data-nemusic-recognition-button]'
        ? created.filter(element => element.attrs.has("data-nemusic-recognition-button") && element.parentElement)
        : inputs,
    },
    AbortController,
    atob, btoa,
    setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  context.window.addEventListener = () => {};
  const result = plain(runInNewContext(recognitionScript("http://localhost", "token", false), context)) as {
    ok: boolean;
    note: string;
  };
  return { result, context };
}

const samples = Buffer.from(new Float32Array(48000).fill(0.25).buffer).toString("base64");
const engine = `const AudioFingerprintRuntime = () => ({ ExtractQueryFP: () => ({ size: () => 8, get: index => index * 48, delete() {} }) });`;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

class Element {
  textContent = "";
  innerHTML = "";
  value = "system";
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  href = "";
  children: Element[] = [];
  parentElement: Element | null = null;
  selectors = new Map<string, Element>();
  append(...children: Element[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  attrs = new Set<string>();
  setAttribute(name: string) { this.attrs.add(name); }
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
  listeners = new Map<string, (...args: any[]) => void>();
  addEventListener(name: string, callback: (...args: any[]) => void) { this.listeners.set(name, callback); }
  focus() {}
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

function setup(options: {
  source?: string;
  recording?: string;
  engineWait?: Promise<void>;
  startWait?: Promise<void>;
  error?: string;
} = {}) {
  const requests: { path: string; body: any }[] = [];
  const body = new Element();
  let poll = 0;
  const context = {
    window: {} as any,
    document: { body, activeElement: new Element(), createElement: () => new Element(), addEventListener() {} },
    AbortController,
    atob, btoa,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 400 ? 0 : ms),
    clearTimeout,
    fetch: async (url: string, init: { body?: string }) => {
      const path = new URL(url).pathname;
      requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
      let payload: unknown = {};
      let ok = true;
      if (path === "/recognition/engine") {
        await options.engineWait;
        payload = { source: engine };
      } else if (path === "/recognition/start") {
        await options.startWait;
        payload = { id: "job" };
      } else if (path === "/recognition") {
        payload = poll++ === 0
          ? { id: "job", stage: "recorded", samples: options.recording ?? samples }
          : { id: "job", stage: "done", results: [{ id: 123, name: "<img onerror=attack>", artist: "歌手", album: "专辑" }] };
      }
      if (options.error && path === "/recognition/start") { ok = false; payload = { error: options.error }; }
      return { ok, json: async () => payload };
    },
  };
  context.window.addEventListener = () => {};
  runInNewContext(recognitionScript("http://localhost", "token", true), context);
  const api = context.window.__nemusicRecognition;
  api.panel.querySelector("[data-source]").value = options.source ?? "system";
  return { api, requests, context };
}

describe("听歌识曲 UI", () => {
  it("opening the panel never starts recording; installing twice reuses the panel", () => {
    const { api, requests, context } = setup();
    runInNewContext(recognitionScript("http://localhost", "token", true), context);
    assert.equal(requests.length, 0);
    assert.equal(context.document.body.children.length, 1);
    assert.equal(context.window.__nemusicRecognition, api);
  });

  for (const source of ["system", "microphone"]) {
    it(`records the selected ${source} input and sends only a fingerprint for matching`, async () => {
      const { api, requests } = setup({ source });
      await api.start();
      assert.deepEqual(requests.find(item => item.path.endsWith("/start"))?.body, { source });
      assert.deepEqual(requests.find(item => item.path.endsWith("/match"))?.body, { id: "job", fingerprint: "ADBgkMDwIFA=" });
      assert.equal(api.busy, false);
      assert.match(api.panel.querySelector("[data-status]").textContent, /识别完成/);
      const title = api.panel.querySelector("[data-results]").children[0].children[0];
      assert.equal(title.textContent, "<img onerror=attack> — 歌手");
      assert.equal(title.tagName, undefined);
      assert.equal(api.panel.querySelector("[data-results]").children[0].children[2].children.length, 4);
    });
  }

  it("cancelling engine loading prevents recording from starting later", async () => {
    let release!: () => void;
    const { api, requests } = setup({ engineWait: new Promise<void>(resolve => { release = resolve; }) });
    const running = api.start();
    await flush();
    await api.cancel();
    release();
    await running;
    assert.equal(requests.some(item => item.path.endsWith("/start")), false);
    assert.equal(api.busy, false);
  });

  it("cancels a capture even if its start response arrives after closing", async () => {
    let release!: () => void;
    const { api, requests } = setup({ startWait: new Promise<void>(resolve => { release = resolve; }) });
    const running = api.start();
    await flush();
    api.hide();
    release();
    await running;
    assert.deepEqual(requests.find(item => item.path.endsWith("/cancel"))?.body, { id: "job" });
    assert.equal(requests.some(item => item.path.endsWith("/match")), false);
  });

  it("silence produces a useful message and never contacts the matching service", async () => {
    const { api, requests } = setup({ recording: Buffer.alloc(48000 * 4).toString("base64") });
    await api.start();
    assert.match(api.panel.querySelector("[data-status]").textContent, /没有采集到声音/);
    assert.equal(requests.some(item => item.path.endsWith("/match")), false);
    assert.equal(requests.some(item => item.path.endsWith("/cancel")), true);
  });

  it("displays missing recorder errors and allows retrying", async () => {
    const { api } = setup({ error: "需要安装 parec" });
    await api.start();
    assert.equal(api.panel.querySelector("[data-status]").textContent, "需要安装 parec");
    assert.equal(api.panel.querySelector("[data-start]").disabled, false);
  });

  it("replaces a stale api left by an older plugin build", () => {
    const { context } = setup();
    const stale = { version: 0, config: {}, cancel() {}, hide() {}, show() { throw new Error("stale show called"); } };
    context.window.__nemusicRecognition = stale;
    runInNewContext(recognitionScript("http://localhost", "token", false), context);
    const fresh = context.window.__nemusicRecognition;
    assert.notEqual(fresh, stale);
    assert.ok((fresh.version as number) > 0);
    assert.equal(stale.cancel !== undefined, true);
  });
});

describe("识曲按钮的挂载位置", () => {
  it("挑顶栏最靠上靠左的那个宽框，而不是第一个 input", () => {
    // 页面里先出现一个又窄又矮的杂项 input，真正的搜索框在后面。
    const junk = fakeInput({ top: 30, left: 20, width: 60, height: 16 });
    const search = fakeInput({ top: 24, left: 210, width: 260, height: 34 }, "搜索");
    const { result, context } = anchorFixture([junk, search]);
    assert.deepEqual(result, { ok: true, note: "" });
    assert.equal((search.parentElement as any).children.length, 1, "按钮应该挂在搜索框那一组");
    assert.equal((junk.parentElement as any).children.length, 0);
    assert.equal(context.window.__nemusicRecognition.version, 7);
  });

  it("已经装好时重复调用是幂等的，不会再插一个按钮", () => {
    const search = fakeInput({ top: 24, left: 210, width: 260, height: 34 }, "搜索");
    const { result, context } = anchorFixture([search]);
    assert.equal(result.note, "");
    const again = plain(runInNewContext(recognitionUpdateScript("http://localhost", "token", false), context)) as { note: string };
    assert.equal(again.note, "");
    assert.equal((search.parentElement as any).children.length, 1);
  });

  it("页面里一个 input 都没有时说清楚，而不是静默失败", () => {
    const { result } = anchorFixture([]);
    assert.equal(result.ok, true, "脚本本身仍然装上了，只是没找到挂按钮的位置");
    assert.match(result.note, /一个 input 都没有/);
  });

  it("隐藏的顶栏搜索框需要等到显示后再挂载", () => {
    const hidden = fakeInput({ top: 900, left: 900, width: 0, height: 0 });
    const { result } = anchorFixture([hidden]);
    assert.match(result.note, /没找到可以放识曲按钮的搜索框/);
  });

  it("不把我喜欢的音乐页面中的搜索框当成顶栏，滚动到顶部也不行", () => {
    const playlist = fakeInput({ top: 26, left: 800, width: 320, height: 34 }, "搜索我喜欢的音乐", "");
    const inputs = [playlist];
    const { result, context } = anchorFixture(inputs);
    assert.match(result.note, /等待全局导航栏搜索框显示/);
    assert.equal(playlist.parentElement.children.length, 0);

    const header = fakeInput({ top: 40, left: 210, width: 200, height: 34 }, "");
    inputs.push(header);
    runInNewContext(recognitionUpdateScript("http://localhost", "token", false), context);
    assert.equal(playlist.parentElement.children.length, 0);
    assert.equal(header.parentElement.children.length, 1);
  });

  it("顶栏搜索框不带搜索占位文字时仍排除更宽的歌单搜索框", () => {
    const header = fakeInput({ top: 40, left: 210, width: 200, height: 34 }, "每日推荐");
    const playlist = fakeInput({ top: 70, left: 400, width: 400, height: 34 }, "搜索", "");
    anchorFixture([playlist, header]);
    assert.equal(playlist.parentElement.children.length, 0);
    assert.equal(header.parentElement.children.length, 1);
  });

  it("修复已有按钮的错误位置，并在顶栏消失后清理按钮", () => {
    const header = fakeInput({ top: 24, left: 210, width: 260, height: 34 }, "搜索");
    const playlist = fakeInput({ top: 260, left: 800, width: 260, height: 34 }, "搜索", "");
    const inputs = [header, playlist];
    const { context } = anchorFixture(inputs);
    const misplaced = header.parentElement.children[0];
    playlist.parentElement.append(misplaced);
    runInNewContext(recognitionUpdateScript("http://localhost", "token", false), context);
    assert.equal(playlist.parentElement.children.length, 0);
    assert.equal(header.parentElement.children.length, 1);
    assert.notEqual(header.parentElement.children[0], misplaced);
    inputs.splice(0, 1);
    runInNewContext(recognitionUpdateScript("http://localhost", "token", false), context);
    assert.equal(header.parentElement.children.length, 0);
    assert.equal(playlist.parentElement.children.length, 0);
  });

  it("替换旧版本按钮的点击处理，让它打开新版识曲面板", () => {
    const header = fakeInput({ top: 24, left: 210, width: 260, height: 34 }, "搜索");
    const { context } = anchorFixture([header]);
    const old = context.window.__nemusicRecognition;
    const oldButton = header.parentElement.children[0];
    old.version = 5;
    runInNewContext(recognitionScript("http://localhost", "token", false), context);
    const fresh = context.window.__nemusicRecognition;
    let opened = false;
    fresh.show = () => { opened = true; };
    assert.notEqual(fresh, old);
    assert.equal(header.parentElement.children.length, 1);
    assert.notEqual(header.parentElement.children[0], oldButton);
    header.parentElement.children[0].listeners.get("click")!({ preventDefault() {}, stopPropagation() {} });
    assert.equal(opened, true);
  });

  it("兼容旧网页的全局顶栏搜索框", () => {
    const header = fakeInput({ top: 24, left: 210, width: 260, height: 34 }, "搜索", ".m-top");
    anchorFixture([header]);
    assert.equal(header.parentElement.children.length, 1);
  });

  it("placeholder 写着搜索的框即使位置稍偏也会被选中", () => {
    const off = fakeInput({ top: 60, left: 460, width: 200, height: 30 }, "搜索");
    const plain = fakeInput({ top: 20, left: 8, width: 150, height: 30 }, "用户名");
    const { result } = anchorFixture([off, plain]);
    assert.equal(result.note, "");
    assert.equal((off.parentElement as any).children.length, 1);
    assert.equal((plain.parentElement as any).children.length, 0);
  });

  it("页面脚本版本对不上时如实报告，而不是当成装好了", () => {
    const context = { window: { __nemusicRecognition: { version: 1 } } as any };
    const result = plain(runInNewContext(recognitionUpdateScript("http://localhost", "token", false), context));
    assert.deepEqual(result, { ok: false, note: "页面脚本版本不一致" });
  });
});
