import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { recognitionScript } from "./recognition-player.ts";

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
  selectors = new Map<string, Element>();
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
  addEventListener() {}
  focus() {}
  remove() {}
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
});
