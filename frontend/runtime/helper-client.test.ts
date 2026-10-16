import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HelperClient, HelperConnectionError } from "./helper-client.ts";

describe("shared helper connection", () => {
  it("preserves the browser global receiver when calling fetch", async context => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async function (this: unknown, url, options) {
      // Chromium 的 Window.fetch 会拒绝以 HelperClient 实例作为 this 的调用。
      assert.equal(this, globalThis);
      assert.equal(String(url), "http://localhost:1001/state");
      assert.equal(new Headers(options?.headers).get("X-NEMusic-Token"), "token");
      requests++;
      return new Response("{}");
    });
    const helper = new HelperClient(async () => "http://localhost:1001|token");
    assert.equal((await helper.request("/state")).status, 200);
    assert.equal(requests, 1);
  });

  it("shares concurrent discovery and publishes a restarted helper to all callers", async () => {
    let discoveries = 0;
    const requests: { url: string; token: string }[] = [];
    const helper = new HelperClient(
      async () => { discoveries++; return "http://localhost:1001|old"; },
      async () => "http://localhost:1002|new",
      async (url, options) => {
        requests.push({ url: String(url), token: new Headers(options?.headers).get("X-NEMusic-Token")! });
        return new Response("{}");
      },
    );
    const [download, recognition] = await Promise.all([helper.connect(), helper.connect()]);
    assert.equal(download, recognition);
    assert.equal(discoveries, 1);
    await helper.request("/download", { method: "POST" });
    await helper.connect(true);
    await helper.request("/download", { method: "POST" });
    assert.equal((await helper.connect()).token, "new");
    assert.deepEqual(requests, [
      { url: "http://localhost:1001/download", token: "old" },
      { url: "http://localhost:1002/download", token: "new" },
    ]);
  });

  it("invalidates a failed request without replaying it and rediscovers for the next request", async () => {
    let discoveries = 0;
    let requests = 0;
    const helper = new HelperClient(
      async () => `http://localhost:${++discoveries}|token`,
      undefined,
      async () => { if (++requests === 1) throw new Error("helper stopped"); return new Response("{}"); },
    );
    await assert.rejects(helper.request("/download", { method: "POST" }), /helper stopped/);
    assert.equal(requests, 1);
    await helper.request("/download", { method: "POST" });
    assert.equal(discoveries, 2);
    assert.equal(requests, 2);
  });

  it("discards pending discovery when a reconnect supersedes it", async () => {
    let resolve!: (value: string) => void;
    const helper = new HelperClient(() => new Promise(done => { resolve = done; }), async () => "http://localhost:2|new");
    const stale = helper.connect();
    const rejection = assert.rejects(stale, /连接已失效/);
    await helper.connect(true);
    resolve("http://localhost:1|old");
    await rejection;
    assert.equal(helper.peek()?.token, "new");
  });

  it("does not let an old request failure invalidate a new connection", async () => {
    let fail!: (error: Error) => void;
    const helper = new HelperClient(async () => "http://localhost:1|old", async () => "http://localhost:2|new",
      () => new Promise((_resolve, reject) => { fail = reject; }));
    const old = await helper.connect();
    const request = helper.request("/recognition", {}, old);
    const rejection = assert.rejects(request, /old request/);
    await helper.connect(true);
    fail(new Error("old request"));
    await rejection;
    assert.equal(helper.peek()?.token, "new");
  });

  it("drops a rejected token and retries failed discovery on the next call", async () => {
    let result = "!spawn:missing dependency";
    const helper = new HelperClient(async () => result, undefined, async () => new Response("{}", { status: 403 }));
    await assert.rejects(helper.connect(), error => error instanceof HelperConnectionError && error.result === result);
    result = "http://localhost:1|token";
    await helper.request("/state");
    assert.equal(helper.peek(), null);
    assert.equal((await helper.connect()).token, "token");
  });

  it("keeps a healthy shared connection when a caller cancels its request", async () => {
    const controller = new AbortController();
    const helper = new HelperClient(async () => "http://localhost:1|token", undefined, async () => {
      controller.abort();
      throw new Error("cancelled");
    });
    await assert.rejects(helper.request("/commands", { signal: controller.signal }), /cancelled/);
    assert.equal(helper.peek()?.token, "token");
  });
});
