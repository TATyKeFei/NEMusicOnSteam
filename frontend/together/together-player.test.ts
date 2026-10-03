import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import {
  TOGETHER_ADOPT_SCRIPT,
  TOGETHER_JOIN_SCRIPT,
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
  TOGETHER_SYNC_ARM_SCRIPT,
  TOGETHER_PROBE_SCRIPT,
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
  /** 拉指令脚本要发 fetch，这里给个替身。默认抛错，免得测试误以为联网成功了。 */
  fetch?: unknown;
  /** 默认 dispatch 只记录不落库；需要模拟 effect 改 store、或回头再派一个 action 时用这个钩子。 */
  onDispatch?: (action: { type: string; payload?: unknown }, store: { dispatch: (a: unknown) => unknown }) => void;
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
      options.onDispatch?.(action, store);
      return action;
    },
  };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const context = {
    document: { querySelector: () => null, querySelectorAll: (selector: string) => (selector.includes("#root > *") ? [root] : []) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    // 拉指令的脚本要 await 页面里的 setTimeout，vm context 默认没有这个全局。
    setTimeout,
    fetch: options.fetch ?? (() => Promise.reject(new Error("测试里没给 fetch"))),
  };
  const run = <T>(script: string) => plain(runInNewContext(script, context)) as T;
  // 拉指令脚本返回 Promise：等它跑完再拍平，普通 run 会把 Promise 直接 JSON 成 {}。
  const runAsync = async <T>(script: string): Promise<T> => plain(await runInNewContext(script, context)) as T;
  return { state, dispatched, run, runAsync, storeRef: store as { dispatch: unknown } };
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

describe("加入房间", () => {
  const ACCEPT = "/api/listen/together/play/invitation/accept";
  const CHECK = "/api/listen/together/room/check";

  /** 按路径分发的 fetch 替身；calls 记下每次请求供断言。 */
  function routes(map: Record<string, unknown>) {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const fetch = (url: string, init: Record<string, unknown>) => {
      calls.push({ url: String(url), init });
      const path = String(url).replace("https://interface.music.163.com", "");
      if (!(path in map)) return Promise.reject(new Error("测试没给这条路由：" + path));
      return Promise.resolve({ json: () => Promise.resolve(map[path]) });
    };
    return { calls, fetch };
  }

  const join = (
    fixture: { runAsync: <T>(script: string) => Promise<T> },
    roomId: string,
    inviterId: string,
  ) => fixture.runAsync<{ ok: boolean; error?: string; roomId?: string; inviterId?: string; via?: string }>(
    TOGETHER_JOIN_SCRIPT(roomId, inviterId),
  );

  it("带完整码时只打 accept，并派发进房三件套", async () => {
    const r = routes({ [ACCEPT]: { code: 200, data: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } } });
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, true);
    assert.equal(result.roomId, "123456");
    assert.equal(result.inviterId, "20002");
    assert.equal(result.via, "code");
    // 带了房主 uid 就不该再去 room/check 碰运气。
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0].url, /\/api\/listen\/together\/play\/invitation\/accept$/);
    assert.equal(r.calls[0].init.method, "POST");
    assert.equal(r.calls[0].init.credentials, "include");
    const body = String(r.calls[0].init.body);
    assert.match(body, /roomId=123456/);
    assert.match(body, /inviterId=20002/);
    assert.match(body, /refer=/);
    assert.deepEqual(f.dispatched.map(action => action.type), [
      "async:listenTogether/resetRoomInfo",
      "async:listenTogether/onUpdate",
      "async:listenTogether/restore",
    ]);
  });

  it("进房状态按自己是不是房主来定", async () => {
    // 房主不是自己 → together
    const other = routes({ [ACCEPT]: { code: 200, data: { roomId: "1", chatRoomId: "c", creatorId: "20002" } } });
    const asMember = room({}, { fetch: other.fetch });
    await join(asMember, "1", "20002");
    const memberUpdate = asMember.dispatched.find(action => action.type === "async:listenTogether/onUpdate");
    assert.deepEqual(plain(memberUpdate?.payload), { status: "together" });

    // 房主就是自己 → togetherOwner
    const self = routes({ [ACCEPT]: { code: 200, data: { roomId: "1", chatRoomId: "c", creatorId: "10001" } } });
    const asOwner = room({}, { fetch: self.fetch });
    await join(asOwner, "1", "10001");
    const ownerUpdate = asOwner.dispatched.find(action => action.type === "async:listenTogether/onUpdate");
    assert.deepEqual(plain(ownerUpdate?.payload), { status: "togetherOwner" });
  });

  it("roomInfo 缺字段时用已知的补上", async () => {
    const r = routes({ [ACCEPT]: { code: 200, data: {} } });
    const f = room({}, { fetch: r.fetch });
    assert.equal((await join(f, "123456", "20002")).ok, true);
    const reset = f.dispatched.find(action => action.type === "async:listenTogether/resetRoomInfo");
    assert.deepEqual(plain(reset?.payload), { roomInfo: { roomId: "123456", creatorId: "20002" } });
  });

  it("裸房间码先走 room/check，拿它回的房主 uid 再 accept", async () => {
    const r = routes({
      [CHECK]: { code: 200, data: { joinable: true, creatorId: "20002" } },
      [ACCEPT]: { code: 200, data: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } },
    });
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "123456", "");
    assert.equal(result.ok, true);
    assert.equal(result.via, "check");
    assert.equal(result.inviterId, "20002");
    assert.equal(r.calls.length, 2);
    assert.match(r.calls[0].url, /\/api\/listen\/together\/room\/check$/);
    assert.match(String(r.calls[0].init.body), /roomId=123456/);
    assert.match(r.calls[1].url, /invitation\/accept$/);
  });

  it("room/check 拿不到房主就让人改用完整链接，不发 accept", async () => {
    const r = routes({ [CHECK]: { code: 200, data: { joinable: true } } });
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "123456", "");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /完整/);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(f.dispatched, []);
  });

  it("房间不可加入时把服务端文案带回来", async () => {
    const r = routes({ [CHECK]: { code: 200, data: { joinable: false, copywriting: "一起听已失效" } } });
    const result = await join(room({}, { fetch: r.fetch }), "123456", "");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /失效/);
  });

  it("accept 非 200 时回服务端 message，不派发任何 action", async () => {
    const r = routes({ [ACCEPT]: { code: 400, message: "房间不存在" } });
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /房间不存在/);
    assert.deepEqual(f.dispatched, []);
  });

  it("请求失败要把错误带回去，别静默", async () => {
    const f = room({}, { fetch: () => Promise.reject(new Error("network down")) });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network down/);
    assert.deepEqual(f.dispatched, []);
  });

  it("没登录就拒，不碰服务端也不派发", async () => {
    for (const host of [{ uid: 0 }, { uid: 10001, isAnonymous: true }]) {
      const r = routes({ [ACCEPT]: { code: 200, data: {} } });
      const f = room({}, { host, fetch: r.fetch });
      const result = await join(f, "123456", "20002");
      assert.equal(result.ok, false, JSON.stringify(host));
      assert.match(result.error ?? "", /登录/);
      assert.deepEqual(f.dispatched, []);
      assert.deepEqual(r.calls, []);
    }
  });

  it("已经在房间里就拒", async () => {
    for (const status of ["together", "togetherOwner"]) {
      const f = room({ status });
      const result = await join(f, "123456", "20002");
      assert.equal(result.ok, false, status);
      assert.match(result.error ?? "", /已经在房间/);
      assert.deepEqual(f.dispatched, []);
    }
  });

  it("空房间码直接拒，不碰服务端", async () => {
    const r = routes({});
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "", "");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /房间码不能为空/);
    assert.deepEqual(r.calls, []);
  });

  it("拿不到 store 时报错而不是炸", async () => {
    const result = await join(
      room({}, { store: { getState: () => ({}), dispatch: () => {} } }),
      "123456",
      "20002",
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /还没准备好/);
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
  const PHONE = "20002";

  /** 一条别人发来的指令。commandType 是字符串枚举，progress 单位 ms。 */
  function cmd(type: string, extra: Record<string, unknown> = {}) {
    return {
      commandType: type,
      progress: 0,
      playStatus: type === "PLAY" ? "PLAY" : "PAUSE",
      formerSongId: "1900172235",
      targetSongId: "1900172235",
      userId: PHONE,
      ...extra,
    };
  }

  /** 造一个 fetch 替身，回 { data: { playCommand } }。顺便记下请求长什么样。 */
  function stubFetch(playCommand: Record<string, unknown> | null, calls: unknown[] = []) {
    return (_url: string, init: unknown) => {
      calls.push({ url: _url, init });
      return Promise.resolve({ json: () => Promise.resolve({ code: 200, data: playCommand ? { playCommand } : {} }) });
    };
  }

  /**
   * playing 用来复现「curPlaying.resourceId 是数字、targetSongId 是字符串」这个真实情况——
   * 页面 onRoomMsg 里两种类型要求互相矛盾，正是上一版踩的坑。
   */
  function remote(
    status: string,
    playCommand: Record<string, unknown> | null,
    playingState: unknown = 2,
    hostUid: unknown = 10001,
  ) {
    const calls: unknown[] = [];
    const fixture = room(
      { status, roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: String(hostUid) } },
      {
        playing: {
          playingState,
          curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } },
        },
        fetch: stubFetch(playCommand, calls),
      },
    );
    return { dispatched: fixture.dispatched, runAsync: fixture.runAsync, calls };
  }

  const pull = (fixture: { runAsync: <T>(s: string) => Promise<T> }) =>
    fixture.runAsync<{ ok: boolean; applied: boolean; via?: string; reason?: string; error?: string }>(TOGETHER_SYNC_PULL_SCRIPT);

  it("自己发 weapi 请求，不再借页面的 syncPlayList", async () => {
    const fixture = remote("togetherOwner", cmd("PAUSE"), 2);
    await pull(fixture);
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0] as { url: string; init: Record<string, unknown> };
    assert.match(call.url, /\/api\/listen\/together\/sync\/playlist\/get$/);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.body, "roomId=123456");
    // 以前是派 syncPlayList，它会顺带 playTracks 从 0 重播；现在一次都不派。
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("async:listenTogetherPlayList")),
      [],
    );
  });

  it("别人暂停就派发 playing/pause", async () => {
    const fixture = remote("togetherOwner", cmd("PAUSE"), 2);
    const result = await pull(fixture);
    assert.equal(result.applied, true);
    assert.equal(result.via, "playing/pause");
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("playing/")).map(action => action.type),
      ["playing/pause"],
    );
  });

  it("已经停着就别再派一次 pause", async () => {
    const fixture = remote("togetherOwner", cmd("PAUSE"), 1);
    await pull(fixture);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("playing/")).map(action => action.type),
      [],
    );
  });

  it("播放中收到 PLAY 就不动", async () => {
    const fixture = remote("togetherOwner", cmd("PLAY"), 2);
    await pull(fixture);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("playing/")).map(action => action.type),
      [],
    );
  });

  it("停着收到 PLAY 才 resume", async () => {
    const fixture = remote("togetherOwner", cmd("PLAY"), 1);
    await pull(fixture);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("playing/")).map(action => action.type),
      ["playing/resume"],
    );
  });

  it("进度换算成秒交给 setPlayingPosition", async () => {
    const fixture = remote("togetherOwner", cmd("PROGRESS", { progress: 30500 }));
    await pull(fixture);
    const pushed = fixture.dispatched.find(action => action.type === "playing/setPlayingPosition");
    assert.deepEqual(plain(pushed?.payload), { duration: 30.5 });
  });

  it("自己发的指令一律忽略，否则会跟自己打架", async () => {
    for (const hostUid of [10001, "10001"]) {
      const fixture = remote("togetherOwner", cmd("PLAY", { userId: String(hostUid) }), 1, hostUid);
      const result = await pull(fixture);
      assert.equal(result.applied, false, String(hostUid));
      assert.match(result.reason ?? "", /自己发的/);
      assert.deepEqual(
        fixture.dispatched.filter(action => action.type.startsWith("playing/")).map(action => action.type),
        [],
      );
    }
  });

  it("不是同一首歌的播放状态指令不套用", async () => {
    const fixture = remote("togetherOwner", cmd("PAUSE", { targetSongId: "999" }), 2);
    const result = await pull(fixture);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /不是同一首歌/);
  });

  it("切歌交给页面的 playByTrackId，id 原样传字符串", async () => {
    for (const type of ["GOTO", "NEXT", "PREVIOUS"]) {
      const fixture = remote("togetherOwner", cmd(type, { targetSongId: "999" }), 2);
      const result = await pull(fixture);
      assert.equal(result.via, "playByTrackId", type);
      const pushed = fixture.dispatched.find(
        action => action.type === "async:listenTogetherPlayList/playByTrackId",
      );
      assert.deepEqual(plain(pushed?.payload), { id: "999", playStatus: 2, commandType: type });
    }
  });

  it("不在房间里连请求都不发", async () => {
    for (const status of ["alone", "waiting", ""]) {
      const fixture = remote(status, cmd("PAUSE"));
      const result = await pull(fixture);
      assert.deepEqual(result, { ok: true, applied: false }, status);
      assert.deepEqual(fixture.dispatched, [], status);
      assert.deepEqual(fixture.calls, [], status);
    }
  });

  it("服务端没给指令就什么都不做", async () => {
    const fixture = remote("together", null);
    const result = await pull(fixture);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /没拿到指令/);
    assert.deepEqual(fixture.dispatched, []);
  });

  it("请求失败就把错误带回去，别静默", async () => {
    const fixture = room({ status: "togetherOwner", roomInfo: { roomId: "123456" } }, {
      fetch: () => Promise.reject(new Error("network down")),
    });
    const result = await pull(fixture);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network down/);
  });

  it("拿不到 store 时报错而不是炸", async () => {
    const result = await room({}, {
      store: { getState: () => ({}), dispatch: () => {} },
    }).runAsync<{ ok: boolean; error: string }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});

describe("播放状态探子", () => {
  /** 探子靠 store.subscribe，得自己造一个带 subscribe 的 store。 */
  function probed(initial: Record<string, unknown>) {
    const listeners: (() => void)[] = [];
    const fixture = room({}, { playing: initial });
    const store = {
      getState: () => fixture.state,
      dispatch: () => undefined,
      subscribe: (fn: () => void) => {
        listeners.push(fn);
        return () => listeners.splice(listeners.indexOf(fn), 1);
      },
    };
    const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
    const context = {
      document: { querySelector: () => null, querySelectorAll: (s: string) => (s.includes("#root > *") ? [root] : []) },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      setTimeout,
    };
    const run = <T>(script: string) => plain(runInNewContext(script, context)) as T;
    const change = (patch: Record<string, unknown>) => {
      fixture.state.playing = { ...(fixture.state.playing as object), ...patch };
      for (const fn of listeners.slice()) fn();
    };
    return { run, change, count: () => listeners.length };
  }

  const playing = {
    playingState: 2,
    resourceTrackId: 1900170925,
    resourcePosition: 10,
    curPlaying: { resourceId: 1900170925, trackId: 1900170925, resourceType: "track", track: { id: 1900170925 } },
  };

  it("装上之后播放状态一变就记一条", () => {
    const p = probed(playing);
    assert.equal(p.run<{ installed: boolean }>(TOGETHER_PROBE_SCRIPT).installed, true);
    p.change({ playingState: 1 });
    p.change({ resourcePosition: 10.5 });
    assert.deepEqual(p.run<TogetherState>(TOGETHER_STATE_SCRIPT).probe, [
      " st=1 id=1900170925 pos=10000",
      " st=1 id=1900170925 pos=10500",
    ]);
  });

  it("同一个 store 不重复安装，否则事件会记两遍", () => {
    const p = probed(playing);
    assert.equal(p.run<{ installed: boolean }>(TOGETHER_PROBE_SCRIPT).installed, true);
    assert.equal(p.run<{ installed: boolean }>(TOGETHER_PROBE_SCRIPT).installed, false);
    assert.equal(p.count(), 1);
  });

  it("没装探子时 state.probe 是空数组，不报错", () => {
    assert.deepEqual(room({}).run<TogetherState>(TOGETHER_STATE_SCRIPT).probe, []);
  });

  it("拿不到 store 时报错而不是炸", () => {
    const result = room({}, {
      store: { getState: () => ({}), dispatch: () => {} },
    }).run<{ ok: boolean; error: string }>(TOGETHER_PROBE_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});

describe("有人进来时把房主的歌推过去", () => {
  function inRoom(status: string, trackId: unknown = 1900172235) {
    return room(
      { status, roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: "10001" } },
      {
        playing: {
          curPlaying: { resourceId: trackId, trackId, resourceType: "track", track: { id: trackId } },
        },
      },
    );
  }

  it("按房主分支那三步走：备份、上报队列、force 上报指令", () => {
    const { dispatched, run } = inRoom("togetherOwner");
    const result = run<{ ok: boolean; sent: boolean; songId: string }>(TOGETHER_ADOPT_SCRIPT);
    assert.deepEqual(
      { ok: result.ok, sent: result.sent, songId: result.songId },
      { ok: true, sent: true, songId: "1900172235" },
    );
    assert.deepEqual(dispatched.map(action => action.type), [
      "async:listenTogetherPlayList/backupPlayList",
      "async:listenTogetherPlayList/reportPlayList",
      "async:listenTogetherPlayStatus/reportRequest",
    ]);
  });

  it("指令必须带 force，否则会被 isCanReport 那道门吞掉", () => {
    const { dispatched, run } = inRoom("togetherOwner");
    run(TOGETHER_ADOPT_SCRIPT);
    const report = dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.deepEqual(plain(report?.payload), { command: "PROGRESS", reason: "force" });
  });

  it("成员身份也一样要推", () => {
    const { dispatched, run } = inRoom("together");
    assert.equal(run<{ sent: boolean }>(TOGETHER_ADOPT_SCRIPT).sent, true);
    assert.equal(dispatched.length, 3);
  });

  it("不在房间里不发", () => {
    for (const status of ["alone", "waiting", ""]) {
      const { dispatched, run } = inRoom(status);
      assert.deepEqual(run(TOGETHER_ADOPT_SCRIPT), { ok: true, sent: false }, status);
      assert.deepEqual(dispatched, [], status);
    }
  });

  it("房主自己还没在播就不发，免得把空歌推过去", () => {
    const { dispatched, run } = room({ status: "togetherOwner" }, {
      playing: { curPlaying: null, resourceTrackId: 0 },
    });
    const result = run<{ sent: boolean; reason: string }>(TOGETHER_ADOPT_SCRIPT);
    assert.equal(result.sent, false);
    assert.match(result.reason, /还没在播/);
    assert.deepEqual(dispatched, []);
  });

  it("拿不到 store 时报错而不是炸", () => {
    const result = room({}, {
      store: { getState: () => ({}), dispatch: () => {} },
    }).run<{ ok: boolean; error: string }>(TOGETHER_ADOPT_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});

describe("播放栏按钮的动作捎带回插件", () => {
  /**
   * 这里要跨多次求值保留状态（脚本要取走动作后清空），所以不能用 runInNewContext——
   * 它每次都新建 context。共享一个 context，并且让 window 和 globalThis 是同一个对象，
   * 和真实浏览器一致（安装脚本写 window.__nemusicTogetherButton，取动作的脚本读同一个）。
   */
  function shared() {
    const state: Record<string, unknown> = {
      playing: { resourceTrackId: 1900172235, resourceDuration: 200, playingState: 2, curPlaying: { resourceId: 1900172235, trackId: 1900172235 } },
      "async:listenTogether": { status: "alone" },
    };
    const dispatched: { type: string; payload?: unknown }[] = [];
    const store = {
      getState: () => state,
      dispatch: (action: { type: string; payload?: unknown }) => {
        dispatched.push(action);
        return action;
      },
    };
    const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
    const sandbox: Record<string, unknown> = {
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => (selector.includes("#root > *") ? [root] : []),
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      setTimeout,
    };
    // window 指向沙箱本身，这样宿主侧写进去的字段脚本里读得到；globalThis 用 vm 自己的那个，
    // 覆盖它会让 contextify 出问题。
    sandbox.window = sandbox;
    const context = createContext(sandbox);
    const run = <T>(script: string) => plain(runInContext(script, context)) as T;
    return { run, sandbox };
  }

  it("没有按钮时 action 是空串", () => {
    assert.equal(shared().run<TogetherState>(TOGETHER_STATE_SCRIPT).action, "");
  });

  it("按钮攒了动作就带回来，取走即清空，不会执行两遍", () => {
    const f = shared();
    f.sandbox.__nemusicTogetherButton = { pending: "start" };
    assert.equal(f.run<TogetherState>(TOGETHER_STATE_SCRIPT).action, "start");
    assert.equal((f.sandbox.__nemusicTogetherButton as { pending: string }).pending, "");
    assert.equal(f.run<TogetherState>(TOGETHER_STATE_SCRIPT).action, "");
  });

  it("退房动作同样能捎回来", () => {
    const f = shared();
    f.sandbox.__nemusicTogetherButton = { pending: "leave" };
    assert.equal(f.run<TogetherState>(TOGETHER_STATE_SCRIPT).action, "leave");
  });
});
