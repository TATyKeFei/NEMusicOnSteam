import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./player-target.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);

type Request = { expression?: string; sessionId?: string; targetId?: string; source?: string };
type TestApi = {
  evaluateInPlayer(expression: string): Promise<unknown>;
  tryEvaluateInPlayer(expression: string): Promise<unknown>;
  releasePlayerSession(): void;
  preparePlayerTarget(marker: string): Promise<void>;
};

function setup(send: (method: string, params?: Request) => Promise<unknown>): TestApi {
  return runInNewContext(`${source}; ({ evaluateInPlayer, tryEvaluateInPlayer, releasePlayerSession, preparePlayerTarget })`, {
    ChromeDevToolsProtocol: { send },
    URL,
    isPlayerDocument: (url: string) => url === "player" || url.startsWith("https://music.163.com/st/webplayer"),
  }) as TestApi;
}

describe("player CDP session", () => {
  it("handles discovery and attachment failures without detached promise rejections", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { runInNewContext } from 'node:vm';
      const unhandled = [];
      const caught = [];
      process.on('unhandledRejection', error => unhandled.push(error.message));
      for (const failure of ['Target.getTargets', 'Target.attachToTarget']) {
        const api = runInNewContext(${JSON.stringify(`${source}; ({ evaluateInPlayer })`)}, {
          isPlayerDocument: () => true,
          ChromeDevToolsProtocol: {
            send: async method => {
              if (method === failure) throw new Error(failure);
              return { targetInfos: [{ targetId: 'player', url: 'player' }] };
            },
          },
        });
        await api.evaluateInPlayer('1').catch(error => caught.push(error.message));
      }
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({ caught, unhandled }));
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      caught: ["Target.getTargets", "Target.attachToTarget"],
      unhandled: [],
    });
  });

  it("shares one cached session between concurrent evaluations", async () => {
    const calls: string[] = [];
    const api = setup(async (method, params) => {
      calls.push(method);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "player", url: "player" }] };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      return { result: { value: params?.expression } };
    });
    assert.deepEqual(await Promise.all([api.evaluateInPlayer("first"), api.evaluateInPlayer("second")]), ["first", "second"]);
    await api.evaluateInPlayer("third");
    assert.equal(calls.filter(method => method === "Target.getTargets").length, 1);
    assert.equal(calls.filter(method => method === "Target.attachToTarget").length, 1);
  });

  it("clears a failed discovery so the retry can connect", async () => {
    let attempts = 0;
    const api = setup(async method => {
      if (method === "Target.getTargets") {
        if (++attempts === 1) throw new Error("disconnected");
        return { targetInfos: [{ targetId: "player", url: "player" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      return { result: { value: true } };
    });
    assert.equal(await api.evaluateInPlayer("1"), true);
    assert.equal(attempts, 2);
  });

  it("does not reconnect when the evaluated page throws", async () => {
    const calls: string[] = [];
    const api = setup(async method => {
      calls.push(method);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "player", url: "player" }] };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      return { exceptionDetails: { text: "page failed" }, result: {} };
    });
    await assert.rejects(api.evaluateInPlayer("throw 1"), { message: "page failed" });
    assert.equal(calls.filter(method => method === "Target.getTargets").length, 1);
    assert.ok(!calls.includes("Target.detachFromTarget"));
  });

  it("pins bridges to the new view instead of the first surviving old page", async () => {
    const attached: string[] = [];
    let created = false;
    const api = setup(async (method, params) => {
      if (method === "Target.getTargets") return { targetInfos: created ? [
        { targetId: "old", url: "https://music.163.com/st/webplayer" },
        { targetId: "new", url: "https://music.163.com/st/webplayer" },
      ] : [{ targetId: "old", url: "https://music.163.com/st/webplayer" }] };
      if (method === "Target.attachToTarget") {
        attached.push((params as { targetId: string }).targetId);
        return { sessionId: "new-session" };
      }
      return { result: { value: true } };
    });
    await api.preparePlayerTarget("new");
    created = true;
    await api.evaluateInPlayer("1");
    assert.deepEqual(attached, ["new"]);
  });

  it("does not fall back to the old page while the new view is still loading", async () => {
    const api = setup(async method => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "old", url: "https://music.163.com/st/webplayer" }] };
      throw new Error("must not attach");
    });
    await api.preparePlayerTarget("new");
    assert.equal(await api.tryEvaluateInPlayer("1"), null);
  });

  it("installs the view marker without changing location or touching cookies", async () => {
    const methods: string[] = [];
    const page = { location: { href: "https://music.163.com/st/webplayer" }, __NEMusicOnSteamViewToken: "" };
    let created = false;
    let injected = "";
    const api = setup(async (method, params) => {
      methods.push(method);
      if (method === "Target.getTargets") return { targetInfos: created ? [{ targetId: "new", url: page.location.href }] : [] };
      if (method === "Target.attachToTarget") return { sessionId: "new-session" };
      if (method === "Page.addScriptToEvaluateOnNewDocument") { injected = params?.source ?? ""; return { identifier: "marker" }; }
      if (method === "Runtime.evaluate" && params?.expression === injected) runInNewContext(injected, page);
      return { result: { value: true } };
    });
    await api.preparePlayerTarget("new-view");
    created = true;
    await api.evaluateInPlayer("1");
    await api.evaluateInPlayer("2");
    assert.equal(page.__NEMusicOnSteamViewToken, "new-view");
    assert.equal(page.location.href, "https://music.163.com/st/webplayer");
    assert.doesNotMatch(injected, /location|history|cookie|storage/i);
    assert.equal(methods.filter(method => method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
    assert.ok(!methods.includes("Page.navigate"));
  });

  it("reattaches to the same target ID after reload without URL tokens", async () => {
    const attached: string[] = [];
    let created = false;
    const api = setup(async (method, params) => {
      if (method === "Target.getTargets") return { targetInfos: created ? [
        { targetId: "unrelated", url: "https://music.163.com/st/webplayer" },
        { targetId: "new", url: "https://music.163.com/st/webplayer" },
      ] : [{ targetId: "unrelated", url: "https://music.163.com/st/webplayer" }] };
      if (method === "Target.attachToTarget") { attached.push(params?.targetId ?? ""); return { sessionId: "session" }; }
      return { result: { value: true } };
    });
    await api.preparePlayerTarget("new-view");
    created = true;
    await api.evaluateInPlayer("1");
    api.releasePlayerSession();
    await api.evaluateInPlayer("2");
    assert.deepEqual(attached, ["new", "new"]);
  });

  it("never switches to an unrelated page if the selected view disappears", async () => {
    let targets = [{ targetId: "unrelated", url: "https://music.163.com/st/webplayer" }];
    const api = setup(async method => {
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      return { result: { value: true } };
    });
    await api.preparePlayerTarget("new-view");
    targets = [...targets, { targetId: "new", url: "https://music.163.com/st/webplayer" }];
    await api.evaluateInPlayer("1");
    api.releasePlayerSession();
    targets = [targets[0]];
    assert.equal(await api.tryEvaluateInPlayer("2"), null);
  });

  it("does not guess when multiple new player targets appear", async () => {
    let created = false;
    const api = setup(async method => {
      if (method === "Target.getTargets") return { targetInfos: created ? [
        { targetId: "first", url: "https://music.163.com/st/webplayer" },
        { targetId: "second", url: "https://music.163.com/st/webplayer" },
      ] : [] };
      throw new Error("must not attach");
    });
    await api.preparePlayerTarget("new-view");
    created = true;
    assert.equal(await api.tryEvaluateInPlayer("1"), null);
  });

  it("waits for the pre-creation target snapshot before accepting any page", async () => {
    let resolveTargets!: (targets: { targetInfos: unknown[] }) => void;
    const api = setup(async method => {
      if (method === "Target.getTargets") return new Promise(resolve => { resolveTargets = resolve; });
      throw new Error("must not attach");
    });
    const preparing = api.preparePlayerTarget("new-view");
    assert.equal(await api.tryEvaluateInPlayer("1"), null);
    resolveTargets({ targetInfos: [] });
    await preparing;
  });
});
