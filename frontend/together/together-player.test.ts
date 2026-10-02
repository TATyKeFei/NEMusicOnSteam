import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
  TOGETHER_SYNC_ARM_SCRIPT,
  TOGETHER_SYNC_PULL_SCRIPT,
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
  /** 默认 dispatch 只记录不落库；需要模拟 effect 改 store 时用这个钩子。 */
  onDispatch?: (action: { type: string; payload?: unknown }) => void;
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
      options.onDispatch?.(action);
      return action;
    },
  };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const context = {
    document: { querySelector: () => null, querySelectorAll: (selector: string) => (selector.includes("#root > *") ? [root] : []) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    // 拉指令的脚本要 await 页面里的 setTimeout，vm context 默认没有这个全局。
    setTimeout,
  };
  const run = <T>(script: string) => plain(runInNewContext(script, context)) as T;
  // 拉指令脚本返回 Promise：等它跑完再拍平，普通 run 会把 Promise 直接 JSON 成 {}。
  const runAsync = async <T>(script: string): Promise<T> => plain(await runInNewContext(script, context)) as T;
  return { state, dispatched, run, runAsync };
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
  it("退房派发 leaveListenTogether 并带 silent", () => {
    const { dispatched, run } = room({ status: "togetherOwner" });
    assert.deepEqual(run(TOGETHER_LEAVE_SCRIPT), { ok: true });
    assert.equal(dispatched[0].type, "async:listenTogether/leaveListenTogether");
    // 不带 silent 页面会先弹确认框，点了才真退——插件按钮不该卡在那一步。
    assert.deepEqual(plain(dispatched[0].payload), { silent: true });
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

describe("打开播放指令上报", () => {
  /** 造一个已经进房、但页面还没打开 isCanReport 的房间。 */
  function armed(status: string, isCanReport?: boolean) {
    const fixture = room({ status });
    fixture.state["async:listenTogetherPlayStatus"] = isCanReport === undefined ? {} : { isCanReport };
    return fixture;
  }

  it("房主在房间里且开关没开时派发 setCanReport", () => {
    const { dispatched, run } = armed("togetherOwner");
    assert.deepEqual(run(TOGETHER_SYNC_ARM_SCRIPT), { ok: true, armed: true });
    assert.equal(dispatched[0].type, "async:listenTogetherPlayStatus/setCanReport");
    assert.deepEqual(plain(dispatched[0].payload), { isCanReport: true });
  });

  it("作为成员进房同样要开", () => {
    const { dispatched, run } = armed("together");
    assert.deepEqual(run(TOGETHER_SYNC_ARM_SCRIPT), { ok: true, armed: true });
    assert.equal(dispatched[0].type, "async:listenTogetherPlayStatus/setCanReport");
  });

  it("开关已经开了就别再刷一遍", () => {
    for (const status of ["together", "togetherOwner"]) {
      const { dispatched, run } = armed(status, true);
      assert.deepEqual(run(TOGETHER_SYNC_ARM_SCRIPT), { ok: true, armed: false }, status);
      assert.deepEqual(dispatched, [], status);
    }
  });

  it("不在房间里就不碰这个开关", () => {
    for (const status of ["alone", "waiting", ""]) {
      const { dispatched, run } = armed(status);
      assert.deepEqual(run(TOGETHER_SYNC_ARM_SCRIPT), { ok: true, armed: false }, status);
      assert.deepEqual(dispatched, [], status);
    }
  });

  it("拿不到 store 时报错而不是炸", () => {
    const result = room({}, { store: { getState: () => ({}), dispatch: () => {} } }).run<{
      ok: boolean;
      error: string;
    }>(TOGETHER_SYNC_ARM_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});

describe("拉取别人的播放指令", () => {
  /**
   * 页面拿到指令是异步的（要发一次 HTTP 才落库），所以用 onDispatch 模拟：收到 syncPlayList
   * 就把 playCommand 填上。resourceId 默认给数字，正好复现 onRoomMsg 里 === 比对那个坑。
   */
  function remote(status: string, command: Record<string, unknown> | null, resourceId: unknown = 1900172235) {
    const playList: Record<string, unknown> = { playCommand: null };
    const fixture = room(
      { status, roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: "10001" } },
      {
        playing: { curPlaying: { resourceId } },
        togetherList: playList,
        onDispatch: (action) => {
          if (action.type === "async:listenTogetherPlayList/syncPlayList") playList.playCommand = command;
        },
      },
    );
    return { dispatched: fixture.dispatched, playList, runAsync: fixture.runAsync };
  }

  const command = { commandType: 1, progress: 1000, playStatus: 1, formerSongId: "1", targetSongId: "1900172235", userId: "20002" };

  it("拉到指令后按 IM 回调的形状派发 onRoomMsg", async () => {
    const fixture = remote("togetherOwner", { ...command, progress: 30000, targetSongId: "999" });
    const result = await fixture.runAsync<{ ok: boolean; applied: boolean }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    const types = fixture.dispatched.map(action => action.type);
    assert.ok(types.includes("async:listenTogetherPlayList/syncPlayList"), types.join(","));
    assert.ok(types.includes("async:listenTogetherPlayStatus/onRoomMsg"), types.join(","));
  });

  it("不在房间里不去打扰服务端", async () => {
    for (const status of ["alone", "waiting", ""]) {
      const fixture = remote(status, command);
      const result = await fixture.runAsync<{ ok: boolean; applied: boolean }>(TOGETHER_SYNC_PULL_SCRIPT);
      assert.deepEqual(result, { ok: true, applied: false }, status);
      assert.deepEqual(fixture.dispatched, [], status);
    }
  });

  it("服务端没给指令就只拉不套用", async () => {
    const fixture = remote("together", null);
    const result = await fixture.runAsync<{ ok: boolean; applied: boolean; reason: string }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.applied, false);
    assert.match(result.reason, /没拿到指令/);
    assert.deepEqual(fixture.dispatched.map(action => action.type), ["async:listenTogetherPlayList/syncPlayList"]);
  });

  it("同一个歌时把 targetSongId 换成 resourceId 的原值", async () => {
    // onRoomMsg 用 === 比对，字符串和数字不相等，PLAY/PAUSE/PROGRESS 会被静默丢掉。
    const fixture = remote("togetherOwner", command);
    const result = await fixture.runAsync<{ command: Record<string, unknown> }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.command.targetSongId, 1900172235);
    const pushed = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/onRoomMsg");
    assert.equal((pushed?.payload as Record<string, unknown>).targetSongId, 1900172235);
  });

  it("不是同一首歌就保持服务端给的值", async () => {
    const fixture = remote("togetherOwner", { ...command, targetSongId: "999" });
    const result = await fixture.runAsync<{ command: Record<string, unknown> }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.command.targetSongId, "999");
  });

  it("拿不到 store 时报错而不是炸", async () => {
    const result = await room({}, {
      store: { getState: () => ({}), dispatch: () => {} },
    }).runAsync<{ ok: boolean; error: string }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});
