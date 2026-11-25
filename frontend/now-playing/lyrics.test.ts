import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { activeLyric, parseLyrics, playbackTime, songLyricsScript } from "./lyrics.ts";

describe("song panel lyrics", () => {
  it("sorts repeated timestamps, applies offsets and aligns translations", () => {
    const lines = parseLyrics("[ar:Artist]\n[offset:-500]\n[00:10.50][00:20.500]Hello\n[00:05]First\n[00:10.500]World\n[00:30]",
      "[offset:-500]\n[00:10.500]你好\n[00:20.5]你好");
    assert.deepEqual(lines, [
      { at: 4.5, text: "First", translation: "" },
      { at: 10, text: "Hello / World", translation: "你好" },
      { at: 20, text: "Hello", translation: "你好" },
    ]);
  });

  it("selects the current line while playing and after seeking backwards", () => {
    const lines = parseLyrics("[00:10]First\n[00:20]Second\n[00:30]Third");
    assert.equal(activeLyric(lines, 0), -1);
    assert.equal(activeLyric(lines, 10), 0);
    assert.equal(activeLyric(lines, 45), 2);
    assert.equal(activeLyric(lines, 15), 0);
    assert.equal(activeLyric([], 10), -1);
    assert.equal(playbackTime(181.9), "3:01");
    assert.equal(playbackTime(NaN), "0:00");
  });

  function fixture(payload: unknown = { code: 200, lrc: { lyric: "[00:01]Hello" }, tlyric: { lyric: "[00:01]你好" } }) {
    let trackId = "123", calls = 0;
    let response: (() => Promise<unknown>) = async () => payload;
    const store = { getState: () => ({ playing: { resourceTrackId: trackId, resourceDuration: 180 } }), dispatch() {} };
    const seed = { __reactFiber$test: { memoizedProps: { store } } };
    return {
      read: (id = "123") => runInNewContext(songLyricsScript(id), {
        document: { querySelectorAll: () => [seed] }, AbortController, setTimeout, clearTimeout,
        fetch: async (url: string, options: { credentials: string }) => {
          assert.equal(url, "/api/song/lyric?id=123&lv=-1&tv=-1&os=pc");
          assert.equal(options.credentials, "include");
          calls++;
          return { ok: true, json: () => response() };
        },
      }) as Promise<{ original: string; translated: string; instrumental: boolean } | null>,
      setTrack: (id: string) => { trackId = id; },
      setResponse: (next: typeof response) => { response = next; },
      calls: () => calls,
    };
  }

  it("reads original and translated lyrics and recognizes instrumentals", async () => {
    const result = await fixture().read();
    assert.equal(result?.original, "[00:01]Hello");
    assert.equal(result?.translated, "[00:01]你好");
    assert.equal((await fixture({ code: 200, nolyric: true }).read())?.instrumental, true);
  });

  it("rejects stale and invalid IDs before requesting lyrics", async () => {
    const source = fixture();
    assert.equal(await source.read("456"), null);
    assert.equal(await source.read("bad-id"), null);
    assert.equal(source.calls(), 0);
  });

  it("discards lyrics when the song changes during the request", async () => {
    const source = fixture();
    source.setResponse(async () => { source.setTrack("456"); return { code: 200, lrc: { lyric: "old" } }; });
    assert.equal(await source.read(), null);
    await assert.rejects(fixture({ code: 503 }).read());
  });
});
