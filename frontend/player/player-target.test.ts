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

type Request = { expression?: string; sessionId?: string };
type TestApi = {
  evaluateInPlayer(expression: string): Promise<unknown>;
  tryEvaluateInPlayer(expression: string): Promise<unknown>;
  releasePlayerSession(): void;
};

function setup(send: (method: string, params?: Request) => Promise<unknown>): TestApi {
  return runInNewContext(`${source}; ({ evaluateInPlayer, tryEvaluateInPlayer, releasePlayerSession })`, {
    ChromeDevToolsProtocol: { send },
    isPlayerDocument: (url: string) => url === "player",
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
});
