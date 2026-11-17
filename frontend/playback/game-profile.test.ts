import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GAME_PROFILES, GameProfileSession, sanitizeGameProfiles } from "./game-profile.ts";
import type { TrackState } from "../mpris/mpris.ts";

function setup() {
  let state = { active: true, trackId: "1", volume: 0.8, playbackStatus: "Playing" } as TrackState;
  const calls: unknown[] = [];
  let fail = false;
  const session = new GameProfileSession(async () => ({ ...state }), async command => {
    calls.push(command); if (fail) return false;
    if (command.action === "volume") state.volume = command.value!;
    if (command.action === "pause") state.playbackStatus = "Paused";
    if (command.action === "play") state.playbackStatus = "Playing";
    return true;
  });
  return { session, calls, state, fail(value: boolean) { fail = value; } };
}
describe("game profile restoration", () => {
  it("restores the original volume between profiles without stacking reductions", async () => {
    const p = setup(); await p.session.select(DEFAULT_GAME_PROFILES[1]); assert.equal(p.state.volume, 0.32);
    assert.equal(p.session.recoveryVolume(0.32), 0.8);
    await p.session.select({ ...DEFAULT_GAME_PROFILES[1], volumePercent: 50 }); assert.equal(p.state.volume, 0.4);
    await p.session.select(null); assert.equal(p.state.volume, 0.8); assert.equal(p.session.snapshot().muteNotifications, false);
  });
  it("ignores a profile selection that finishes after the player was closed", async () => {
    let resolve!: (state: TrackState) => void;
    const calls: unknown[] = [];
    const session = new GameProfileSession(() => new Promise(done => { resolve = done; }), async command => { calls.push(command); return true; });
    const pending = session.select(DEFAULT_GAME_PROFILES[0]);
    await new Promise<void>(done => setImmediate(done)); session.reset();
    resolve({ active: true, trackId: "1", playbackStatus: "Playing" } as TrackState); await pending;
    assert.equal(session.snapshot().activeId, ""); assert.equal(session.snapshot().busy, false); assert.deepEqual(calls, []);
  });
  it("preserves a volume changed manually while a profile was active", async () => {
    const p = setup(); await p.session.select(DEFAULT_GAME_PROFILES[1]); p.state.volume = 0.6;
    await p.session.select(null); assert.equal(p.state.volume, 0.6);
  });
  it("resumes only the same song that the profile paused", async () => {
    const p = setup(); await p.session.select(DEFAULT_GAME_PROFILES[0]); assert.equal(p.state.playbackStatus, "Paused");
    await p.session.select(null); assert.equal(p.state.playbackStatus, "Playing");
    await p.session.select(DEFAULT_GAME_PROFILES[0]); p.state.trackId = "2";
    await p.session.select(null); assert.equal(p.state.playbackStatus, "Paused");
  });
  it("keeps the checkpoint after a failed restore so exit can be retried", async () => {
    const p = setup(); await p.session.select(DEFAULT_GAME_PROFILES[1]); p.fail(true);
    await p.session.select(null); assert.equal(p.session.snapshot().activeId, "relaxed");
    p.fail(false); await p.session.select(null); assert.equal(p.state.volume, 0.8);
  });
  it("does not resume music that was already paused", async () => {
    const p = setup(); p.state.playbackStatus = "Paused";
    await p.session.select(DEFAULT_GAME_PROFILES[0]); await p.session.select(null); assert.deepEqual(p.calls, []);
  });
  it("bounds profiles and rejects duplicate identifiers", () => {
    const profiles = sanitizeGameProfiles([{ ...DEFAULT_GAME_PROFILES[0], volumePercent: -5 }, DEFAULT_GAME_PROFILES[0], { id: "bad id", name: "bad" }]);
    assert.equal(profiles.length, 1); assert.equal(profiles[0].volumePercent, 0);
    assert.deepEqual(sanitizeGameProfiles([]), []);
  });
});
