import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { SleepTimer } from "./sleep-timer.ts";
import type { TrackState } from "../mpris/mpris.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  let now = 100000;
  mock.method(Date, "now", () => now);
  const timers = new Map<number, () => void>();
  let serial = 0;
  Object.assign(globalThis, { window: { setInterval(fn: () => void) { timers.set(++serial, fn); return serial; }, clearInterval(id: number) { timers.delete(id); } } });
  const state = { active: true, trackId: "1", playbackStatus: "Playing", position: 30, duration: 100, volume: 0.8 } as TrackState;
  const volumes: number[] = [];
  const guards: (string | null)[] = [];
  let pauses = 0, prepared = 0, restored = 0;
  let volumeGate: Promise<void> | null = null;
  let guardFailure = false;
  const timer = new SleepTimer({
    state: async () => ({ ...state }),
    pause: async () => { pauses++; state.playbackStatus = "Paused"; },
    volume: async value => { if (volumeGate) await volumeGate; volumes.push(value); state.volume = value; },
    guard: async id => { guards.push(id); if (id && guardFailure) throw new Error("guard failed"); },
    prepareEnd: () => { prepared++; }, restoreEnd: () => { restored++; }, fadeSeconds: () => 10,
  });
  return { timer, state, volumes, guards, timers, pauses: () => pauses, prepared: () => prepared, restored: () => restored,
    advance(ms: number) { now += ms; }, holdVolume(value: Promise<void> | null) { volumeGate = value; }, failGuard() { guardFailure = true; },
    async tick() { for (const fn of timers.values()) fn(); await flush(); },
  };
}
afterEach(() => { mock.restoreAll(); delete (globalThis as any).window; });

describe("sleep timer", () => {
  it("uses a deadline, fades, pauses and restores volume without leaving an interval", async () => {
    const p = setup(); await p.timer.start(1);
    p.advance(55000); await p.tick(); assert.equal(p.volumes[0], 0.4);
    assert.equal(p.timer.recoveryVolume(p.state.volume!), 0.8);
    p.advance(5000); await p.tick();
    assert.equal(p.pauses(), 1); assert.equal(p.state.volume, 0.8);
    assert.equal(p.timer.snapshot().mode, "off"); assert.equal(p.timers.size, 0);
    assert.match(p.timer.snapshot().status, /已按定时/);
  });
  it("finishes the selected track and restores transition policy", async () => {
    const p = setup(); await p.timer.start("track");
    assert.equal(p.prepared(), 1); assert.equal(p.guards.at(-1), "1");
    p.state.position = 99.9; await p.tick();
    assert.equal(p.pauses(), 1); assert.equal(p.restored(), 1); assert.equal(p.guards.at(-1), null);
  });
  it("stops if a native track switch wins the race", async () => {
    const p = setup(); await p.timer.start("track"); p.state.trackId = "2"; await p.tick(); assert.equal(p.pauses(), 1);
  });
  it("restores volume when seeking back out of the fade window", async () => {
    const p = setup(); await p.timer.start("track"); p.state.position = 95; await p.tick();
    assert.equal(p.state.volume, 0.4); p.state.position = 50; await p.tick(); assert.equal(p.state.volume, 0.8);
    await p.timer.cancel(); assert.equal(p.pauses(), 0);
  });
  it("serializes cancellation and rearming after an in-flight fade", async () => {
    const p = setup(); await p.timer.start(1); p.advance(55000);
    let release!: () => void; p.holdVolume(new Promise(resolve => { release = resolve; }));
    await p.tick(); const cancel = p.timer.cancel(); const rearm = p.timer.start(2);
    release(); p.holdVolume(null); await Promise.all([cancel, rearm]);
    assert.deepEqual(p.volumes, [0.4, 0.8]); assert.equal(p.timer.snapshot().mode, "countdown");
    assert.equal(p.timer.snapshot().remaining, 120); assert.equal(p.pauses(), 0); assert.equal(p.timers.size, 1);
  });
  it("cleans up failed guards instead of leaving an armed timer", async () => {
    const p = setup(); p.failGuard(); await p.timer.start("track");
    assert.equal(p.timer.snapshot().mode, "off"); assert.equal(p.timers.size, 0); assert.equal(p.guards.at(-1), null);
    assert.match(p.timer.snapshot().status, /guard failed/);
  });
  it("ignores an older start request and rejects invalid timer values", async () => {
    const p = setup(); await Promise.all([p.timer.start(1), p.timer.start(2)]);
    assert.equal(p.timer.snapshot().remaining, 120); assert.equal(p.timers.size, 1);
    await p.timer.start(NaN); assert.equal(p.timer.snapshot().mode, "off"); assert.equal(p.timers.size, 0);
  });
});
