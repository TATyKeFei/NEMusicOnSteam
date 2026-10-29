import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { PLAYER_ACCESS_SCRIPT, SNAPSHOT_SCRIPT } from "./player-access.ts";

function store(id: string) {
  return { getState: () => ({ id, playing: { resourceDuration: 200 } }), dispatch: () => {} };
}

function snapshotFixture(playing: Record<string, any> | null) {
  const source = { getState: () => ({ playing }), dispatch: () => {} };
  const metadata = { title: "旧歌", artist: "旧歌手", album: "旧专辑", artwork: [{ src: "https://example.com/old.jpg" }] };
  const media = { paused: false, ended: false, readyState: 4, duration: 100, currentTime: 1, playbackRate: 1 };
  const context = createContext({
    document: { querySelectorAll: (selector: string) => selector === "audio, video" ? [media] : [], querySelector: () => null },
    navigator: { mediaSession: { metadata } },
    __NEMusicOnSteamPlayerStore: source, __NEMusicOnSteamPlayerStoreSource: {},
  });
  return { read: () => runInContext(SNAPSHOT_SCRIPT, context), metadata };
}

describe("播放器 Redux store 定位", () => {
  it("快照以歌曲 ID 区分同名曲目", () => {
    const playing = { resourceTrackId: "123", resourceDuration: 100, resourceName: "Same", resourceArtists: [{ name: "Artist" }] };
    const { read } = snapshotFixture(playing);
    assert.equal(read().trackId, "123");
    playing.resourceTrackId = "456";
    assert.equal(read().trackId, "456");
    assert.equal(read().title, "Same");
  });
  it("React 节点换 store 后不沿用旧缓存", () => {
    const first = store("first");
    const second = store("second");
    const root = { __reactFiber$test: { memoizedProps: { store: first } } };
    const context = createContext({ document: { querySelectorAll: () => [root] } });
    const current = () => runInContext(`(() => { ${PLAYER_ACCESS_SCRIPT} return playerStore?.getState().id; })()`, context);
    assert.equal(current(), "first");
    root.__reactFiber$test.memoizedProps.store = second;
    assert.equal(current(), "second");
  });

  it("其他脚本主动更新全局缓存时采用新 store", () => {
    const original = store("original");
    const replacement = store("replacement");
    const root = { __reactFiber$test: { memoizedProps: { store: original } } };
    const context = createContext({ document: { querySelectorAll: () => [root] } });
    const current = () => runInContext(`(() => { ${PLAYER_ACCESS_SCRIPT} return playerStore?.getState().id; })()`, context);
    assert.equal(current(), "original");
    (context as Record<string, unknown>).__NEMusicOnSteamPlayerStore = replacement;
    assert.equal(current(), "replacement");
  });
});

describe("网页切歌元数据", () => {
  it("媒体会话还停在上一首时，新 ID 对应新歌的名称、歌手、专辑与封面", () => {
    const playing = {
      resourceTrackId: "123", resourceDuration: 100, resourceName: "旧歌",
      resourceArtists: [{ name: "旧歌手" }], resourceCoverUrl: "https://example.com/old.jpg",
      curPlaying: { resourceId: "123", track: { name: "旧歌", album: { name: "旧专辑" } } },
    };
    const { read, metadata } = snapshotFixture(playing);
    assert.equal(read().title, "旧歌");
    Object.assign(playing, {
      resourceTrackId: "456", resourceName: "新歌", resourceArtists: [{ name: "新歌手" }, { name: "合唱歌手" }],
      resourceCoverUrl: "https://example.com/new.jpg",
      curPlaying: { resourceId: "456", track: { name: "新歌", album: { name: "新专辑" } } },
    });
    const snapshot = read();
    assert.equal(metadata.title, "旧歌");
    assert.equal(snapshot.playbackStatus, "Playing");
    assert.equal(snapshot.trackId, "456");
    assert.equal(snapshot.title, "新歌");
    assert.equal(snapshot.artist, "新歌手 / 合唱歌手");
    assert.equal(snapshot.album, "新专辑");
    assert.equal(snapshot.artUrl, "https://example.com/new.jpg");
  });

  it("原生信息未就绪时不把旧歌元数据拼到新 ID 上", () => {
    const playing = {
      resourceTrackId: "456", resourceDuration: 100,
      curPlaying: { resourceId: "123", track: { name: "旧歌" } },
      curTrack: { id: "123", name: "旧歌", album: { name: "旧专辑" } },
    };
    const { read } = snapshotFixture(playing);
    const snapshot = read();
    assert.equal(snapshot.trackId, "456");
    for (const field of ["title", "artist", "album", "artUrl"]) assert.equal(snapshot[field], "");
  });

  it("新歌没有歌手、专辑、封面时不使用旧媒体会话中的值", () => {
    const { read } = snapshotFixture({ resourceTrackId: "456", resourceDuration: 100, resourceName: "纯音乐", resourceArtists: [] });
    const snapshot = read();
    assert.equal(snapshot.title, "纯音乐");
    for (const field of ["artist", "album", "artUrl"]) assert.equal(snapshot[field], "");
  });

  it("切歌期间原生曲目被暂时清空时不回退到上一首媒体会话", () => {
    const { read } = snapshotFixture({ resourceTrackId: "", resourceDuration: 0, resourceName: "", resourceArtists: [], curPlaying: null });
    const snapshot = read();
    for (const field of ["trackId", "title", "artist", "album", "artUrl"]) assert.equal(snapshot[field], "");
  });

  it("识别曲目 ID 匹配的 curTrack 和 curPlaying 中的歌曲信息", () => {
    for (const fields of [
      { curTrack: { id: 456, name: "新歌", ar: [{ name: "歌手" }], al: { name: "专辑", picUrl: "cover" } } },
      { curPlaying: { trackId: "456", track: { name: "新歌", artists: [{ name: "歌手" }], album: { name: "专辑", picUrl: "cover" } } } },
    ]) {
      const { read } = snapshotFixture({ resourceTrackId: "456", resourceDuration: 100, ...fields });
      const snapshot = read();
      assert.equal(snapshot.title, "新歌");
      assert.equal(snapshot.artist, "歌手");
      assert.equal(snapshot.album, "专辑");
      assert.equal(snapshot.artUrl, "cover");
    }
  });

  it("没有原生歌曲 ID 的页面仍可读取媒体会话", () => {
    const { read } = snapshotFixture(null);
    const snapshot = read();
    assert.equal(snapshot.title, "旧歌");
    assert.equal(snapshot.artist, "旧歌手");
    assert.equal(snapshot.album, "旧专辑");
    assert.equal(snapshot.artUrl, "https://example.com/old.jpg");
    assert.equal(snapshot.trackId, "旧歌|旧歌手|旧专辑");
  });
});
