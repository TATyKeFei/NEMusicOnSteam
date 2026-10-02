import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
  type TogetherState,
} from "./together-player.ts";

/** vm 里造出来的对象原型和测试进程不是一回事，深比较前先拍平。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type FixtureOptions = {
  playing?: Record<string, unknown>;
  host?: Record<string, unknown>;
  together?: Record<string, unknown>;
  togetherList?: Record<string, unknown>;
  store?: unknown;
};

/**
 * 页面脚本靠 React fiber 上的 store 找自己，所以这里照 download-player.test.ts 的做法
 * 挂一个只有 getState/dispatch 的假 store。这套测试只能验证脚本自己的判断逻辑，
 * 网易云是否认这些 action 得在真机上验。
 */
function fixture(options: FixtureOptions = {}) {
  const state: Record<string, unknown> = {
    playing: {
      resourceTrackId: 1900172235,
      resourceDuration: 200,
      resourcePosition: 30.5,
      playingState: 2,
      curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } },
      ...options.playing,
    },
    // host 整体替换而不是合并：要测「未登录」就必须能真的把 uid 拿掉。
    host: options.host ?? { uid: 10001, isAnonymous: false, avatarUrl: "https://img/host.png" },
    playingList: { curPlayingList: [{ resourceId: 1900172235, track: { id: 1900172235 } }] },
    "async:listenTogether": { status: "alone", ...options.together },
    "async:listenTogetherPlayList": options.togetherList ?? {},
  };
  const dispatched: { type: string; payload?: unknown }[] = [];
  const store = options.store ?? {
    getState: () => state,
    dispatch: (action: { type: string; payload?: unknown }) => {
      dispatched.push(action);
      return action;
    },
  };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const context = {
    document: { querySelector: () => null, querySelectorAll: (selector: string) => (selector.includes("#root > *") ? [root] : []) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  const run = <T>(script: string) => plain(runInNewContext(script, context)) as T;
  return { state, dispatched, run };
}

/** 只填房间状态那一块，其余保持默认。 */
function room(together: Record<string, unknown>, rest: FixtureOptions = {}) {
  return fixture({ together, ...rest });
}

describe("一起听房间状态", () => {
  it("读出 host uid 和房间状态", () => {
    const state = room({
      status: "togetherOwner",
      roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: "10001" },
    }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.supported, true);
    assert.equal(state.loggedIn, true);
    assert.equal(state.accountId, "10001");
    assert.equal(state.status, "togetherOwner");
    assert.equal(state.inRoom, true);
    assert.equal(state.isHost, true);
    assert.equal(state.roomId, "123456");
    assert.equal(state.chatRoomId, "chat-9");
  });

  it("没登录时不算自己人", () => {
    // uid 为 0 也要归一成空串，不然调用方会拿到一个看起来像 id 的 "0"。
    for (const host of [{ uid: 0 }, { uid: 10001, isAnonymous: true }, {}]) {
      const state = room({}, { host }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
      assert.equal(state.loggedIn, false, JSON.stringify(host));
      assert.equal(state.accountId, host.uid ? "10001" : "", JSON.stringify(host));
    }
  });

  it("房间外的各种状态都不算在房间里", () => {
    for (const status of ["alone", "waiting", "timeout", "opening", "closing", "closed", "", undefined]) {
      const state = room(status === undefined ? {} : { status }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
      assert.equal(state.inRoom, false, String(status));
      assert.equal(state.isHost, false, String(status));
    }
  });

  it("房间成员逐个归一化成字符串", () => {
    const state = room({
      status: "together",
      roomMembers: [
        { userId: 10002, nickname: "小明", avatarUrl: "a.png" },
        { userId: 10003, nickname: "小红" },
        { nickname: "没有 id 的要丢掉" },
        null,
      ],
    }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.deepEqual(state.members, [
      { userId: "10002", nickname: "小明", avatarUrl: "a.png" },
      { userId: "10003", nickname: "小红", avatarUrl: "" },
    ]);
  });

  it("房主昵称和头像从 roomMembers 里找", () => {
    const state = room({
      status: "together",
      roomMembers: [
        { userId: 10001, nickname: "我", avatarUrl: "me.png" },
        { userId: 10002, nickname: "小明", avatarUrl: "a.png" },
      ],
    }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.hostNickname, "我");
    assert.equal(state.hostAvatarUrl, "me.png");
  });

  it("房间里只有别人时，hostUid 退回 slice 里的值", () => {
    const state = room(
      { status: "together", hostUid: 10002, roomMembers: [{ userId: 10002, nickname: "小明" }] },
      { host: { uid: 0 } },
    ).run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.loggedIn, false);
    assert.equal(state.accountId, "10002");
    assert.equal(state.hostNickname, "小明");
  });

  it("队列从页面自己的 listenTogetherPlayList 里读，两种条目形状都要认", () => {
    const state = room({}, {
      togetherList: {
        playingList: [{ track: { id: 111 } }, { resourceId: "222" }, { id: 333 }, { track: { id: 111 } }, null],
      },
    }).run<TogetherState>(TOGETHER_STATE_SCRIPT);
    // 重复的 111 只留一次：存的是字符串，去重也得拿字符串比。
    assert.deepEqual(state.songIds, ["111", "222", "333"]);
  });

  it("房间队列缺失时退回 curPlayingList", () => {
    const state = room({}, { togetherList: { curPlayingList: [{ track: { id: 999 } }] } })
      .run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.deepEqual(state.songIds, ["999"]);
  });

  it("播放进度换算成毫秒", () => {
    assert.equal(room({}, { playing: { resourcePosition: 30.5 } }).run<TogetherState>(TOGETHER_STATE_SCRIPT).positionMs, 30500);
    assert.equal(room({}, { playing: { resourcePosition: "bad" } }).run<TogetherState>(TOGETHER_STATE_SCRIPT).positionMs, 0);
    assert.equal(room({}, { playing: { resourcePosition: -5 } }).run<TogetherState>(TOGETHER_STATE_SCRIPT).positionMs, 0);
  });

  it("本地歌曲标出来，不能分享给房间里的人", () => {
    assert.equal(room({}).run<TogetherState>(TOGETHER_STATE_SCRIPT).localOnly, false);
    for (const playing of [{ trackFileType: "local" }, { resourceType: "localTrack" }]) {
      assert.equal(room({}, { playing }).run<TogetherState>(TOGETHER_STATE_SCRIPT).localOnly, true, JSON.stringify(playing));
    }
  });

  it("拿不到 store 时不支持，但不会抛", () => {
    const state = room({}, { store: { getState: () => ({}), dispatch: () => {} } })
      .run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.supported, false);
    assert.deepEqual(state.members, []);
    assert.deepEqual(state.songIds, []);
    assert.equal(state.currentSongId, "");
  });
});

describe("建房", () => {
  it("派发 startListenTogether 并带上当前这首歌", () => {
    const { dispatched, run } = room({});
    assert.deepEqual(run(TOGETHER_START_SCRIPT), { ok: true });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, "async:listenTogether/startListenTogether");
    const payload = dispatched[0].payload as { target: { trackId?: number }; refer: string };
    assert.equal(payload.refer, "songplay_more");
    assert.equal(payload.target.trackId, 1900172235);
  });

  it("curPlaying 不在时自己拼一个 target", () => {
    const { dispatched, run } = room({}, { playing: { curPlaying: null } });
    assert.equal(run<{ ok: boolean }>(TOGETHER_START_SCRIPT).ok, true);
    const payload = dispatched[0].payload as { target: Record<string, unknown> };
    assert.equal(payload.target.trackId, 1900172235);
    assert.equal(payload.target.resourceId, "1900172235");
    assert.equal(payload.target.resourceType, "track");
  });

  it("没登录就拒，不派发任何 action", () => {
    for (const host of [{ uid: 0 }, { uid: 10001, isAnonymous: true }]) {
      const { dispatched, run } = room({}, { host });
      const result = run<{ ok: boolean; error: string }>(TOGETHER_START_SCRIPT);
      assert.equal(result.ok, false, JSON.stringify(host));
      assert.match(result.error, /登录/);
      assert.deepEqual(dispatched, []);
    }
  });

  it("没在播歌就拒", () => {
    // resourceTrackId 和 curPlaying 要一起清掉，只清一个的话另一个还留着上一首的痕迹。
    for (const playing of [{ resourceTrackId: 0, curPlaying: null }, { resourceTrackId: "", curPlaying: null, resourceType: "" }]) {
      const { dispatched, run } = room({}, { playing });
      const result = run<{ ok: boolean; error: string }>(TOGETHER_START_SCRIPT);
      assert.equal(result.ok, false, JSON.stringify(playing));
      assert.match(result.error, /播放/);
      assert.deepEqual(dispatched, []);
    }
  });

  it("本地歌曲直接拒，网易云自己也会拒但我们先给句人话", () => {
    for (const playing of [{ trackFileType: "local" }, { resourceType: "localTrack" }]) {
      const { dispatched, run } = room({}, { playing });
      const result = run<{ ok: boolean; error: string }>(TOGETHER_START_SCRIPT);
      assert.equal(result.ok, false, JSON.stringify(playing));
      assert.match(result.error, /本地/);
      assert.deepEqual(dispatched, []);
    }
  });

  it("拿不到 store 时不炸", () => {
    const { dispatched, run } = room({}, { store: { getState: () => ({}), dispatch: () => {} } });
    const result = run<{ ok: boolean; error: string }>(TOGETHER_START_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
    assert.deepEqual(dispatched, []);
  });
});

describe("退房与恢复", () => {
  it("退房派发 leaveListenTogether", () => {
    const { dispatched, run } = room({ status: "togetherOwner" });
    assert.deepEqual(run(TOGETHER_LEAVE_SCRIPT), { ok: true });
    assert.equal(dispatched[0].type, "async:listenTogether/leaveListenTogether");
  });

  it("本来就不在房间里就别去打扰服务端", () => {
    for (const status of ["alone", "", undefined]) {
      const { dispatched, run } = room(status === undefined ? {} : { status });
      assert.deepEqual(run(TOGETHER_LEAVE_SCRIPT), { ok: true }, String(status));
      assert.deepEqual(dispatched, [], String(status));
    }
  });

  it("恢复派发 restore", () => {
    const { dispatched, run } = room({});
    assert.deepEqual(run(TOGETHER_RESTORE_SCRIPT), { ok: true });
    assert.equal(dispatched[0].type, "async:listenTogether/restore");
  });

  it("拿不到 store 时两个脚本都只是报错", () => {
    const empty = { getState: () => ({}), dispatch: () => {} };
    for (const script of [TOGETHER_LEAVE_SCRIPT, TOGETHER_RESTORE_SCRIPT]) {
      const result = room({}, { store: empty }).run<{ ok: boolean; error: string }>(script);
      assert.equal(result.ok, false);
      assert.match(result.error, /还没准备好/);
    }
  });
});
