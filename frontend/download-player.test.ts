import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_DOWNLOAD_QUALITY,
  downloadLevel,
  downloadScript,
  isDownloadQuality,
  songFileName,
  type DownloadSong,
} from "./download-player.ts";

const LEVELS: Record<number, { level: string; encodeType: string | null }> = {
  128: { level: "standard", encodeType: null },
  192: { level: "higher", encodeType: null },
  320: { level: "exhigh", encodeType: null },
  999: { level: "lossless", encodeType: "flac" },
  1999: { level: "hires", encodeType: "flac" },
  3999: { level: "jyeffect", encodeType: "flac" },
  4999: { level: "jymaster", encodeType: "flac" },
  5999: { level: "sky", encodeType: "flac" },
};

const API_RESULT = { url: "https://m701.music.126.net/song.mp3", type: "mp3", size: 4200, br: 320000, level: "exhigh" };
const PLAYING_STREAM = "https://m801.music.126.net/live.mp3";

type FixtureOptions = {
  payload?: unknown;
  currentSrc?: string;
  trackId?: unknown;
  curPlaying?: unknown;
  fetchThrows?: boolean;
};

function downloadFixture(options: FixtureOptions = {}) {
  const state = {
    playing: {
      resourceTrackId: "trackId" in options ? options.trackId : 12345,
      resourceDuration: 200,
      curPlaying:
        "curPlaying" in options
          ? options.curPlaying
          : { resourceId: 12345, name: "歌名", artists: [{ name: "歌手一" }, { name: "歌手二" }] },
    },
  };
  const requests: { url: string; init: unknown }[] = [];
  const media = { paused: false, currentTime: 30, duration: 200, readyState: 4, currentSrc: options.currentSrc ?? "" };
  const store = { getState: () => state, dispatch: async () => {} };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const context = {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector.includes("#root > *") ? [root] : selector === "audio, video" ? [media] : [],
    },
    navigator: { mediaSession: { metadata: {} } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    fetch: async (url: string, init: unknown) => {
      if (options.fetchThrows) throw new Error("network down");
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => options.payload ?? { code: 200, data: [API_RESULT] },
      };
    },
  };
  return {
    state,
    context,
    requests,
    run: (value: number, song?: DownloadSong) => runInNewContext(downloadScript(value, song), context),
  };
}

describe("NetEase download resolution", () => {
  it("maps every quality to a NetEase level and asks for flac only from lossless up", () => {
    for (const [value, expected] of Object.entries(LEVELS)) assert.deepEqual(downloadLevel(Number(value)), expected);
    for (const value of [0, 100000, NaN, Infinity]) assert.equal(downloadLevel(value), null);
    assert.equal(isDownloadQuality(DEFAULT_DOWNLOAD_QUALITY), true);
    assert.equal(isDownloadQuality(320.5), false);
    assert.equal(isDownloadQuality("320"), false);
    assert.equal(isDownloadQuality(NaN), false);
    assert.throws(() => downloadScript(0), /不支持/);
  });

  it("requests the chosen level from the API using the page session", async () => {
    const player = downloadFixture();
    await player.run(999);
    assert.equal(player.requests.length, 1);
    const { url, init } = player.requests[0];
    assert.match(url, /^\/api\/song\/enhance\/player\/url\/v1\?/);
    assert.match(url, /level=lossless/);
    assert.match(url, /encodeType=flac/);
    assert.match(url, /ids=%5B12345%5D/);
    assert.deepEqual(JSON.parse(JSON.stringify(init)), { credentials: "include" });
  });

  it("does not ask for flac on lossy levels", async () => {
    const player = downloadFixture();
    await player.run(320);
    assert.match(player.requests[0].url, /level=exhigh/);
    assert.doesNotMatch(player.requests[0].url, /encodeType/);
  });

  it("returns the API address together with the granted level and tags", async () => {
    const result = await downloadFixture().run(320);
    assert.equal(result.url, API_RESULT.url);
    assert.equal(result.type, "mp3");
    assert.equal(result.size, 4200);
    assert.equal(result.br, 320000);
    assert.equal(result.level, "exhigh");
    assert.equal(result.name, "歌名");
    assert.equal(result.artist, "歌手一, 歌手二");
    assert.equal(result.source, "api");
  });

  it("reports an unavailable song instead of failing silently", async () => {
    const player = downloadFixture({ payload: { code: 200, data: [{ url: null }] } });
    await assert.rejects(player.run(320), /无版权|VIP|未登录/);
  });

  it("surfaces the API status when the song is gone", async () => {
    const player = downloadFixture({ payload: { code: 404, data: [] } });
    await assert.rejects(player.run(320), /code 404/);
  });

  it("falls back to the stream that is already playing", async () => {
    const player = downloadFixture({ payload: { code: 200, data: [{ url: null }] }, currentSrc: PLAYING_STREAM });
    const result = await player.run(320);
    assert.equal(result.url, PLAYING_STREAM);
    assert.equal(result.source, "player");
  });

  it("survives a failed API call by using the playing stream", async () => {
    const player = downloadFixture({ currentSrc: PLAYING_STREAM, fetchThrows: true });
    assert.equal((await player.run(320)).source, "player");
  });

  it("never hands a blob, file, or empty stream to the backend", async () => {
    for (const currentSrc of ["blob:https://music.163.com/abc", "file:///tmp/a.mp3", ""]) {
      const player = downloadFixture({ payload: { code: 200, data: [{ url: null }] }, currentSrc });
      await assert.rejects(player.run(320), /没有返回可下载地址/);
    }
  });

  it("refuses to download when nothing is playing", async () => {
    const player = downloadFixture({ trackId: null, curPlaying: null });
    await assert.rejects(player.run(320), /没有正在播放/);
  });

  it("accepts a track id from either the playing state or the track itself", async () => {
    const player = downloadFixture({ trackId: "", curPlaying: { resourceId: "98765", name: "歌名", artists: [{ name: "歌手" }] } });
    await player.run(320);
    assert.match(player.requests[0].url, /ids=%5B98765%5D/);
  });
});

describe("NetEase download of a song picked from a list", () => {
  const SONG: DownloadSong = { id: 987654, name: "列表里的歌", artist: "列表里的歌手" };

  it("asks for the picked song instead of the playing one", async () => {
    const player = downloadFixture();
    const result = await player.run(320, SONG);
    assert.match(player.requests[0].url, /ids=%5B987654%5D/);
    assert.equal(result.name, "列表里的歌");
    assert.equal(result.artist, "列表里的歌手");
    assert.equal(result.source, "api");
  });

  it("still works when nothing is playing", async () => {
    const player = downloadFixture({ trackId: null, curPlaying: null });
    assert.match((await player.run(320, SONG)).url, /^https:/);
  });

  it("never falls back to the stream that happens to be playing", async () => {
    const player = downloadFixture({ payload: { code: 200, data: [{ url: null }] }, currentSrc: PLAYING_STREAM });
    await assert.rejects(player.run(320, SONG), /无版权|VIP|未登录/);
  });

  it("surfaces a gone song without downloading the playing one", async () => {
    const player = downloadFixture({ payload: { code: 404, data: [] }, currentSrc: PLAYING_STREAM });
    await assert.rejects(player.run(320, SONG), /code 404/);
  });

  it("refuses a song it cannot identify", async () => {
    for (const id of [0, -1, NaN]) {
      assert.throws(() => downloadScript(320, { ...SONG, id }), /没有认出/);
    }
    assert.throws(() => downloadScript(320, { ...SONG, name: "  " }), /没有认出/);
  });

  it("trims the tags that end up in the file name", async () => {
    const result = await downloadFixture().run(320, { id: 1, name: " 歌名 ", artist: " 歌手 " });
    assert.equal(songFileName(result.artist, result.name), "歌手 - 歌名");
  });
});

describe("download file names", () => {
  it("joins artist and title", () => {
    assert.equal(songFileName("歌手一, 歌手二", "歌名"), "歌手一, 歌手二 - 歌名");
  });

  it("falls back when NetEase has no tags", () => {
    assert.equal(songFileName("", ""), "未知歌手 - 未知歌曲");
    assert.equal(songFileName(null, undefined), "未知歌手 - 未知歌曲");
  });

  it("normalizes whitespace and control characters", () => {
    assert.equal(songFileName(" 歌手\n一 ", "歌\t名"), "歌手 一 - 歌 名");
  });

  it("leaves separators and length for the backend to enforce", () => {
    assert.equal(songFileName("a/b", "c"), "a/b - c");
  });
});
