import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { PLAYER_ACCESS_SCRIPT } from "./player-access.ts";

function store(id: string) {
  return { getState: () => ({ id, playing: { resourceDuration: 200 } }), dispatch: () => {} };
}

describe("播放器 Redux store 定位", () => {
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
