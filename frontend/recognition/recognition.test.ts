import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HelperClient } from "../runtime/helper-client.ts";
import { RecognitionBridge } from "./recognition.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(discover = async () => "http://localhost:1|old-token") {
  let tick = () => {};
  const scripts: string[] = [];
  const requests: string[] = [];
  const helper = new HelperClient(discover, async () => "http://localhost:2|new-token", async url => {
    requests.push(String(url));
    return new Response(JSON.stringify({ id: "recording" }));
  });
  const bridge = new RecognitionBridge({
    helper,
    evaluate: async expression => { scripts.push(expression); return { ok: true, note: "" }; },
    supported: () => true,
    targetMissing: () => false,
    timers: { setInterval: callback => { tick = callback as () => void; return 1; }, clearInterval() {} },
  });
  return { helper, bridge, scripts, requests, tick: () => tick() };
}

describe("recognition helper lifecycle", () => {
  it("refreshes the injected configuration after the shared helper restarts", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    await flush();
    assert.ok(player.scripts[0].includes("http://localhost:1"));
    await player.helper.connect(true);
    player.tick();
    await flush();
    assert.ok(player.scripts.at(-1)!.includes("http://localhost:2"));
    assert.ok(player.scripts.at(-1)!.includes("new-token"));
    player.bridge.setEnabled(false);
    await flush();
    assert.deepEqual(player.requests, ["http://localhost:2/recognition", "http://localhost:2/recognition/cancel"]);
  });

  it("does not install a script if disabled while discovery is pending", async () => {
    let resolve!: (value: string) => void;
    const player = setup(() => new Promise(done => { resolve = done; }));
    player.bridge.setEnabled(true);
    player.bridge.setEnabled(false);
    resolve("http://localhost:1|old-token");
    await flush();
    assert.deepEqual(player.scripts, []);
    assert.deepEqual(player.requests, []);
  });

  it("uses the connection that owns the recording when disabling after a restart", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    await flush();
    await player.helper.connect(true);
    player.bridge.setEnabled(false);
    await flush();
    assert.ok(player.requests.every(url => url.startsWith("http://localhost:1/")));
    assert.equal(player.helper.peek()?.token, "new-token");
  });
});
