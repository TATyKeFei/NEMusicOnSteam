import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import {
  TOGETHER_ADOPT_SCRIPT,
  TOGETHER_JOIN_SCRIPT,
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_CLEAR_SCRIPT,
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
  /** 共用一个 vm context 跑多次求值，脚本写在 globalThis 上的去重状态才能跨调用保留。 */
  keep?: boolean;
  now?: () => number;
  wait?: (callback: () => void, delay: number) => unknown;
  reduceTogether?: boolean;
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
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const store = options.store ?? {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: (action: { type: string; payload?: unknown }) => {
      dispatched.push(action);
      if (options.reduceTogether && action.type === "async:listenTogether/onUpdate") {
        state["async:listenTogether"] = {
          ...(state["async:listenTogether"] as Record<string, unknown>),
          ...(action.payload as Record<string, unknown>),
        };
      }
      options.onDispatch?.(action, store);
      notify();
      return action;
    },
  };
  const root = { __reactFiber$test: { memoizedProps: { store }, return: null } };
  const sandbox = {
    document: { querySelector: () => null, querySelectorAll: (selector: string) => (selector.includes("#root > *") ? [root] : []) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    // 拉指令的脚本要 await 页面里的 setTimeout，vm context 默认没有这个全局。
    setTimeout: options.wait ?? setTimeout,
    Date: options.now ? class extends Date { static now() { return options.now!(); } } : Date,
    fetch: options.fetch ?? (() => Promise.reject(new Error("测试里没给 fetch"))),
  };
  const context = options.keep ? createContext(sandbox) : null;
  const evaluate = <T>(script: string): T =>
    (context ? runInContext(script, context) : runInNewContext(script, sandbox)) as T;
  const run = <T>(script: string) => plain(evaluate(script)) as T;
  // 拉指令脚本返回 Promise：等它跑完再拍平，普通 run 会把 Promise 直接 JSON 成 {}。
  const runAsync = async <T>(script: string): Promise<T> => plain(await evaluate(script)) as T;
  return { state, dispatched, run, runAsync, notify, storeRef: store as { dispatch: unknown } };
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

  it("房间歌单是纯 id 数组时也要读出来（真机就是这个形状）", () => {
    // 真机实测：async:listenTogetherPlayList 里房间歌单存成 displayTrackIds 纯 id 数组，
    // curPlayingList 是空的。以前只按对象解析，这里会读成 0 首。
    const state = room({}, { togetherList: { curPlayingList: [], displayTrackIds: [111, "222", 333, 111] } })
      .run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.deepEqual(state.songIds, ["111", "222", "333"]);
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
  const STATUS = "/api/listen/together/status/get";

  /** 服务端认下这次加入时的 status/get 回包。 */
  const inRoom = (roomId: string, creatorId: string, users: unknown[] = [{ userId: 1 }]) => ({
    code: 200,
    data: { inRoom: true, roomInfo: { roomId, creatorId, chatRoomId: "chat-9", roomUsers: users } },
  });

  /** 按路径分发的 fetch 替身；calls 记下每次请求供断言。 */
  function routes(map: Record<string, unknown>) {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const fetch = (url: string, init: Record<string, unknown>) => {
      calls.push({ url: String(url), init });
      const path = String(url).replace("https://interface.music.163.com", "");
      if (path === STATUS) return Promise.resolve({ json: () => Promise.resolve(inRoom("123456", "20002")) });
      if (!(path in map)) return Promise.reject(new Error("测试没给这条路由：" + path));
      return Promise.resolve({ json: () => Promise.resolve(map[path]) });
    };
    return { calls, fetch };
  }

  const join = (
    fixture: { runAsync: <T>(script: string) => Promise<T> },
    roomId: string,
    inviterId: string,
  ) => fixture.runAsync<{
    ok: boolean;
    error?: string;
    roomId?: string;
    inviterId?: string;
    via?: string;
    serverInRoom?: boolean;
    serverMembers?: number;
  }>(TOGETHER_JOIN_SCRIPT(roomId, inviterId));

  it("带完整码时只打 accept，对过账再派发进房三件套", async () => {
    const r = routes({ [ACCEPT]: { code: 200, data: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } } });
    const f = room({}, { fetch: r.fetch });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, true);
    assert.equal(result.roomId, "123456");
    assert.equal(result.inviterId, "20002");
    assert.equal(result.via, "code");
    assert.equal(result.serverInRoom, true);
    // 带了房主 uid 就不该再去 room/check 碰运气；accept 之后还要 status/get 对账。
    assert.equal(r.calls.length, 2);
    assert.match(r.calls[0].url, /\/api\/listen\/together\/play\/invitation\/accept$/);
    assert.equal(r.calls[0].init.method, "POST");
    assert.equal(r.calls[0].init.credentials, "include");
    const body = String(r.calls[0].init.body);
    assert.match(body, /roomId=123456/);
    assert.match(body, /inviterId=20002/);
    assert.match(body, /refer=inbox_invite/);
    assert.match(r.calls[1].url, /\/api\/listen\/together\/status\/get$/);
    assert.deepEqual(f.dispatched.map(action => action.type), [
      "async:listenTogether/resetRoomInfo",
      "async:listenTogether/onUpdate",
      "async:listenTogether/restore",
    ]);
  });

  it("服务端没登记这次加入就如实报失败，不再假装进房", async () => {
    // accept 回 200、status/get 说人不在房间里：这就是真机上的「鬼房」，本地照样能显示在房间里。
    const calls: string[] = [];
    const f = room({}, {
      fetch: (url: string) => {
        const path = String(url);
        calls.push(path);
        const json = path.includes("status/get")
          ? { code: 200, data: { inRoom: false } }
          : { code: 200, data: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } };
        return Promise.resolve({ json: () => Promise.resolve(json) });
      },
    });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /没有登记/);
    assert.deepEqual(f.dispatched, []);
    assert.equal(calls.length, 2);
  });

  it("对账请求本身失败不算加入失败，但要说出原因", async () => {
    const r = routes({ [ACCEPT]: { code: 200, data: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } } });
    const f = room({}, {
      fetch: (url: string, init: unknown) => {
        if (String(url).includes("status/get")) return Promise.reject(new Error("network down"));
        return r.fetch(url, init as Record<string, unknown>);
      },
    });
    const result = await join(f, "123456", "20002");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /无法向网易云确认/);
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
    // chatRoomId 也从 status/get 那份补：页面 setRoomInfo 缺它就不写 store，房间信息会一直补不回去。
    assert.deepEqual(plain(reset?.payload), { roomInfo: { roomId: "123456", creatorId: "20002", chatRoomId: "chat-9" } });
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
    assert.equal(r.calls.length, 3);
    assert.match(r.calls[0].url, /\/api\/listen\/together\/room\/check$/);
    assert.match(String(r.calls[0].init.body), /roomId=123456/);
    assert.match(r.calls[1].url, /invitation\/accept$/);
    assert.match(r.calls[2].url, /status\/get$/);
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
  const roomInfo = { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" };

  it("主动退房立即清除网页房间状态和成员，不等页面异步收尾", () => {
    const fixture = room({
      status: "together", roomInfo,
      roomMembers: [{ userId: "20002", nickname: "房主" }], otherMember: { userId: "20002" },
    }, { keep: true, reduceTogether: true, fetch: async () => ({ json: async () => ({ code: 200 }) }) });
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    const state = fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.status, "alone");
    assert.equal(state.inRoom, false);
    assert.equal(state.roomId, "");
    assert.equal(state.chatRoomId, "");
    assert.equal(state.creatorId, "");
    assert.deepEqual(state.members, []);
  });

  it("主动退房之后自动恢复脚本不能把房间拉回来", async () => {
    const fixture = room({ status: "together", roomInfo }, {
      keep: true, reduceTogether: true, fetch: async () => ({ json: async () => ({ code: 200 }) }),
    });
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    const before = fixture.dispatched.length;
    await fixture.runAsync(TOGETHER_RESTORE_SCRIPT);
    assert.equal(fixture.dispatched.slice(before).some(action => action.type === "async:listenTogether/restore"), false);
  });

  it("退房前的 restore 异步结果迟到，也不能重新写入正在一起听", () => {
    const fixture = room({ status: "together", roomInfo }, {
      keep: true, reduceTogether: true, fetch: async () => ({ json: async () => ({ code: 200 }) }),
    });
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    (fixture.storeRef.dispatch as (action: unknown) => unknown)({
      type: "async:listenTogether/onUpdate", payload: { status: "together", roomInfo },
    });
    assert.equal((fixture.state["async:listenTogether"] as { status: string }).status, "alone");
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).inRoom, false);
  });

  it("页面已经 alone 但仍留有房间缓存时，退房也会清掉缓存", async () => {
    const fixture = room({}, {
      keep: true, reduceTogether: true,
      fetch: async (url: string) => ({ json: async () => url.includes("/status/get")
        ? { code: 200, data: { inRoom: true, roomInfo } } : { code: 200, data: roomInfo } }),
    });
    await fixture.runAsync(TOGETHER_JOIN_SCRIPT("123456", "20002"));
    fixture.state["async:listenTogether"] = { status: "alone" };
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).roomId, "");
  });

  it("退出后明确重新加入房间可以解除退出保护", async () => {
    const fixture = room({ status: "together", roomInfo }, {
      keep: true, reduceTogether: true,
      fetch: async (url: string) => ({ json: async () => url.includes("/status/get")
        ? { code: 200, data: { inRoom: true, roomInfo } } : { code: 200, data: roomInfo } }),
    });
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    assert.equal((await fixture.runAsync<{ ok: boolean }>(TOGETHER_JOIN_SCRIPT("123456", "20002"))).ok, true);
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).inRoom, true);
  });

  it("退出后明确重新建房可以解除退出保护", () => {
    const fixture = room({ status: "together", roomInfo }, {
      keep: true, reduceTogether: true, fetch: async () => ({ json: async () => ({ code: 200 }) }),
    });
    fixture.run(TOGETHER_LEAVE_SCRIPT);
    assert.equal(fixture.run<{ ok: boolean }>(TOGETHER_START_SCRIPT).ok, true);
    (fixture.storeRef.dispatch as (action: unknown) => unknown)({
      type: "async:listenTogether/onUpdate", payload: { status: "togetherOwner", roomInfo },
    });
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).inRoom, true);
  });

  it("服务端已退出时仅清理网页，不重复补发 end 请求", () => {
    const calls: string[] = [];
    const fixture = room({ status: "together", roomInfo }, {
      keep: true, reduceTogether: true,
      fetch: async (url: string) => { calls.push(url); return { json: async () => ({ code: 200 }) }; },
    });
    fixture.run(TOGETHER_CLEAR_SCRIPT);
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).inRoom, false);
    assert.deepEqual(calls, []);
  });

  it("页面自行退出后恢复前先查服务端，已结束的房间不能恢复", async () => {
    const statusReply = { code: 200, data: { inRoom: true, roomInfo } };
    const fixture = room({}, {
      keep: true, reduceTogether: true,
      fetch: async (url: string) => ({ json: async () => url.includes("/status/get")
        ? statusReply : { code: 200, data: roomInfo } }),
    });
    await fixture.runAsync(TOGETHER_JOIN_SCRIPT("123456", "20002"));
    fixture.state["async:listenTogether"] = { status: "alone" };
    statusReply.data.inRoom = false;
    const before = fixture.dispatched.length;
    await fixture.runAsync(TOGETHER_RESTORE_SCRIPT);
    assert.equal(fixture.dispatched.slice(before).some(action => action.type === "async:listenTogether/restore"), false);
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).roomId, "");
  });

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
    const result = run<{ ok: boolean; armed: boolean; canReport: boolean }>(TOGETHER_SYNC_ARM_SCRIPT);
    assert.deepEqual(
      { ok: result.ok, armed: result.armed, canReport: result.canReport },
      { ok: true, armed: true, canReport: true },
    );
    assert.equal(dispatched[0].type, "async:listenTogetherPlayStatus/setCanReport");
    assert.deepEqual(plain(dispatched[0].payload), { isCanReport: true });
  });

  it("作为成员进房要把上报关掉，否则会和房主抢服务端的 playCommand", () => {
    const { dispatched, run } = armed("together");
    const result = run<{ armed: boolean; canReport: boolean }>(TOGETHER_SYNC_ARM_SCRIPT);
    assert.equal(result.armed, true);
    assert.equal(result.canReport, false);
    assert.equal(dispatched[0].type, "async:listenTogetherPlayStatus/setCanReport");
    assert.deepEqual(plain(dispatched[0].payload), { isCanReport: false });
  });

  it("已经是对的值就别再刷一遍", () => {
    for (const [status, isCanReport] of [["together", false], ["togetherOwner", true]] as const) {
      const { dispatched, run } = armed(status, isCanReport);
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

/** 一条别人发来的指令。commandType 是字符串枚举，progress 单位 ms。 */
function cmd(type: string, extra: Record<string, unknown> = {}) {
  return {
    commandType: type,
    progress: 0,
    playStatus: type === "PLAY" ? "PLAY" : "PAUSE",
    formerSongId: "1900172235",
    targetSongId: "1900172235",
    userId: "20002",
    ...extra,
  };
}

/**
 * 造一个 fetch 替身：status/get 回「服务端认下这个房间」，其余路径回 data。
 * status/get 每个 tick 都要问一次，所以单独分开。
 */
function stubFetch(
  data: Record<string, unknown>,
  calls: unknown[] = [],
  statusData: Record<string, unknown> = { code: 200, data: { inRoom: true, roomInfo: { roomId: "123456", creatorId: "10001" } } },
) {
  return (url: string, init: unknown) => {
    calls.push({ url, init });
    const json = String(url).includes("/status/get") ? statusData : { code: 200, data };
    return Promise.resolve({ json: () => Promise.resolve(json) });
  };
}

/** 老的一档：只回指令，没有房间歌单。 */
function commandFetch(
  playCommand: Record<string, unknown> | null,
  calls: unknown[] = [],
  statusReply?: Record<string, unknown>,
) {
  return stubFetch(playCommand ? { playCommand } : {}, calls, statusReply);
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
  rest: Partial<FixtureOptions> & { statusReply?: Record<string, unknown> } = {},
) {
  const calls: unknown[] = [];
  const { statusReply, ...options } = rest;
  const fixture = room(
    { status, roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: String(hostUid) } },
    {
      playing: {
        playingState,
        curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } },
      },
      ...options,
      fetch: commandFetch(playCommand, calls, statusReply),
    },
  );
  return { dispatched: fixture.dispatched, runAsync: fixture.runAsync, calls, state: fixture.state };
}

/** 拉一次房间快照的返回值形状。 */
type PullResult = {
  ok: boolean;
  applied: boolean;
  via?: string;
  reason?: string;
  error?: string;
  aligned?: boolean;
  followed?: boolean;
  rebound?: boolean;
  /** 本地自己动了播放时，这一轮补报出去的指令类型（GOTO/PAUSE/PLAY）。 */
  reported?: string;
  queue?: number;
  local?: number;
  target?: string;
  localHas?: boolean;
  follow?: string;
  otherSide?: string;
  privileges?: number;
  serverInRoom?: boolean;
  serverRoomId?: string;
  serverMembers?: number;
  serverUsers?: { userId: string; nickname: string; avatarUrl: string }[];
  queueShape?: Record<string, string>;
  localShape?: Record<string, string>;
};

const pull = (fixture: { runAsync: <T>(s: string) => Promise<T> }) =>
  fixture.runAsync<PullResult>(TOGETHER_SYNC_PULL_SCRIPT);

describe("拉取别人的播放指令", () => {
  it("自己发请求拉快照，不借页面那个 syncPlayList 的口", async () => {
    const fixture = remote("togetherOwner", cmd("PAUSE"), 2);
    await pull(fixture);
    // 每个 tick 先问一次服务端我们在不在房间里，再拉歌单和指令。
    assert.equal(fixture.calls.length, 2);
    const [status, snapshot] = fixture.calls as { url: string; init: Record<string, unknown> }[];
    assert.match(status.url, /\/api\/listen\/together\/status\/get$/);
    assert.equal(status.init.body, "roomId=123456");
    assert.match(snapshot.url, /\/api\/listen\/together\/sync\/playlist\/get$/);
    assert.equal(snapshot.init.method, "POST");
    assert.equal(snapshot.init.credentials, "include");
    assert.equal(snapshot.init.body, "roomId=123456");
    // 服务端没回房间歌单，就不该派 syncPlayList：那条分支会让页面无条件 playTracks 从头重播。
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("async:listenTogetherPlayList")),
      [],
    );
  });

  it("服务端说我们不在房间里就不再套指令（本地状态是我们自己写的，会一直骗人）", async () => {
    const fixture = remote("together", cmd("PAUSE"), 2, 10001, {
      statusReply: { code: 200, data: { inRoom: false } },
    });
    const result = await pull(fixture);
    assert.equal(result.applied, false);
    assert.equal(result.serverInRoom, false);
    assert.match(result.reason ?? "", /不在这个房间里/);
    assert.deepEqual(fixture.dispatched, []);
    // 问完就不该再拉歌单了。
    assert.equal(fixture.calls.length, 1);
  });

  it("服务端名单的人数会带回设置页", async () => {
    const fixture = remote("together", cmd("PROGRESS"), 2, 10001, {
      statusReply: {
        code: 200,
        data: {
          inRoom: true,
          roomInfo: { roomId: "123456", creatorId: "20002", roomUsers: [{ userId: 1 }, { userId: 2 }] },
        },
      },
    });
    const result = await pull(fixture);
    assert.equal(result.serverInRoom, true);
    assert.equal(result.serverRoomId, "123456");
    assert.equal(result.serverMembers, 2);
  });

  it("服务端名单几种摆法都认，认不出的成员丢掉", async () => {
    const shapes: { data: Record<string, unknown>; nickname: string }[] = [
      { data: { inRoom: true, roomInfo: { roomId: "1", userList: [{ userId: 7, nickname: "甲" }] } }, nickname: "甲" },
      { data: { inRoom: true, room: { roomId: "1", members: [{ id: 7, name: "甲" }] } }, nickname: "甲" },
      // 昵称可以没有（服务端那边常常只查得到 uid），但没有 id 的成员要丢掉。
      { data: { inRoom: true, roomId: "1", roomUsers: [{ userId: 7 }, { nickname: "没有 id 的丢掉" }] }, nickname: "" },
    ];
    for (const { data, nickname } of shapes) {
      const fixture = remote("together", cmd("PROGRESS"), 2, 10001, { statusReply: { code: 200, data } });
      const result = await pull(fixture);
      assert.equal(result.serverRoomId, "1", JSON.stringify(data));
      assert.equal(result.serverMembers, 1, JSON.stringify(data));
      assert.deepEqual(result.serverUsers, [{ userId: "7", nickname, avatarUrl: "" }], JSON.stringify(data));
    }
  });

  it("seek 是官方客户端发进度用的指令名，当进度处理", async () => {
    const fixture = remote("togetherOwner", cmd("seek", { progress: 30500 }));
    const result = await pull(fixture);
    assert.equal(result.via, "playing/setPlayingPosition");
    const seek = fixture.dispatched.find(action => action.type === "playing/setPlayingPosition");
    assert.deepEqual(plain(seek?.payload), { duration: 30.5 });
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
    for (const type of ["GOTO", "NEXT", "PREV", "PREVIOUS"]) {
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

  it("歌单请求失败就把错误带回去，别静默", async () => {
    const statusStub = stubFetch({});
    const fixture = room({ status: "togetherOwner", roomInfo: { roomId: "123456" } }, {
      fetch: (url: string, init: unknown) => {
        if (String(url).includes("/status/get")) return statusStub(url, init);
        return Promise.reject(new Error("network down"));
      },
    });
    const result = await pull(fixture);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network down/);
  });

  it("问不到服务端房间状态不当成失败，但要说出来", async () => {
    const emptyStub = stubFetch({});
    const fixture = room({ status: "togetherOwner", roomInfo: { roomId: "123456" } }, {
      fetch: (url: string, init: unknown) => {
        if (String(url).includes("/status/get")) return Promise.reject(new Error("network down"));
        return emptyStub(url, init);
      },
    });
    const result = await pull(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /问不到服务端房间状态/);
  });

it("拿不到 store 时报错而不是炸", async () => {
    const result = await room({}, {
      store: { getState: () => ({}), dispatch: () => {} },
    }).runAsync<{ ok: boolean; error: string }>(TOGETHER_SYNC_PULL_SCRIPT);
    assert.equal(result.ok, false);
    assert.match(result.error, /还没准备好/);
  });
});

/**
 * 成员端追房主：加入别人的房间后各听各的，就是这一段。
 *
 * 房主那侧是靠 startModulePlaying 的房主分支把自己那首和整份队列写上服务端的，心跳和开局
 * 那一票指令都是 PROGRESS。所以成员这边「房主在听的歌不是我这首」就得当成切歌处理，只认
 * GOTO/NEXT/PREV 的话一条都等不到，两边各听各的听到完。
 */
describe("加入房间的人跟着房主走", () => {
  const HOST_SONG = "1900172235";
  const OTHER_SONG = "999";

  /** 房主心跳那种指令：PROGRESS + 房主在听的那首 + 房主的进度。 */
  function heartbeat(songId = OTHER_SONG, progress = 30000) {
    return {
      commandType: "PROGRESS",
      playStatus: "PLAY",
      progress,
      formerSongId: HOST_SONG,
      targetSongId: songId,
      userId: "20002",
    };
  }

  /**
   * 成员视角的房间。remote 是服务端给的房间队列，local 是页面 store 里的房间队列，
   * dispatch 到 playByTrackId 之后模拟页面真的把歌换上了。
   */
  function follower(options: {
    command?: Record<string, unknown> | null;
    remote?: number[];
    local?: number[];
    playingState?: unknown;
    keep?: boolean;
    now?: () => number;
    wait?: FixtureOptions["wait"];
    fetch?: FixtureOptions["fetch"];
    /**
     * 模拟页面换歌的灵敏度：
     *   true（默认）任何一档都能换；false 一档都换不了（歌不在队列里）；
     *   "onlyByTrackId" 只有 playByTrackId 管用，用来测第一档不奏效时会不会退档。
     */
    switches?: boolean | "onlyByTrackId";
  } = {}) {
    const calls: unknown[] = [];
    const command = options.command === undefined ? heartbeat() : options.command;
    const fixture = room(
      { status: "together", roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" } },
      {
        playing: {
          playingState: options.playingState ?? 2,
          curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } },
        },
        togetherList: { playingList: (options.local ?? []).map(id => ({ track: { id } })) },
        keep: options.keep,
        now: options.now,
        wait: options.wait,
        fetch: options.fetch ?? stubFetch(
          {
            playlist: { playMode: "PLAY_ORDER", displayList: { result: options.remote ?? [HOST_SONG, OTHER_SONG] } },
            ...(command ? { playCommand: command } : {}),
          },
          calls,
        ),
        onDispatch: action => {
          if (action.type === "async:listenTogetherPlayStatus/setCanReport") {
            fixture.state["async:listenTogetherPlayStatus"] = {
              ...(fixture.state["async:listenTogetherPlayStatus"] as Record<string, unknown>),
              ...(action.payload as Record<string, unknown>),
            };
            return;
          }
          if (action.type === "playing/setPlayingPosition") {
            fixture.state.playing = {
              ...(fixture.state.playing as Record<string, unknown>),
              resourcePosition: (action.payload as { duration: number }).duration,
            };
            return;
          }
          // 换歌在真实页面里是异步的，这里让它当场换上，后面的进度才对得上。
          const id = action.type === "async:listenTogetherPlayList/playByTrackId"
            ? Number((action.payload as { id?: unknown }).id)
            : action.type === "playing/play"
              ? Number((action.payload as { playId?: unknown }).playId)
              : action.type === "async:listenTogetherPlayList/playTracks"
                ? Number((action.payload as { options?: { playId?: unknown } }).options?.playId)
                : NaN;
          if (!Number.isFinite(id) && action.type !== "playing/pause" && action.type !== "playing/resume") return;
          // 暂停/续播也当场生效：基准读数（own.lastState）要跟真机一样跟着派发走。
          if (action.type === "playing/pause" || action.type === "playing/resume") {
            fixture.state.playing = {
              ...(fixture.state.playing as Record<string, unknown>),
              playingState: action.type === "playing/pause" ? 1 : 2,
            };
            return;
          }
          if (options.switches === false) return;
          if (options.switches === "onlyByTrackId" && action.type !== "async:listenTogetherPlayList/playByTrackId") return;
          fixture.state.playing = {
            ...(fixture.state.playing as Record<string, unknown>),
            resourceTrackId: id,
            curPlaying: { resourceId: id, trackId: id, resourceType: "track", track: { id } },
          };
        },
      },
    );
    return { dispatched: fixture.dispatched, runAsync: fixture.runAsync, calls, state: fixture.state, storeRef: fixture.storeRef, notify: fixture.notify };
  }

  const follow = (fixture: { runAsync: <T>(s: string) => Promise<T> }) =>
    fixture.runAsync<PullResult>(TOGETHER_SYNC_PULL_SCRIPT);

  const types = (fixture: { dispatched: { type: string; payload?: unknown }[] }) =>
    fixture.dispatched.map(action => action.type);

  it("房主在听别的歌就追过去，PROGRESS 也当切歌处理", async () => {
    const fixture = follower();
    const result = await follow(fixture);
    assert.equal(result.applied, true);
    assert.equal(result.followed, true);
    assert.match(result.via ?? "", /^playTracks/);
    // 第一档是页面自己的 playTracks：房间歌单在 store 里只是 id 数组，得靠它解析成 track。
    // payload 是 effect 的原样形状——早先传 {clear, playId} 会在 g.map 那一步就 TypeError。
    const tracks = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayList/playTracks");
    assert.deepEqual(plain(tracks?.payload), {
      displayTrackIds: [HOST_SONG, OTHER_SONG],
      options: { playId: OTHER_SONG, play: true },
    });
    assert.equal(result.via, "playTracks");
    // 真换了歌就不用再退档。
    const switched = fixture.dispatched.filter(
      action => action.type === "async:listenTogetherPlayList/playByTrackId",
    );
    assert.deepEqual(switched, []);
    // 追上之后把房主的进度也对上，别从 0 开始听。
    const seek = fixture.dispatched.find(action => action.type === "playing/setPlayingPosition");
    assert.deepEqual(plain(seek?.payload), { duration: 30 });
    // 回包要能看出已经跟上了。
    assert.equal(result.target, OTHER_SONG);
    assert.equal(result.follow, OTHER_SONG);
  });

  it("playTracks 不奏效时退到 playByTrackId，指令类型按 GOTO 派", async () => {
    const fixture = follower({ switches: "onlyByTrackId" as never });
    const result = await follow(fixture);
    assert.equal(result.applied, true);
    assert.equal(result.via, "playTracks>playByTrackId");
    // 指令类型不在切歌那一族时要按 GOTO 派：playByTrackId 只在切歌语义下才换歌。
    const switched = fixture.dispatched.find(
      action => action.type === "async:listenTogetherPlayList/playByTrackId",
    );
    assert.deepEqual(plain(switched?.payload), { id: OTHER_SONG, playStatus: 2, commandType: "GOTO" });
  });

  it("房主停着就跟着停", async () => {
    const fixture = follower({ command: { ...heartbeat(), playStatus: "PAUSE" } });
    const result = await follow(fixture);
    assert.equal(result.applied, true);
    assert.match(result.via ?? "", /pause$/);
    assert.ok(types(fixture).includes("playing/pause"));
  });

  it("歌一样时不去重复切歌，只对进度", async () => {
    const fixture = follower({ command: heartbeat(HOST_SONG) });
    const result = await follow(fixture);
    assert.equal(result.followed, undefined);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayList/playByTrackId"),
      [],
    );
    assert.equal(result.via, "playing/setPlayingPosition");
  });

  it("房间队列和本地不一致时先派 syncPlayList 把队列搬过来", async () => {
    const fixture = follower({ local: [], remote: [HOST_SONG, OTHER_SONG] });
    const result = await follow(fixture);
    assert.equal(result.aligned, true);
    const aligned = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayList/syncPlayList");
    // forceUpdatePlaylist 就是「把房间队列当成自己的队列」，也就是官方客户端加入时走的那条路。
    assert.deepEqual(plain(aligned?.payload), {
      roomId: "123456",
      forceUpdatePlaylist: true,
      enableDispatchQueueChange: true,
      isIgnorePlayCommand: false,
    });
  });

  it("同一份房间队列只派一次 syncPlayList，别把页面打成风暴", async () => {
    const fixture = follower({ local: [], keep: true });
    await follow(fixture);
    await follow(fixture);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayList/syncPlayList").length,
      1,
    );
  });

  it("队列里没有房主那首就退一步直接播它，还不行才如实报出来", async () => {
    const fixture = follower({ remote: [HOST_SONG], local: [HOST_SONG], switches: false });
    const result = await follow(fixture);
    // playByTrackId 按 id 在队列里找歌，找不到就换一条不依赖队列的路：直接让播放器播这一首。
    const direct = fixture.dispatched.filter(action => action.type === "playing/play");
    assert.deepEqual(plain(direct.map(action => action.payload)), [
      { playId: OTHER_SONG },
      { playId: OTHER_SONG, clear: true },
    ]);
    assert.equal(result.applied, false);
    assert.match(result.via ?? "", /playing\/play/);
    // 这一档服务端队列里根本没有房主那首，理由要说到这件事上。
    assert.match(result.reason ?? "", /不在房间队列里/);
    // 歌都没换上，进度和播放状态一律不动。
    assert.deepEqual(
      fixture.dispatched.filter(action => ["playing/setPlayingPosition", "playing/pause", "playing/resume"].includes(action.type)),
      [],
    );
  });

  it("服务端没回房间队列时不派 syncPlayList（那条分支会从头重播）", async () => {
    const fixture = follower({ remote: [], switches: false });
    const result = await follow(fixture);
    assert.equal(result.queue, 0);
    assert.equal(result.aligned, false);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayList/syncPlayList"),
      [],
    );
    // 队列是空的，切歌自然也切不动，如实说。
    assert.match(result.reason ?? "", /切不了/);
  });

  it("自己发的指令不追，成员端没开上报时也就不会有这一条", async () => {
    const fixture = follower({ command: { ...heartbeat(), userId: "10001" } });
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /自己发的/);
  });

  it("房主端不追别人的歌：房主的歌单才是房间的", async () => {
    const fixture = remote("togetherOwner", heartbeat(OTHER_SONG), 2);
    const result = await pull(fixture);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /不是同一首歌/);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("async:listenTogetherPlayList")),
      [],
    );
  });

  it("服务端名单只有 uid 时去用户资料接口补昵称和头像", async () => {
    const calls: string[] = [];
    const fixture = room({ status: "together", roomInfo: { roomId: "123456", chatRoomId: "c", creatorId: "20002" } }, {
      playing: { playingState: 2, curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } } },
      fetch: (url: string, init: unknown) => {
        calls.push(String(url));
        if (String(url).includes("/status/get")) {
          return Promise.resolve({
            json: () => Promise.resolve({ code: 200, data: { inRoom: true, roomInfo: { roomId: "123456", roomUsers: [{ userId: 20002 }] } } }),
          });
        }
        if (String(url).includes("/api/v1/user/detail/")) {
          return Promise.resolve({
            json: () => Promise.resolve({ code: 200, profile: { nickname: "小明", avatarUrl: "https://img/x.png" } }),
          });
        }
        return commandFetch({ commandType: "PROGRESS", targetSongId: "1900172235", progress: 0, playStatus: "PLAY", userId: "20002" }, calls)(url, init);
      },
    });
    const result = await pull(fixture);
    assert.ok(calls.some(url => url.includes("/api/v1/user/detail/20002")), calls.join(","));
    assert.deepEqual(result.serverUsers, [{ userId: "20002", nickname: "小明", avatarUrl: "https://img/x.png" }]);
  });

  it("资料接口挂了就留着空昵称，不能因此打断同步", async () => {
    const fixture = remote("together", cmd("PROGRESS"), 2, 10001, {
      statusReply: {
        code: 200,
        data: { inRoom: true, roomInfo: { roomId: "123456", roomUsers: [{ userId: 20002 }] } },
      },
    });
    // 默认替身对 /api/v1/ 会当成歌单请求回 200，profile 取不到，正好模拟补不到昵称。
    const result = await pull(fixture);
    assert.equal(result.serverMembers, 1);
    assert.deepEqual(result.serverUsers, [{ userId: "20002", nickname: "", avatarUrl: "" }]);
  });

  it("房间歌单存成 displayTrackIds 时认得出来（真机就是这个形状）", async () => {
    const fixture = follower({ remote: [HOST_SONG, OTHER_SONG] });
    fixture.state["async:listenTogetherPlayList"] = { curPlayingList: [], displayTrackIds: [1900172235, 999] };
    const result = await follow(fixture);
    // 认出来了就不用等 syncPlayList 落库，直接切得动。
    assert.equal(result.local, 2);
    assert.equal(result.applied, true);
    assert.match(result.via ?? "", /^playTracks/);
    assert.equal(result.follow, OTHER_SONG);
  });

  /**
   * 页面的 playTracks → getCommonPrivilege 要拿 otherMember 才肯去拉权限；otherMember 空时
   * 它返回 undefined，playTracks 只会「暂停 + 进度归零」，歌换不动（真机探针就是这个样子）。
   * 官方靠 roomInfo.roomUsers → memberEnter 补，我们加入时常常没带 roomUsers，所以自己补一次。
   */
  function withUsers(users: { userId: number }[], together: Record<string, unknown> = {}) {
    return room(
      { status: "together", roomInfo: { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" }, ...together },
      {
        playing: { playingState: 2, curPlaying: { resourceId: 1900172235, trackId: 1900172235, resourceType: "track", track: { id: 1900172235 } } },
        fetch: stubFetch(
          { playlist: { playMode: "PLAY_ORDER", displayList: { result: [HOST_SONG] } }, playCommand: cmd("PROGRESS") },
          [],
          { code: 200, data: { inRoom: true, roomInfo: { roomId: "123456", creatorId: "20002", roomUsers: users } } },
        ),
      },
    );
  }

  it("页面不知道对方是谁时用服务端名单补一次 memberEnter", async () => {
    const fixture = withUsers([{ userId: 20002 }, { userId: 10001 }]);
    const result = await pull(fixture);
    assert.equal(result.otherSide, "sent");
    const enter = fixture.dispatched.find(action => action.type === "async:listenTogether/memberEnter");
    assert.deepEqual(plain(enter?.payload), {
      users: [
        { userId: "20002", nickname: "", avatarUrl: "" },
        { userId: "10001", nickname: "", avatarUrl: "" },
      ],
    });
  });

  it("页面已经有成员名单时只补一个 otherSideChange，别重查一遍资料", async () => {
    const fixture = withUsers([{ userId: 20002 }], { roomMembers: [{ userId: 20002, nickname: "房主" }] });
    const result = await pull(fixture);
    assert.equal(result.otherSide, "sent");
    const types = fixture.dispatched.map(action => action.type);
    assert.ok(types.includes("async:listenTogether/otherSideChange"), types.join(","));
    assert.ok(!types.includes("async:listenTogether/memberEnter"), types.join(","));
  });

  it("认得对方就一个都不派", async () => {
    const fixture = withUsers([{ userId: 20002 }], { otherMember: { userId: "20002", nickname: "房主" } });
    const result = await pull(fixture);
    assert.equal(result.otherSide, "page");
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type.startsWith("async:listenTogether/member") || action.type.endsWith("otherSideChange")),
      [],
    );
  });

  it("本地队列里也有这首却换不动时，理由指向权限而不是队列", async () => {
    const fixture = follower({ remote: [HOST_SONG, OTHER_SONG], local: [HOST_SONG, OTHER_SONG], switches: false });
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.equal(result.localHas, true);
    assert.match(result.reason ?? "", /没换成/);
    assert.match(result.reason ?? "", /权限/);
  });

  it("本地队列是空的就把两个 slice 的字段名报出去，别再猜", async () => {
    const fixture = follower({ local: [], remote: [HOST_SONG, OTHER_SONG], keep: true });
    fixture.state["async:listenTogetherPlayList"] = { curPlayingList: [], version: 3 };
    fixture.state.playingList = { curPlayingList: [{ resourceId: 1 }] };
    const result = await follow(fixture);
    assert.equal(result.local, 0);
    assert.deepEqual(result.queueShape, { curPlayingList: "array:0", version: "number" });
    assert.deepEqual(result.localShape, { curPlayingList: "array:1" });
  });

  /** 把本地在播的歌改掉，模拟用户在网页上自己切了歌。 */
  function localSwitch(fixture: { state: Record<string, unknown> }, id: number) {
    fixture.state.playing = {
      ...(fixture.state.playing as Record<string, unknown>),
      resourceTrackId: id,
      resourcePosition: 0,
      curPlaying: { resourceId: id, trackId: id, resourceType: "track", track: { id } },
    };
  }

  it("本地自己切了歌就补报给房间，这一轮不追房主那条旧指令", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG, "777"] });
    await follow(fixture); // 第一轮：跟上房主，把基准记好。
    const before = fixture.dispatched.length;
    localSwitch(fixture, 777);
    const result = await follow(fixture);
    assert.equal(result.reported, "GOTO");
    assert.match(result.reason ?? "", /已上报/);
    const report = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    // force 是绕过 isCanReport 的唯一理由；ids 是「从哪首切到哪首」，position 0 和官方切歌一致。
    assert.deepEqual(plain(report?.payload), {
      command: "GOTO",
      reason: "force",
      ids: [OTHER_SONG, "777"],
      position: 0,
      playStatus: 2,
    });
    // 上报这一轮不能顺手把歌拉回房主那首（服务端这条旧指令要等上报落地才会变）。
    const tick = fixture.dispatched.slice(before);
    assert.deepEqual(
      tick.filter(action =>
        ["async:listenTogetherPlayList/playTracks", "async:listenTogetherPlayList/playByTrackId", "playing/play"].includes(action.type),
      ),
      [],
    );
  });

  it("本地暂停就补报 PAUSE；和房间指令一致的套用不算本地改动", async () => {
    const fixture = follower({ keep: true, command: heartbeat(HOST_SONG), local: [HOST_SONG] });
    await follow(fixture); // 歌相同：只对进度，基准记成在播。
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 1 };
    const paused = await follow(fixture);
    assert.equal(paused.reported, "PAUSE");
    assert.match(paused.reason ?? "", /暂停/);
    const report = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.deepEqual(plain(report?.payload), {
      command: "PAUSE",
      reason: "force",
      ids: [HOST_SONG, HOST_SONG],
      playStatus: 1,
    });
    // 再拉一轮：本地状态没动，不该把刚上报过的再报一遍。
    const again = await follow(fixture);
    assert.equal(again.reported, undefined);
  });

  it("本地继续播放就补报 PLAY", async () => {
    const fixture = follower({
      keep: true,
      command: { ...heartbeat(HOST_SONG), commandType: "PAUSE", playStatus: "PAUSE" },
      local: [HOST_SONG],
    });
    await follow(fixture); // 跟着房主停（fixture 当场暂停，基准记成 paused）。
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 2 };
    const result = await follow(fixture);
    assert.equal(result.reported, "PLAY");
    const report = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.deepEqual(plain(report?.payload), {
      command: "PLAY",
      reason: "force",
      ids: [HOST_SONG, HOST_SONG],
      playStatus: 2,
    });
  });

  it("跟着房主暂停那一下是套用，不算本地改动，不补报", async () => {
    const fixture = follower({
      keep: true,
      command: { ...heartbeat(HOST_SONG), commandType: "PAUSE", playStatus: "PAUSE" },
      local: [HOST_SONG],
    });
    await follow(fixture); // 派了 playing/pause，fixture 当场暂停，基准记成 paused。
    const result = await follow(fixture);
    assert.equal(result.reported, undefined);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayStatus/reportRequest"),
      [],
    );
  });

  it("本地切到房间队列之外的歌报不出去，如实说", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG] });
    await follow(fixture);
    localSwitch(fixture, 888);
    const result = await follow(fixture);
    assert.equal(result.reported, undefined);
    assert.match(result.reason ?? "", /不在房间队列/);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayStatus/reportRequest"),
      [],
    );
  });

  it("房主本地切歌不补票：页面对房主本来就是开着上报的", async () => {
    const fixture = remote("togetherOwner", cmd("PROGRESS"), 2, 10001, { keep: true });
    await pull(fixture);
    localSwitch(fixture, 777);
    const result = await pull(fixture);
    assert.equal(result.reported, undefined);
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayStatus/reportRequest"),
      [],
    );
  });

  /** 模拟用户在网页上拖完进度条：拖动结束页面就是派这个 action（日志里叫 dragEnd）。 */
  function userSeek(fixture: { storeRef: { dispatch: unknown } }, duration: number) {
    (fixture.storeRef.dispatch as (action: { type: string; payload?: unknown }) => void)({
      type: "playing/setPlayingPosition",
      payload: { duration },
    });
  }

  it("拖进度条补报 PROGRESS：页面自己那条没带 ids 会被 cmdFilter 拦掉，得我们补", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture); // 第一轮装上 dispatch 钩子。
    userSeek(fixture, 42.5);
    const report = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.deepEqual(plain(report?.payload), {
      command: "PROGRESS",
      position: 42.5,
      reason: "force",
      ids: [HOST_SONG, HOST_SONG],
      playStatus: 2,
    });
  });

  it("套用房间进度那一下不算拖动，不补报", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG, 30000) });
    const result = await follow(fixture);
    assert.equal(result.applied, true);
    // applyPosition 派的 setPlayingPosition 带着标记，钩子认出来直接放行。
    assert.deepEqual(
      fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayStatus/reportRequest"),
      [],
    );
    // 之后用户再拖才报。
    userSeek(fixture, 120);
    const report = fixture.dispatched.find(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.equal((report?.payload as { position?: number })?.position, 120);
  });

  it("钩子只装一次：连拉两轮，一次拖动只补报一条", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    await follow(fixture);
    userSeek(fixture, 66);
    const reports = fixture.dispatched.filter(action => action.type === "async:listenTogetherPlayStatus/reportRequest");
    assert.equal(reports.length, 1, JSON.stringify(reports.map(action => action.type)));
  });

  it("上报窗口每个 tick 开头都关：'指令没变'那条返回也要关得掉", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture); // 走完整一轮（settle 里也会关一次）。
    // 模拟 playTracks 收尾 1 秒后页面把窗口拨开，且这一轮指令没变、到不了 settle。
    fixture.state["async:listenTogetherPlayStatus"] = { isCanReport: true };
    const before = fixture.dispatched.length;
    const again = await follow(fixture);
    assert.equal(again.reason, "指令没变");
    const closed = fixture.dispatched
      .slice(before)
      .find(action => action.type === "async:listenTogetherPlayStatus/setCanReport");
    assert.ok(closed, JSON.stringify(fixture.dispatched.slice(before).map(action => action.type)));
    assert.deepEqual(plain(closed?.payload), { isCanReport: false });
  });

  it("本地切歌上报尚未确认时，后续旧快照不能把歌切回手机端", async () => {
    let now = 10000;
    const fixture = follower({
      keep: true, local: [HOST_SONG, OTHER_SONG, "777"],
      now: () => now, wait: callback => callback(),
    });
    await follow(fixture);
    localSwitch(fixture, 777);
    assert.equal((await follow(fixture)).reported, "GOTO");
    const before = fixture.dispatched.length;
    now += 6000;
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.equal(result.follow, "777");
    assert.match(result.reason ?? "", /确认/);
    assert.equal(fixture.dispatched.slice(before).some(action => action.type.endsWith("/playTracks")), false);
  });

  it("拖进度条上报尚未确认时，旧手机进度不能覆盖本地拖动", async () => {
    let now = 10000;
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG), now: () => now });
    await follow(fixture);
    userSeek(fixture, 120);
    const before = fixture.dispatched.length;
    now += 6000;
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /确认/);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 120);
    assert.equal(fixture.dispatched.slice(before).some(action => action.type === "playing/setPlayingPosition"), false);
  });

  it("同一条成功套用的进度指令超过五秒也不能重复回拉", async () => {
    let now = 10000;
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG), now: () => now });
    await follow(fixture);
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), resourcePosition: 36 };
    const before = fixture.dispatched.length;
    now += 6000;
    assert.equal((await follow(fixture)).reason, "指令没变");
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 36);
    assert.equal(fixture.dispatched.slice(before).some(action => action.type === "playing/setPlayingPosition"), false);
  });

  it("服务端确认本地拖动后解除保护，新的手机指令仍可同步", async () => {
    let now = 10000;
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG], command, now: () => now });
    await follow(fixture);
    userSeek(fixture, 120);
    Object.assign(command, { userId: "10001", progress: 120000, serverSeq: 2 });
    assert.equal((await follow(fixture)).reason, "自己发的");
    Object.assign(command, { userId: "20002", progress: 60000, serverSeq: 3 });
    now += 1500;
    assert.equal((await follow(fixture)).applied, true);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 60);
  });

  it("已收到更新序号后丢弃乱序返回的旧手机指令", async () => {
    let now = 10000;
    const command = { ...heartbeat(HOST_SONG, 60000), serverSeq: 20 };
    const fixture = follower({ keep: true, local: [HOST_SONG], command, now: () => now });
    await follow(fixture);
    Object.assign(command, { progress: 30000, serverSeq: 19 });
    now += 6000;
    assert.equal((await follow(fixture)).applied, false);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 60);
  });

  it("一轮拉取未结束时不会再发另一轮房间请求", async () => {
    let release!: (value: unknown) => void;
    let statusCalls = 0;
    const response = new Promise(resolve => { release = resolve; });
    const fixture = follower({
      keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG),
      fetch: (url: string) => {
        if (url.includes("/status/get")) {
          statusCalls += 1;
          return response;
        }
        return Promise.resolve({ json: async () => ({ code: 200, data: { playCommand: heartbeat(HOST_SONG) } }) });
      },
    });
    const first = follow(fixture);
    const second = follow(fixture);
    release({ json: async () => ({ code: 200, data: { inRoom: true, roomInfo: { roomId: "123456" } } }) });
    await Promise.all([first, second]);
    assert.equal(statusCalls, 1);
  });

  it("追歌等待期间用户又切歌时，旧快照不能继续退档覆盖", async () => {
    let fixture: ReturnType<typeof follower>;
    fixture = follower({
      keep: true, local: [HOST_SONG, OTHER_SONG, "777"], switches: "onlyByTrackId",
      wait: (callback, delay) => {
        if (delay === 50) localSwitch(fixture, 777);
        callback();
      },
    });
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.equal(result.follow, "777");
    assert.equal(types(fixture).includes("async:listenTogetherPlayList/playByTrackId"), false);
    assert.equal((await follow(fixture)).reported, "GOTO");
  });

  it("追歌等待期间用户拖进度时，旧快照不能覆盖新进度", async () => {
    let fixture: ReturnType<typeof follower>;
    fixture = follower({
      keep: true, local: [HOST_SONG, OTHER_SONG], switches: "onlyByTrackId",
      wait: (callback, delay) => {
        if (delay === 50) userSeek(fixture, 120);
        callback();
      },
    });
    const result = await follow(fixture);
    assert.equal(result.applied, false);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 120);
  });

  it("退房后遗留的拖动钩子不会继续上报一起听进度", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    fixture.state["async:listenTogether"] = { status: "alone" };
    userSeek(fixture, 120);
    assert.equal(types(fixture).includes("async:listenTogetherPlayStatus/reportRequest"), false);
  });

  it("暂停上报未确认时，旧快照不能把网页重新续播", async () => {
    let now = 10000;
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG), now: () => now });
    await follow(fixture);
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 1 };
    assert.equal((await follow(fixture)).reported, "PAUSE");
    now += 6000;
    assert.equal((await follow(fixture)).applied, false);
    assert.equal((fixture.state.playing as Record<string, unknown>).playingState, 1);
  });

  it("连续拖动以最后一次为准，前一次的服务端回声不能解除保护", async () => {
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG], command });
    await follow(fixture);
    userSeek(fixture, 120);
    userSeek(fixture, 60);
    Object.assign(command, { userId: "10001", progress: 120000, serverSeq: 2 });
    assert.match((await follow(fixture)).reason ?? "", /确认/);
    Object.assign(command, { progress: 60000, serverSeq: 3 });
    assert.equal((await follow(fixture)).reason, "自己发的");
    Object.assign(command, { userId: "20002", commandType: "SEEK", progress: 90000, serverSeq: 4 });
    assert.equal((await follow(fixture)).applied, true);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 90);
  });

  it("未确认的上报限速重试，超时后不永久阻挡新的手机指令", async () => {
    let now = 10000;
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG], command, now: () => now });
    await follow(fixture);
    userSeek(fixture, 120);
    now += 500;
    await follow(fixture);
    assert.equal(types(fixture).filter(type => type.endsWith("/reportRequest")).length, 1);
    now += 1000;
    await follow(fixture);
    assert.equal(types(fixture).filter(type => type.endsWith("/reportRequest")).length, 2);
    now += 9000;
    Object.assign(command, { progress: 60000, serverSeq: 2 });
    assert.equal((await follow(fixture)).applied, true);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 60);
  });

  it("房间请求返回前已退房时，旧结果不能补回房间或套用播放", async () => {
    let release!: (value: unknown) => void;
    const response = new Promise(resolve => { release = resolve; });
    const fixture = follower({ keep: true, fetch: () => response });
    const pending = follow(fixture);
    fixture.state["async:listenTogether"] = { status: "alone" };
    release({ json: async () => ({ code: 200, data: { inRoom: true, roomInfo: { roomId: "123456" } } }) });
    const result = await pending;
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /房间已变更/);
    assert.deepEqual(fixture.dispatched, []);
  });

  it("切换房间后重置序号和待确认操作，已安装的钩子使用新房间状态", async () => {
    const command = { ...heartbeat(HOST_SONG), serverSeq: 100 };
    const status = { code: 200, data: { inRoom: true, roomInfo: { roomId: "123456" } } };
    const fixture = follower({
      keep: true, local: [HOST_SONG], command,
      fetch: stubFetch({ playCommand: command }, [], status),
    });
    await follow(fixture);
    userSeek(fixture, 120);
    fixture.state["async:listenTogether"] = { status: "together", roomInfo: { roomId: "654321" } };
    status.data.roomInfo.roomId = "654321";
    Object.assign(command, { progress: 60000, serverSeq: 1 });
    assert.equal((await follow(fixture)).applied, true);
    assert.equal((fixture.state.playing as Record<string, unknown>).resourcePosition, 60);
    userSeek(fixture, 90);
    Object.assign(command, { userId: "10001", progress: 90000, serverSeq: 2 });
    assert.equal((await follow(fixture)).reason, "自己发的");
  });

  it("拉取失败后释放同步锁，下一轮仍能重新请求", async () => {
    let fail = true;
    const fetch = stubFetch({ playCommand: heartbeat(HOST_SONG) });
    const fixture = follower({
      keep: true, local: [HOST_SONG],
      fetch: (url: string, init: unknown) => {
        if (fail && url.includes("/sync/playlist/get")) return Promise.reject(new Error("连接中断"));
        return fetch(url, init);
      },
    });
    assert.equal((await follow(fixture)).ok, false);
    fail = false;
    assert.equal((await follow(fixture)).applied, true);
  });

  it("连续切歌又切回手机旧曲目时，最后一次选择仍需上报", async () => {
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    assert.equal((await follow(fixture)).reported, "GOTO");
    localSwitch(fixture, Number(HOST_SONG));
    assert.equal((await follow(fixture)).reported, "GOTO");
    Object.assign(command, { userId: "10001", targetSongId: OTHER_SONG, serverSeq: 2 });
    assert.match((await follow(fixture)).reason ?? "", /确认/);
    Object.assign(command, { targetSongId: HOST_SONG, serverSeq: 3 });
    assert.equal((await follow(fixture)).reason, "自己发的");
    const reports = fixture.dispatched.filter(action => action.type.endsWith("/reportRequest"));
    assert.deepEqual(plain((reports[1].payload as { ids: string[] }).ids), [OTHER_SONG, HOST_SONG]);
  });

  it("切歌还在等待确认时暂停新歌，也会替换待确认操作", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    assert.equal((await follow(fixture)).reported, "GOTO");
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 1 };
    assert.equal((await follow(fixture)).reported, "PAUSE");
  });

  it("暂停还在等待确认时又继续播放，不会被旧待确认暂停覆盖", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 1 };
    assert.equal((await follow(fixture)).reported, "PAUSE");
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), playingState: 2 };
    assert.equal((await follow(fixture)).reported, "PLAY");
  });

  it("本地切歌在 store 变化时立即上报，不等下一轮网络拉取", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG, "777"] });
    await follow(fixture);
    localSwitch(fixture, 777);
    fixture.notify();
    const reports = fixture.dispatched.filter(action => action.type.endsWith("/reportRequest"));
    assert.equal(reports.length, 1);
    assert.equal((reports[0].payload as { command: string }).command, "GOTO");
    assert.deepEqual(plain((reports[0].payload as { ids: string[] }).ids), [OTHER_SONG, "777"]);
    assert.equal((await follow(fixture)).reported, undefined);
  });

  it("套用手机切歌时 store 订阅不会把远端变化重新报回手机", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG] });
    await follow(fixture);
    assert.equal(types(fixture).includes("async:listenTogetherPlayStatus/reportRequest"), false);
  });

  it("已经换到目标歌曲时立即结束，不固定等待队列和一秒半", async () => {
    const waits: number[] = [];
    const fixture = follower({ wait: (callback, delay) => { waits.push(delay); callback(); } });
    assert.equal((await follow(fixture)).followed, true);
    assert.deepEqual(waits, []);
  });

  it("播过的曲目优先复用本地队列，不再次联网解析整份歌单", async () => {
    const command = { ...heartbeat(OTHER_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command });
    await follow(fixture);
    const before = fixture.dispatched.length;
    Object.assign(command, { targetSongId: HOST_SONG, serverSeq: 2 });
    const result = await follow(fixture);
    assert.equal(result.follow, HOST_SONG);
    assert.equal(result.via, "playByTrackId");
    assert.equal(fixture.dispatched.slice(before).some(action => action.type.endsWith("/playTracks")), false);
  });

  it("成员端页面异步打开上报开关时立即拦住，不能留下回声窗口", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    (fixture.storeRef.dispatch as (action: unknown) => unknown)({
      type: "async:listenTogetherPlayStatus/setCanReport", payload: { isCanReport: true },
    });
    assert.deepEqual(plain(fixture.dispatched.at(-1)?.payload), { isCanReport: false });
  });

  it("旧的异步切歌迟到时恢复最新本地选择，不上报旧歌造成两端来回切", async () => {
    let fixture: ReturnType<typeof follower>;
    let changed = false;
    fixture = follower({
      keep: true, local: [HOST_SONG, OTHER_SONG, "777"], switches: "onlyByTrackId",
      wait: callback => {
        if (!changed) {
          changed = true;
          localSwitch(fixture, 777);
          fixture.notify();
        }
        callback();
      },
    });
    assert.equal((await follow(fixture)).applied, false);
    localSwitch(fixture, Number(OTHER_SONG));
    fixture.notify();
    assert.equal((fixture.state.playing as { curPlaying: { trackId: unknown } }).curPlaying.trackId, 777);
    const reports = fixture.dispatched.filter(action => action.type.endsWith("/reportRequest"));
    assert.deepEqual(reports.map(action => plain((action.payload as { ids: string[] }).ids)), [[HOST_SONG, "777"]]);
  });

  it("页面 saga 绕过 dispatch 钩子打开上报时，store 订阅也立即关回去", async () => {
    const fixture = follower({ keep: true, local: [HOST_SONG], command: heartbeat(HOST_SONG) });
    await follow(fixture);
    fixture.state["async:listenTogetherPlayStatus"] = { isCanReport: true };
    fixture.notify();
    assert.equal((fixture.state["async:listenTogetherPlayStatus"] as { isCanReport: boolean }).isCanReport, false);
    assert.equal(types(fixture).includes("async:listenTogetherPlayStatus/reportRequest"), false);
  });

  it("成员资料请求迟迟不返回也不会阻塞播放同步", async () => {
    const fixture = follower({
      keep: true, local: [HOST_SONG],
      fetch: (url: string) => {
        if (url.includes("/user/detail/")) return new Promise(() => {});
        const data = url.includes("/status/get")
          ? { inRoom: true, roomInfo: { roomId: "123456", roomUsers: [{ userId: "20002" }] } }
          : { playCommand: heartbeat(HOST_SONG) };
        return Promise.resolve({ json: async () => ({ code: 200, data }) });
      },
    });
    const result = await follow(fixture);
    assert.equal(result.applied, true);
    assert.equal(result.serverMembers, 1);
  });

  it("切歌重试改报当前进度，而不是反复把手机切回零秒", async () => {
    let now = 10000;
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command: heartbeat(HOST_SONG), now: () => now });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    fixture.notify();
    fixture.state.playing = { ...(fixture.state.playing as Record<string, unknown>), resourcePosition: 1.25 };
    now += 1250;
    await follow(fixture);
    const reports = fixture.dispatched.filter(action => action.type.endsWith("/reportRequest"));
    assert.deepEqual(plain(reports.at(-1)?.payload), {
      command: "PROGRESS", reason: "force", ids: [OTHER_SONG, OTHER_SONG], position: 1.25, playStatus: 2,
    });
  });

  it("迟到的旧歌尚未修复时，其进度归零也不能上报成新的本地意图", async () => {
    let fixture: ReturnType<typeof follower>;
    let changed = false;
    fixture = follower({
      keep: true, local: [HOST_SONG, OTHER_SONG, "777"], switches: false,
      wait: callback => {
        if (!changed) {
          changed = true;
          localSwitch(fixture, 777);
          fixture.notify();
        }
        callback();
      },
    });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    fixture.notify();
    userSeek(fixture, 0);
    const reports = fixture.dispatched.filter(action => action.type.endsWith("/reportRequest"));
    assert.deepEqual(reports.map(action => plain((action.payload as { ids: string[] }).ids)), [[HOST_SONG, "777"]]);
  });

  it("本地切歌刚确认时手机仍回传旧歌心跳，不能把网页切回去", async () => {
    let now = 10000;
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command, now: () => now });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    fixture.notify();
    Object.assign(command, { userId: "10001", targetSongId: OTHER_SONG, progress: 0, serverSeq: 2 });
    assert.equal((await follow(fixture)).reason, "自己发的");
    Object.assign(command, { userId: "20002", targetSongId: HOST_SONG, progress: 30000, serverSeq: 3 });
    now += 200;
    assert.match((await follow(fixture)).reason ?? "", /旧心跳/);
    now += 1600;
    assert.match((await follow(fixture)).reason ?? "", /旧心跳/);
    assert.equal((fixture.state.playing as { curPlaying: { trackId: unknown } }).curPlaying.trackId, Number(OTHER_SONG));
    Object.assign(command, { commandType: "GOTO", serverSeq: 4 });
    assert.equal((await follow(fixture)).follow, HOST_SONG);
    assert.equal(fixture.dispatched.filter(action => action.type.endsWith("/reportRequest")).length, 1);
  });

  it("手机显式切歌不受本地确认后的旧心跳保护窗口拦截", async () => {
    let now = 10000;
    const command = { ...heartbeat(HOST_SONG), serverSeq: 1 };
    const fixture = follower({ keep: true, local: [HOST_SONG, OTHER_SONG], command, now: () => now });
    await follow(fixture);
    localSwitch(fixture, Number(OTHER_SONG));
    fixture.notify();
    Object.assign(command, { userId: "10001", targetSongId: OTHER_SONG, progress: 0, serverSeq: 2 });
    await follow(fixture);
    now += 200;
    Object.assign(command, { userId: "20002", commandType: "NEXT", targetSongId: HOST_SONG, serverSeq: 3 });
    assert.equal((await follow(fixture)).follow, HOST_SONG);
  });

});

describe("房间信息丢了要能自己补回来", () => {
  /** 加入房间之后页面该有的样子：status 在房间里、roomInfo 有内容。 */
  const ROOM_INFO = { roomId: "123456", chatRoomId: "chat-9", creatorId: "20002" };

  /**
   * 一个既是加入、又能拉快照的 fetch 替身：status/get 说服务端认了这个房间，accept 回 roomInfo，
   * 歌单里放房主在听的那首。
   */
  function togetherFetch(calls: unknown[] = []) {
    return (url: string, init: unknown) => {
      calls.push({ url, init });
      const path = String(url);
      const json = path.includes("/status/get")
        ? { code: 200, data: { inRoom: true, roomInfo: ROOM_INFO } }
        : path.includes("invitation/accept")
          ? { code: 200, data: ROOM_INFO }
          : { code: 200, data: { playCommand: null, playlist: { displayList: { result: [1900172235] } } } };
      return Promise.resolve({ json: () => Promise.resolve(json) });
    };
  }

  /** 加完一次房，再把页面里的 roomInfo 冲掉，模拟真机上那个状态。 */
  async function joinedThenDropped() {
    const calls: unknown[] = [];
    const fixture = room({}, { fetch: togetherFetch(calls) });
    const joined = await fixture.runAsync<{ ok: boolean }>(TOGETHER_JOIN_SCRIPT("123456", "20002"));
    assert.equal(joined.ok, true, "加入本身应该成功");
    fixture.state["async:listenTogether"] = { status: "together", roomInfo: {} };
    fixture.dispatched.length = 0;
    calls.length = 0;
    return { dispatched: fixture.dispatched, runAsync: fixture.runAsync, calls, state: fixture.state, run: fixture.run };
  }

  it("加入时把房间信息留在页面上", async () => {
    const fixture = room({}, { fetch: togetherFetch() });
    assert.equal((await fixture.runAsync<{ ok: boolean }>(TOGETHER_JOIN_SCRIPT("123456", "20002"))).ok, true);
    const state = fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.roomId, "123456");
    assert.equal(state.chatRoomId, "chat-9");
  });

  it("状态读数在页面 roomInfo 为空时也能给出房间号", async () => {
    const fixture = await joinedThenDropped();
    const state = fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT);
    assert.equal(state.inRoom, true);
    assert.equal(state.roomId, "123456");
  });

  it("拉取循环照样发请求，并把丢掉的 roomInfo 写回页面", async () => {
    const fixture = await joinedThenDropped();
    const result = await pull(fixture);
    // 房间号兜底之后请求照发，页面自己的心跳等生命周期靠的 roomInfo 也补回去。
    assert.ok(fixture.calls.length >= 1, JSON.stringify(fixture.calls));
    assert.equal(result.rebound, true);
    const rebound = fixture.dispatched.find(action => action.type === "async:listenTogether/resetRoomInfo");
    assert.deepEqual(plain(rebound?.payload), { roomInfo: ROOM_INFO });
  });

  it("退房时房间号也从我们这份兜底", async () => {
    const fixture = await joinedThenDropped();
    assert.deepEqual(fixture.run<{ ok: boolean }>(TOGETHER_LEAVE_SCRIPT), { ok: true });
    assert.equal(fixture.dispatched[0].type, "async:listenTogether/leaveListenTogether");
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).inRoom, false);
    assert.equal(fixture.run<TogetherState>(TOGETHER_STATE_SCRIPT).roomId, "");
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

  it("成员不能推：backupPlayList 拿的是自己的队列，推一遍就把房主的歌单顶掉", () => {
    const { dispatched, run } = inRoom("together");
    const result = run<{ sent: boolean; reason: string }>(TOGETHER_ADOPT_SCRIPT);
    assert.equal(result.sent, false);
    assert.match(result.reason, /只有房主/);
    assert.deepEqual(dispatched, []);
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
