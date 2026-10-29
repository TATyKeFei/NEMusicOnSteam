import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearSession, readSession, saveSession } from "./session.ts";
import type { PlayerRecoverySnapshot } from "./player-recovery-player.ts";

const snapshot: PlayerRecoverySnapshot = { accountId: "123", href: "https://music.163.com/st/webplayer", current: { resourceId: 1 }, queue: [{ id: 1 }, { id: 2 }], position: 42, playing: true, volume: 0, mode: "playOrder" };
function storage() {
  let data = "";
  return { getItem: () => data, setItem: (_key: string, value: string) => { data = value; }, removeItem: () => { data = ""; } };
}
describe("persistent playback session", () => {
  it("preserves queue, identity, position and muted volume, and can be cleared", () => {
    const s = storage(); saveSession(s, snapshot); assert.deepEqual(readSession(s), snapshot); clearSession(s); assert.equal(readSession(s), null);
  });
  it("rejects expired, future, malformed and oversized records", () => {
    const s = storage(), now = Date.now();
    for (const savedAt of [now - 31 * 86400000, now + 120000, "now"]) {
      s.setItem("", JSON.stringify({ savedAt, snapshot })); assert.equal(readSession(s), null);
    }
    for (const change of [{ current: [] }, { volume: 2 }, { position: -1 }, { playing: "yes" }, { accountId: {} }, { queue: new Array(5001).fill({}) }]) {
      s.setItem("", JSON.stringify({ savedAt: now, snapshot: { ...snapshot, ...change } })); assert.equal(readSession(s), null);
    }
    s.setItem("", "x".repeat(2_000_001)); assert.equal(readSession(s), null);
  });
  it("tolerates unavailable storage and does not overwrite a good session with an empty one", () => {
    const s = storage(); saveSession(s, snapshot); saveSession(s, { ...snapshot, current: null }); assert.deepEqual(readSession(s), snapshot);
    saveSession(null, snapshot); clearSession(null); assert.equal(readSession(null), null);
    assert.equal(readSession({ ...s, getItem: () => { throw new Error("blocked"); } }), null);
  });
});
