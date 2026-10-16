import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { PLAYER_ACCESS_SCRIPT, SNAPSHOT_SCRIPT } from "./player-access.ts";

function store(id: string) {
  return { getState: () => ({ id, playing: { resourceDuration: 200 } }), dispatch: () => {} };
}

describe("播放器 Redux store 定位", () => {
  it("快照以歌曲 ID 区分同名曲目", () => {
    const playing = { resourceTrackId: "123", resourceDuration: 100 };
    const source = { getState: () => ({ playing }), dispatch: () => {} };
    const context = createContext({
      document: { querySelectorAll: () => [], querySelector: () => null },
      navigator: { mediaSession: { metadata: { title: "Same", artist: "Artist" } } },
      __NEMusicOnSteamPlayerStore: source, __NEMusicOnSteamPlayerStoreSource: {},
    });
    assert.equal(runInContext(SNAPSHOT_SCRIPT, context).trackId, "123");
    playing.resourceTrackId = "456";
    assert.equal(runInContext(SNAPSHOT_SCRIPT, context).trackId, "456");
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
