import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSteamShutdown } from "./steam-shutdown.ts";
import type { SteamClient } from "./steam.ts";

describe("Steam shutdown notification", () => {
  it("cleans up at shutdown start and ignores repeated notifications", () => {
    let notification!: () => void;
    let cleanups = 0;
    let unregistrations = 0;
    const user = {
      RegisterForShutdownStart(callback: () => void) {
        assert.equal(this, user);
        notification = callback;
        return { unregister: () => { unregistrations++; } };
      },
    };
    const dispose = registerSteamShutdown(() => { cleanups++; }, { User: user });
    notification();
    notification();
    assert.equal(cleanups, 1);
    dispose();
    assert.equal(unregistrations, 1);
  });

  it("ignores callbacks after the plugin unloads and supports function disposers", () => {
    let notification!: () => void;
    let cleanups = 0;
    let unregistrations = 0;
    const client: SteamClient = { User: {
      RegisterForShutdownStart(callback) {
        notification = callback;
        return () => { unregistrations++; };
      },
    } };
    const dispose = registerSteamShutdown(() => { cleanups++; }, client);
    dispose();
    notification();
    assert.equal(cleanups, 0);
    assert.equal(unregistrations, 1);
  });

  it("allows the page lifecycle fallback when the native notification is unavailable", () => {
    registerSteamShutdown(() => assert.fail("unexpected shutdown"), null)();
    registerSteamShutdown(() => assert.fail("unexpected shutdown"), {})();
  });
});
