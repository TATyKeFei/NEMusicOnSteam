import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { QUEUE_TRACKS_SCRIPT, queueApplyScript, queueUrlsScript } from "./queue-sort-player.ts";

type Entry = { resourceType: string; resourceId: string; track: { id: number; name: string; ar: { name: string }[] } };

function entry(id: number, name = `Song ${id}`, resourceType = "track"): Entry {
  return { resourceType, resourceId: String(id), track: { id, name, ar: [{ name: "Artist" }] } };
}

function fixture(list: Entry[], current = "1", mode = "playOrder") {
  const state = {
    playing: { resourceTrackId: current, playingMode: mode, playingVolume: 0.5, resourceDuration: 100, curPlaying: { resourceId: current } },
    playingList: { curPlayingList: list },
    "async:listenTogether": { status: "alone", roomInfo: {} as { roomId?: string } },
  };
  const dispatched: Array<{ type: string; payload: { curPlayingList: Entry[] } }> = [];
  const store = { getState: () => state, dispatch: (action: { type: string; payload: { curPlayingList: Entry[] } }) => { dispatched.push(action); return action; } };
  const context = { document: { querySelectorAll: () => [], querySelector: () => null },
    __NEMusicOnSteamPlayerStore: store, __NEMusicOnSteamPlayerStoreSource: {} };
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return { state, context, dispatched, store,
    tracks: () => plain(runInNewContext(QUEUE_TRACKS_SCRIPT, context)) as { ok: boolean; reason?: string; index?: number; total?: number; wrap?: boolean; tracks?: Array<{ id: string; name: string; artist: string; sortable: boolean }> },
    apply: async (order: string[], wrap = false) => plain(await runInNewContext(queueApplyScript(order, wrap), context)) as { ok: boolean; reason?: string; count?: number },
  };
}

describe("smart queue sorting page access", () => {
  it("reads only the tracks after the current one and marks local items unsortable", () => {
    const page = fixture([entry(1), entry(2), entry(3, "", "local"), entry(4), entry(5, "本地文件", "local")]);
    const result = page.tracks();
    assert.equal(result.ok, true);
    assert.deepEqual(result.tracks, [
      { id: "2", name: "Song 2", artist: "Artist", sortable: true },
      { id: "3", name: "", artist: "Artist", sortable: false },
      { id: "4", name: "Song 4", artist: "Artist", sortable: true },
      { id: "5", name: "本地文件", artist: "Artist", sortable: false },
    ]);
  });

  it("treats the whole list as the tail when the current track is missing", () => {
    const page = fixture([entry(2), entry(3)], "999");
    const result = page.tracks();
    assert.equal(result.ok, true);
    assert.deepEqual(result.tracks?.map(track => track.id), ["2", "3"]);
  });

  it("wraps the upcoming range to the beginning when a cycling queue sits on its last track", () => {
    const page = fixture([entry(1), entry(2), entry(3)], "3", "playCycle");
    const result = page.tracks();
    assert.equal(result.ok, true);
    assert.deepEqual(result.tracks?.map(track => track.id), ["1", "2"]);
    assert.equal(result.index, 2);
    assert.equal(result.total, 3);
    assert.equal(result.wrap, true);
    // 顺序播放停在末尾时没有回绕：待播为空、不带回绕标记。
    const ordered = fixture([entry(1), entry(2), entry(3)], "3", "playOrder");
    assert.deepEqual(ordered.tracks().tracks, []);
    assert.equal(ordered.tracks().wrap, false);
  });

  it("blocks rooms, shuffle and single repeat", async () => {
    for (const mode of ["playRandom", "playOneCycle", "playFm", "playAi"]) {
      assert.equal(fixture([entry(1), entry(2)], "1", mode).tracks().ok, false);
    }
    const room = fixture([entry(1), entry(2)]);
    room.state["async:listenTogether"].status = "togetherOwner";
    assert.equal(room.tracks().ok, false);
    assert.equal((await room.apply(["2"])).ok, false);
  });

  it("reorders the tail through the player's own playing list action", async () => {
    const page = fixture([entry(1), entry(2), entry(3), entry(4)]);
    const result = await page.apply(["4", "3", "2"]);
    assert.deepEqual(result, { ok: true, count: 3 });
    assert.equal(page.dispatched.length, 1);
    assert.equal(page.dispatched[0].type, "playingList/onUpdate");
    assert.deepEqual(page.dispatched[0].payload.curPlayingList.map(item => item.track.id), [1, 4, 3, 2]);
  });

  it("applies a wrapped order without touching the current track", async () => {
    const page = fixture([entry(1), entry(2), entry(3)], "3", "playCycle");
    const result = await page.apply(["2", "1"], true);
    assert.deepEqual(result, { ok: true, count: 2 });
    assert.deepEqual(page.dispatched[0].payload.curPlayingList.map(item => item.track.id), [2, 1, 3]);
  });

  it("refuses a wrap mismatch between reading and applying", async () => {
    const page = fixture([entry(1), entry(2), entry(3)], "3", "playCycle");
    assert.equal((await page.apply(["1", "2"])).ok, false);          // 读的时候没有回绕
    const ordered = fixture([entry(1), entry(2), entry(3)], "3", "playOrder");
    assert.equal((await ordered.apply(["1", "2"], true)).ok, false); // 读的时候要求回绕
    assert.equal(page.dispatched.length, 0);
    assert.equal(ordered.dispatched.length, 0);
  });

  it("keeps duplicate ids stable while rebuilding", async () => {
    const page = fixture([entry(1), entry(2, "First"), entry(3), entry(2, "Second")]);
    const result = await page.apply(["2", "3", "2"]);
    assert.equal(result.ok, true);
    assert.deepEqual(page.dispatched[0].payload.curPlayingList.map(item => item.track.name), ["Song 1", "First", "Song 3", "Second"]);
  });

  it("refuses to apply a stale order", async () => {
    const page = fixture([entry(1), entry(2), entry(3)]);
    assert.equal((await page.apply(["2"])).ok, false);            // 长度对不上：队列变了
    assert.equal((await page.apply(["3", "9"])).ok, false);       // 旧结果里出现了已不在队列的歌
    assert.equal((await page.apply(["3", "2"])).ok, true);        // 合法置换可以应用
    page.state.playingList.curPlayingList.push(entry(4));
    assert.equal((await page.apply(["3", "2"])).ok, false);       // 应用前队列又变了
    assert.equal(page.dispatched.length, 1);
  });

  it("resolves playable urls in one batch request", async () => {
    const calls: string[] = [];
    const context = { fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ data: [
        { id: 2, url: "https://audio.example/2.mp3" },
        { id: 3, url: "" },
        { id: 4, url: "https://audio.example/4.mp3" },
      ] }) };
    } };
    const urls = JSON.parse(JSON.stringify(await runInNewContext(queueUrlsScript(["2", "3", "4"]), context)));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /ids=/);
    assert.match(calls[0], /level=standard/);
    assert.deepEqual(urls, { "2": "https://audio.example/2.mp3", "4": "https://audio.example/4.mp3" });
    const failing = { fetch: async () => { throw new Error("offline"); } };
    assert.deepEqual(JSON.parse(JSON.stringify(await runInNewContext(queueUrlsScript(["2"]), failing))), {});
  });
});
