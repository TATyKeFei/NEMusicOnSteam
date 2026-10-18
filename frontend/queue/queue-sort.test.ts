import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { orderQueue } from "./queue-order.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./queue-sort.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const until = async (predicate: () => boolean) => {
  for (let index = 0; index < 100 && !predicate(); index++) await flush();
  assert.ok(predicate(), "等待的排序流程没有完成");
};

type Bridge = { setEnabled: (enabled: boolean) => void; tick: () => Promise<void> };
type Track = { id: string; name: string; artist: string; sortable: boolean };
type Feature = { bpm: number | null; energy: number | null; key: string | null };

function fixture() {
  const evaluations: string[] = [];
  const timers = new Map<number, () => void>();
  const analyzeCalls: Array<Array<{ trackId: string; url: string }>> = [];
  let action: string | null = null;
  let installed = true;
  let available = true;
  let tracksResult: unknown = null;
  let applyResult: unknown = { ok: true, count: 3 };
  let analyzeHook: (() => void) | null = null;
  let analyzeError = "";
  let pageTracks: Track[] = [];
  const urls: Record<string, string> = {};
  const features: Record<string, Feature> = {};
  const BridgeClass = runInNewContext(`${source}; QueueSortBridge`, {
    Error,
    orderQueue,
    QUEUE_TRACKS_SCRIPT: "tracks",
    queueUrlsScript: (ids: string[]) => `urls:${ids.join(",")}`,
    queueApplyScript: (order: string[], wrap: boolean) => `apply:${order.join(",")}${wrap ? "!wrap" : ""}`,
    queueSortButtonScript: (enabled: boolean) => `install:${enabled}`,
    queueSortButtonUpdateScript: (enabled: boolean) => `update:${enabled}`,
    queueSortButtonStatusScript: (message: string) => `status:${message}`,
    queueSortButtonResultScript: (message: string) => `result:${message}`,
    window: { setInterval: (callback: () => void) => { timers.set(1, callback); return 1; },
      clearInterval: (id: number) => { timers.delete(id); } },
  }) as new (options: unknown) => Bridge;
  const bridge = new BridgeClass({
    available: () => available,
    analyze: async (tracks: Array<{ trackId: string; url: string }>) => {
      analyzeCalls.push(JSON.parse(JSON.stringify(tracks)));
      analyzeHook?.();
      if (analyzeError) throw new Error(analyzeError);
      return { tracks: tracks.map(track => ({ trackId: track.trackId, ...(features[track.trackId] ?? { bpm: null, energy: null, key: null }) })) };
    },
    evaluate: async (script: string) => {
      evaluations.push(script);
      if (script.startsWith("install:") || script.startsWith("update:")) {
        if (script.endsWith("false")) return { installed: false };
        if (script.startsWith("update:") && !installed) return { installed: false };
        installed = true;
        const request = action;
        action = null;
        return { installed: true, action: request };
      }
      if (script === "tracks") return tracksResult ?? { ok: true, tracks: pageTracks, index: 1, total: pageTracks.length + 1 };
      if (script.startsWith("urls:")) {
        const ids = script.slice("urls:".length).split(",").filter(Boolean);
        return Object.fromEntries(ids.filter(id => urls[id]).map(id => [id, urls[id]]));
      }
      if (script.startsWith("apply:")) return applyResult;
      return true;
    },
  });
  return {
    bridge, evaluations, timers, analyzeCalls,
    request: (name: string) => { action = name; },
    setAvailable: (value: boolean) => { available = value; },
    reload: () => { installed = false; },
    pageTracks: (tracks: Track[]) => { pageTracks = tracks; },
    tracksResult: (value: unknown) => { tracksResult = value; },
    applyResult: (value: unknown) => { applyResult = value; },
    urls: (map: Record<string, string>) => Object.assign(urls, map),
    features: (map: Record<string, Feature>) => Object.assign(features, map),
    duringAnalyze: (hook: (() => void) | null) => { analyzeHook = hook; },
    failAnalyze: (message: string) => { analyzeError = message; },
  };
}

const track = (id: string, sortable = true): Track => ({ id, name: `Song ${id}`, artist: "Artist", sortable });
const feature = (bpm: number, key: string | null = null, energy: number | null = null): Feature => ({ bpm, key, energy });

describe("smart queue sorting bridge", () => {
  it("installs the button only while the mpv backend is available", async () => {
    const player = fixture();
    player.setAvailable(false);
    player.bridge.setEnabled(true);
    await flush();
    assert.equal(player.evaluations[0], "install:false");
    player.setAvailable(true);
    await player.bridge.tick();
    assert.equal(player.evaluations.at(-1), "install:true");
    assert.equal(player.timers.size, 1);
  });

  it("analyzes the queue once and applies the chained order", async () => {
    const player = fixture();
    player.pageTracks([track("2"), track("3"), track("4")]);
    player.urls({ "2": "u2", "3": "u3", "4": "u4" });
    player.features({ "2": feature(90, "8B", 0.4), "3": feature(140, "3A", 0.9), "4": feature(92, "8B", 0.42) });
    player.applyResult({ ok: true, count: 3 });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.equal(player.analyzeCalls.length, 1);
    assert.deepEqual(player.analyzeCalls[0], [{ trackId: "2", url: "u2" }, { trackId: "3", url: "u3" }, { trackId: "4", url: "u4" }]);
    // 90 → 92 → 140：链子不跳拍，紧邻的 8B 先走。
    assert.ok(player.evaluations.includes("apply:2,4,3"));
    assert.ok(player.evaluations.includes("result:已按节奏与调性重排 3 首待播歌曲"));
  });

  it("splits long queues into batches and reports progress", async () => {
    const player = fixture();
    const ids = ["2", "3", "4", "5", "6", "7", "8"];
    player.pageTracks(ids.map(id => track(id)));
    player.urls(Object.fromEntries(ids.map((id, index) => [id, `u${index}`])));
    player.features(Object.fromEntries(ids.map((id, index) => [id, feature(100 + index)])));
    player.applyResult({ ok: true, count: ids.length });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.deepEqual(player.analyzeCalls.map(call => call.length), [6, 1]);
    assert.ok(player.evaluations.includes("status:正在分析播放列表 6/7 首…"));
    assert.ok(player.evaluations.some(script => script.startsWith("apply:")));
  });

  it("keeps unsortable tracks in place and sends unanalyzed ones to the end", async () => {
    const player = fixture();
    player.pageTracks([track("11"), track("12", false), track("13"), track("14")]);
    player.urls({ "11": "u11", "13": "u13", "14": "u14" });
    player.features({ "11": feature(90), "13": feature(140), "14": feature(92) });
    player.applyResult({ ok: true, count: 4 });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    // 12 是不可分析条目：留在原位（下标 1），11→14→13 按链重排填进剩余槽位。
    assert.ok(player.evaluations.includes("apply:11,12,14,13"));
    assert.equal(player.evaluations.some(script => script.startsWith("status:")), false);
    assert.ok(player.evaluations.includes("result:已按节奏与调性重排 3 首待播歌曲"));
  });

  it("reports the page gate instead of touching the queue", async () => {
    const player = fixture();
    player.tracksResult({ ok: false, reason: "请先切到顺序或列表循环再排序" });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("result:没有重排：请先切到顺序或列表循环再排序"));
    assert.equal(player.evaluations.some(script => script.startsWith("urls:") || script.startsWith("apply:")), false);
    assert.equal(player.analyzeCalls.length, 0);
  });

  it("does not touch the queue when there are too few sortable tracks", async () => {
    const player = fixture();
    player.pageTracks([track("2"), track("3", false)]);
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("result:待播列表里没有足够的歌曲可以排序（队列共 3 首，正在播放第 2 首）"));
    assert.equal(player.analyzeCalls.length, 0);
  });

  it("reports the real queue position when the tail is empty", async () => {
    const player = fixture();
    player.tracksResult({ ok: true, tracks: [track("2")], index: 9, total: 10 });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("result:待播列表里没有足够的歌曲可以排序（队列共 10 首，正在播放第 10 首）"));
    const missing = fixture();
    missing.tracksResult({ ok: true, tracks: [track("2")], index: -1, total: 10 });
    missing.bridge.setEnabled(true);
    await flush();
    missing.request("sort");
    await missing.bridge.tick();
    await until(() => missing.evaluations.some(script => script.startsWith("result:")));
    assert.ok(missing.evaluations.includes("result:待播列表里没有足够的歌曲可以排序（队列共 10 首，没找到正在播放的曲目）"));
  });

  it("passes the wrap marker through when a cycling queue sits on its last track", async () => {
    const player = fixture();
    player.tracksResult({ ok: true, tracks: [track("2"), track("3")], index: 4, total: 5, wrap: true });
    player.urls({ "2": "u2", "3": "u3" });
    player.features({ "2": feature(90), "3": feature(92) });
    player.applyResult({ ok: true, count: 2 });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("apply:2,3!wrap"));
    assert.ok(player.evaluations.includes("result:已按节奏与调性重排 2 首待播歌曲"));
  });

  it("stops quietly when the player closes mid-analysis and still accepts clicks after reopening", async () => {
    const player = fixture();
    player.pageTracks([track("2"), track("3")]);
    player.urls({ "2": "u2", "3": "u3" });
    player.features({ "2": feature(90), "3": feature(92) });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    player.duringAnalyze(() => player.bridge.setEnabled(false));
    await player.bridge.tick();
    await flush();
    await flush();
    assert.equal(player.evaluations.some(script => script.startsWith("apply:") || script.startsWith("result:")), false);
    assert.equal(player.timers.size, 0);
    // 重开播放器后排序必须还能用：中途放弃的流程不能把按钮锁死。
    player.duringAnalyze(null);
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.some(script => script.startsWith("apply:")));
  });

  it("surfaces backend failures and lets the next click retry", async () => {
    const player = fixture();
    player.pageTracks([track("2"), track("3")]);
    player.urls({ "2": "u2", "3": "u3" });
    player.failAnalyze("mpv 后端未连接，无法分析歌曲");
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("result:排序失败：mpv 后端未连接，无法分析歌曲"));
    assert.equal(player.evaluations.some(script => script.startsWith("apply:")), false);
  });

  it("keeps the page order when the apply script rejects the stale result", async () => {
    const player = fixture();
    player.pageTracks([track("2"), track("3")]);
    player.urls({ "2": "u2", "3": "u3" });
    player.features({ "2": feature(90), "3": feature(92) });
    player.applyResult({ ok: false, reason: "播放列表已经变化，请重试" });
    player.bridge.setEnabled(true);
    await flush();
    player.request("sort");
    await player.bridge.tick();
    await until(() => player.evaluations.some(script => script.startsWith("result:")));
    assert.ok(player.evaluations.includes("result:没有重排：播放列表已经变化，请重试"));
  });
});
