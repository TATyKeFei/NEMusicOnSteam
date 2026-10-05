import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  TOGETHER_PENDING_SCRIPT,
  togetherButtonFailureScript,
  togetherButtonScript,
  togetherButtonUpdateScript,
} from "./together-button.ts";

/** vm 里造出来的对象原型和测试进程不是一回事，深比较前先拍平。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 房间里 script 真正读的那几个字段。roomId 藏在 roomInfo 下面，别放错层。 */
type Status = { status?: string; roomInfo?: { roomId?: string; creatorId?: string; chatRoomId?: string } };
type NativeInviteRequest = {
  roomInfo: Record<string, unknown>;
  refer: string;
  target: Record<string, unknown>;
};
type NativeInviteResult = { inviteFriendHandle: () => void } | undefined;
type WebpackModule = { exports: unknown };
type WebpackRequire = ((moduleId: string) => unknown) & { c: Record<string, WebpackModule> };
type WebpackFactory = (module: WebpackModule, exports: unknown, require: WebpackRequire) => void;
type WebpackChunk = [unknown[], Record<string, WebpackFactory>, [string][]];
/** 测试里区分「原有按钮」和「我们挂上去的按钮」用的标签。 */
const FILLER = "原有按钮";

/** 分享按钮的标记。真实页面里它靠 title 和埋点 oid 认，测试里改用 textContent 认。 */
const SHARE = "分享";

/**
 * 照真实页面造一个「按钮里套 svg 图标」的控件：播放列表、音量、一起听都是这个形状，title
 * 落在 svg 上而不是按钮上（图标组件会把多余的 props 透传给 <svg>）。left 给的是这个控件在
 * 播放栏里的横坐标，svg 跟着按钮一起动。
 */
function iconButton(title: string, left = 1100): { button: FakeNode; svg: FakeNode } {
  const button = new FakeNode("button");
  button.rectLeft = left;
  const svg = new FakeNode("svg");
  svg.title = title;
  svg.rectLeft = left;
  button.append(svg);
  return { button, svg };
}

/** 够跑这个脚本的最小 DOM：只实现脚本真正用到的那几个方法。 */
class FakeNode {
  tagName: string;
  id = "";
  className = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  innerHTML = "";
  private text = "";
  type = "";
  disabled = false;
  value = "";
  placeholder = "";
  /** 位置。播放栏那条带子在 y=700，页面上别的控件给别的 y，用来验证脚本只看带子里的。 */
  rectLeft = 40;
  rectTop = 700;
  private readonly listenersByType: Record<string, ((event: unknown) => void)[]> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  /** 播放栏图标按钮靠 title 认，测试里要能设。 */
  set title(value: string) {
    this.attrs.title = value;
  }

  get title(): string {
    return this.attrs.title ?? "";
  }

  /**
   * 真 DOM 里给 textContent 赋值会清空全部子节点——脚本靠 `menu.textContent = ''` 把菜单换成
   * 输入框，假 DOM 也得照这个语义来，否则旧菜单项还挂在里面。
   */
  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  focus(): void {}

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      this.detach(node);
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node: FakeNode, reference: FakeNode): void {
    // 真 DOM 里 insertBefore 会先把节点从原位置摘下来，挪到新位置——按钮在播放栏里换位置就是
    // 这么走的，测试里也得是这个语义，不然同一个按钮会留下两份。
    this.detach(node);
    node.parent = this;
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  private detach(node: FakeNode): void {
    const parent = node.parent;
    if (parent) parent.children = parent.children.filter((child) => child !== node);
    node.parent = null;
  }

  remove(): void {
    const parent = this.parent;
    if (parent == null) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  get parentElement(): FakeNode | null {
    return this.parent;
  }

  get isConnected(): boolean {
    return this.parent != null;
  }

  get previousElementSibling(): FakeNode | null {
    if (this.parent == null) return null;
    const index = this.parent.children.indexOf(this);
    return index > 0 ? this.parent.children[index - 1] : null;
  }

  get nextElementSibling(): FakeNode | null {
    if (this.parent == null) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listenersByType[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listenersByType[type] = (this.listenersByType[type] ?? []).filter((item) => item !== fn);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listenersByType[type] ?? []) fn(event);
  }

  click(): void {
    this.dispatch("click");
  }

  /** 支持脚本里那几种选择器：#id、标签名、[data-...]、逗号并列。 */
  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** 脚本靠它把「title 落在 svg 上」的匹配还原成外层按钮。 */
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | null = this; node; node = node.parent) {
      if (matchesSelf(node, selector)) return node;
    }
    return null;
  }

  select(): void {}
  /** 假样式表：默认可见，hidden 标记用来模拟「渲染了但看不见」。 */
  hidden = false;
  ownerDocument = { defaultView: { getComputedStyle: (node: FakeNode) => ({
    display: node.hidden ? "none" : "block",
    visibility: "visible",
    opacity: "1",
  }) } };

  getBoundingClientRect(): { top: number; left: number; height: number; width: number } {
    // 真 DOM 里，display:none 的祖先会让整棵子树都没有盒子，rect 归零——播放栏藏起来时就是这样，
    // 脚本靠它认出「播放键不在了，改用窗口底边当带子中线」。
    let hidden = this.hidden;
    for (let cur = this.parent; !hidden && cur; cur = cur.parent) hidden = cur.hidden;
    const size = hidden ? 0 : 28;
    return { top: this.rectTop, left: this.rectLeft, height: size, width: size };
  }
}

function matches(node: FakeNode, selector: string): boolean {
  return selector.split(",").some((part) => matchesOne(node, part.trim()));
}

/** 支持后代组合（`#a [title="x"]`）、#id、.class、[attr]、[attr="v"]、[attr^="v"]、[attr*="v"]、裸标签。 */
function matchesOne(node: FakeNode, one: string): boolean {
  if (one.includes(" ")) {
    // 后代组合：祖先里得有一个人匹配前一段，自己匹配后一段。
    const [head, ...tail] = one.split(/\s+/);
    const rest = tail.join(" ");
    for (let up: FakeNode | null = node.parent; up; up = up.parent) {
      if (matchesOne(up, head) && matchesOne(node, rest)) return true;
    }
    return false;
  }
  const classes = node.className.split(/\s+/).filter(Boolean);
  if (one.startsWith("#")) return node.id === one.slice(1);
  if (one.startsWith(".")) return classes.includes(one.slice(1));
  const attr = /^\[([\w-]+)\]$/.exec(one);
  if (attr) return node.attrs[attr[1]] != null;
  const attrWithValue = /^\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(one);
  if (attrWithValue) return node.attrs[attrWithValue[1]] === attrWithValue[2];
  const attrStarts = /^\[([\w-]+)\^=["']?([^"'\]]*)["']?\]$/.exec(one);
  if (attrStarts) return String(node.attrs[attrStarts[1]] ?? node.id).startsWith(attrStarts[2]);
  const attrContains = /^\[([\w-]+)\*=["']?([^"'\]]*)["']?\]$/.exec(one);
  if (attrContains) {
    const name = attrContains[1];
    const value = name === "class" ? node.className : (node.attrs[name] ?? "");
    return String(value).includes(attrContains[2]);
  }
  // 裸标签名走后代匹配，这样 `#root > *` 之类也能命中子树。
  if (/^[a-z]+$/i.test(one)) {
    const walk = (current: FakeNode): boolean =>
      current.children.some((child) => child.tagName === one.toUpperCase() || walk(child));
    return walk(node);
  }
  return false;
}

/**
 * 只看节点自己，不看子树——closest 得按浏览器的语义来。
 *
 * querySelector 用的那个匹配器把裸标签名当「子树里有就行」，那是给后代选择器兜底的；拿它写
 * closest 的话，一个 svg 会 climb 到外层的 div 上，按钮就被插到播放栏容器外面去了。
 */
function matchesSelf(node: FakeNode, selector: string): boolean {
  return selector.split(",").some((part) => {
    const one = part.trim();
    if (one.startsWith("#")) return node.id === one.slice(1);
    if (one.startsWith(".")) return node.className.split(/\s+/).includes(one.slice(1));
    const attr = /^\[([\w-]+)\]$/.exec(one);
    if (attr) return node.attrs[attr[1]] != null;
    const attrWithValue = /^\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(one);
    if (attrWithValue) return node.attrs[attrWithValue[1]] === attrWithValue[2];
    return /^[a-z]+$/i.test(one) && node.tagName === one.toUpperCase();
  });
}

type FixtureOptions = {
  status?: Status;
  share?: boolean;
  bar?: boolean;
  lateBar?: boolean;
  nativeTogether?: boolean;
  nativeInvite?: boolean;
  nativeInviteError?: "throw" | "reject";
  curPlaying?: boolean;
  lateStore?: boolean;
  playing?: Record<string, unknown>;
  /** 当前登录用户的 uid；null 表示未登录（store.host 为空）。 */
  hostUid?: string | null;
};

/** 一条假的 MutationRecord：页面脚本靠 type 区分结构变化和纯样式变化。 */
type FakeMutation = { target: FakeNode; type: "childList" | "attributes" | "characterData" };

/**
 * 造一个播放栏：分享按钮的父节点 + body。页面脚本靠 React fiber 找 store，所以这里给
 * 播放按钮挂一个只有 getState 的假 store。
 */
function fixture(options: FixtureOptions = {}) {
  const status: Status = options.status ?? { status: "alone" };
  const body = new FakeNode("body");
  const dispatched: unknown[] = [];
  const curPlaying = { resourceType: "track", resourceId: "1900172235", trackId: 1900172235, track: { id: 1900172235 } };
  const playing = options.playing ?? { resourceTrackId: 1900172235, resourceDuration: 200, curPlaying: options.curPlaying === false ? null : curPlaying };
  let storeReady = !options.lateStore;
  const revealStore = (): void => { storeReady = true; };
  // readRoom 从 store 读房间状态，所以得给页面一个真的 store。playing 那个 slice 不能少：
  // PLAYER_ACCESS_SCRIPT 认 store 的依据就是「state.playing 里有 resourceDuration」。
  const store = {
    // host.uid 是当前登录用户的 uid：复制房间链接时要当作 inviterId 编进去。
    getState: () => ({
      playing,
      host: options.hostUid === null ? {} : { uid: options.hostUid ?? "10001" },
      "async:listenTogether": status,
    }),
    dispatch: (action: unknown) => { dispatched.push(action); },
  };
  const bar = new FakeNode("div");
  // 真实页面里播放栏容器就叫这个；options.bar === false 时整个拿掉，用来测「什么都没找到」。
  if (options.bar !== false) bar.id = "page_pc_mini_bar";
  // PLAYER_ACCESS_SCRIPT 靠 React fiber 找 store，把假 store 挂在播放按钮上。
  const play = new FakeNode("div");
  play.id = "btn_pc_minibar_play";
  play.className = "cmd-button cmd-button-with-icon";
  play.rectLeft = 601;
  (play as unknown as Record<string, unknown>).__reactFiber$test = {
    memoizedProps: { get store() { return storeReady ? store : null; } },
    return: null,
  };
  // 照真实页面造：整个播放栏只有播放按钮有 id，分享按钮只有可访问名和埋点 oid。横坐标也照着
  // 真实布局给：左下角那组图标在 100~200，播放键在中间，音量和歌单在最右。
  const share = new FakeNode("button");
  share.textContent = SHARE;
  share.title = "分享";
  share.className = "cmd-button cmd-button-with-icon";
  share.rectLeft = 189;
  share.setAttribute("data-log", '{"data":{"oid":"btn_pc_minibar_share"}}');
  const filler = new FakeNode("button");
  filler.textContent = FILLER;
  filler.rectLeft = 10;
  const nativeTogether = new FakeNode("button");
  nativeTogether.id = "btn_pc_minibar_listentogether";
  nativeTogether.title = "一起听";
  let nativeTogetherClicks = 0;
  nativeTogether.addEventListener("click", () => { nativeTogetherClicks += 1; });
  bar.append(filler, play);
  if (options.share !== false) bar.append(share);
  if (options.nativeTogether) bar.append(nativeTogether);
  // lateBar：播放栏先不进页面，稍后再 appendBar 模拟「React 才渲染出来」。
  if (!options.lateBar) body.append(bar);

  const copied: string[] = [];
  const nativeInvites: NativeInviteRequest[] = [];
  let nativeInviteResolve: ((value: NativeInviteResult) => void) | null = null;
  const nativeModal = {
    listenTogetherInvite(request: NativeInviteRequest): Promise<NativeInviteResult> {
      nativeInvites.push(plain(request));
      if (options.nativeInviteError === "throw") throw new Error("modal unavailable");
      if (options.nativeInviteError === "reject") return Promise.reject(new Error("modal failed"));
      return new Promise((resolve) => { nativeInviteResolve = resolve; });
    },
  };
  const moduleCache: Record<string, WebpackModule> = {
    unrelated: { exports: { default: {} } },
    unfinished: { get exports(): unknown { throw new Error("module not initialized"); } },
  };
  if (options.nativeInvite) moduleCache["native-modal-with-changing-id"] = { exports: { default: nativeModal } };
  const moduleFactories: Record<string, WebpackFactory> = {};
  const webpackRequire: WebpackRequire = Object.assign((moduleId: string): unknown => {
    if (!moduleCache[moduleId]) {
      const module = { exports: {} };
      moduleCache[moduleId] = module;
      moduleFactories[moduleId](module, module.exports, webpackRequire);
    }
    return moduleCache[moduleId].exports;
  }, { c: moduleCache });
  const webpackJsonp: WebpackChunk[] = [];
  webpackJsonp.push = (...chunks: WebpackChunk[]): number => {
    for (const chunk of chunks) {
      Object.assign(moduleFactories, chunk[1]);
      for (const [moduleId] of chunk[2]) webpackRequire(moduleId);
    }
    return Array.prototype.push.apply(webpackJsonp, chunks);
  };
  const finishNativeInvite = (inviteFriendHandle?: () => void): void => {
    nativeInviteResolve?.(inviteFriendHandle ? { inviteFriendHandle } : undefined);
    nativeInviteResolve = null;
  };
  const document = {
    body,
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (tag: string) => new FakeNode(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: () => true,
  };
  /** 攒着的定时器（rAF 的补挂、防抖、吐司）。id 唯一，clearTimeout 才真能取消。 */
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerId = 0;
  const setTimeoutFake = (fn: () => void, delay = 0): number => {
    timerId += 1;
    timers.set(timerId, { fn, delay });
    return timerId;
  };
  const clearTimeoutFake = (id?: number): void => {
    if (id != null) timers.delete(id);
  };
  /** 还没跑的补挂排了多久：0 表示下一帧就补，40 就是会先画出一帧没按钮的老防抖。 */
  const pendingDelays = (): number[] => [...timers.values()].map((timer) => timer.delay);
  /** 页面里注册的 MutationObserver，mutate() 拿它模拟 DOM 变化。 */
  const observers = new Set<{ callback: (mutations: FakeMutation[]) => void }>();
  const FakeMutationObserver = class {
    callback: (mutations: FakeMutation[]) => void;
    constructor(callback: (mutations: FakeMutation[]) => void) {
      this.callback = callback;
    }
    observe(): void {
      observers.add(this);
    }
    disconnect(): void {
      observers.delete(this);
    }
  };
  const context = {
    document,
    MutationObserver: FakeMutationObserver,
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
    window: {
      webpackJsonp,
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout: setTimeoutFake,
      clearTimeout: clearTimeoutFake,
      // 下一帧就跑，和真 rAF 一样走 delay 0，测试里 flushTimers 一起跑掉。
      requestAnimationFrame: (fn: (time: number) => void) => setTimeoutFake(() => fn(0), 0),
    },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    encodeURIComponent,
    JSON,
    Math,
    Date,
  };
  const run = <T>(script: string): T => plain(runInNewContext(script, context)) as T;
  const install = () => run<{ ok: boolean; note: string; anchor: string; bar: string }>(togetherButtonScript());
  /** 注入后的 api：脚本挂在 window 上。 */
  const api = () => (context.window as unknown as { __nemusicTogetherButton: { pending: string } }).__nemusicTogetherButton;
  /** 模拟页面改了一次 DOM：挨个通知页面里注册的 observer。type 默认结构变化。 */
  const mutate = (target: FakeNode, type: "childList" | "attributes" = "childList"): void => {
    for (const observer of [...observers]) observer.callback([{ target, type }]);
  };
  /** 跑掉攒下的补挂（rAF 和定时器都在这里）。 */
  const flushTimers = (): void => {
    for (let round = 0; round < 10 && timers.size > 0; round += 1) {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.fn();
    }
  };
  /** 播放栏晚点才渲染出来（lateBar）时，用它把 bar 放进页面。 */
  const appendBar = (): void => {
    if (bar.parent == null) body.append(bar);
  };
  return {
    run, install, api, body, bar, share, copied, context, mutate, flushTimers, appendBar, pendingDelays,
    nativeInvites, finishNativeInvite, webpackJsonp, dispatched, curPlaying, playing, store, revealStore,
    nativeTogetherClicks: () => nativeTogetherClicks,
  };
}

describe("播放栏一起听按钮", () => {
  it("挂在分享按钮左边", () => {
    const f = fixture();
    const result = f.install();
    assert.equal(result.ok, true);
    assert.equal(result.note, "");
    const button = f.bar.querySelector("[data-nemusic-together-button]");
    assert.ok(button, "按钮没挂上");
    assert.equal(button!.nextElementSibling, f.share, "应该紧挨在分享按钮前面");
    // filler 在前、我们挂的按钮、分享
    assert.deepEqual(
      f.bar.children.map((node) => node.textContent || node.id),
      [FILLER, "btn_pc_minibar_play", "", SHARE],
    );
    assert.equal(result.anchor, "播放栏里的分享按钮");
  });

  it("播放栏上面别处的分享不会被认成播放栏的分享", () => {
    // 歌单列表里每行的「更多」菜单也有一个分享按钮，位置在页面中间。不按位置区分的话，按钮会
    // 被插到列表里去——那正是这个按钮一开始「挂上了但看不见」的原因。
    const f = fixture({ share: false });
    const row = new FakeNode("div");
    const menu = new FakeNode("button");
    menu.title = "分享";
    menu.rectTop = 300;
    row.append(menu);
    f.body.append(row);
    const add = new FakeNode("button");
    add.title = "添加";
    add.rectLeft = 105;
    const playlist = iconButton("播放列表");
    f.bar.insertBefore(add, f.bar.querySelector("#btn_pc_minibar_play"));
    f.bar.append(playlist.button);
    const result = f.install();
    assert.equal(result.note, "");
    // 只能插到播放栏里：菜单那个分享在 y=300，不在这条带子上。带子里最左的是「添加」。
    assert.equal(result.anchor, "播放栏最左边的控件");
    assert.equal(f.bar.querySelector("[data-nemusic-together-button]")!.nextElementSibling, add);
    assert.equal(row.children.length, 1, "歌单列表里不该多出东西");
  });

  it("一个锚点都没有时给出人话原因，并报出这一带有什么", () => {
    const f = fixture({ share: false, bar: false });
    // 连播放按钮都没有，这一带就真的一贫如洗了（页面还没渲染播放栏的极端情况）。
    f.bar.querySelector("#btn_pc_minibar_play")!.remove();
    const result = f.install();
    assert.equal(result.ok, true);
    assert.match(result.note, /没找到可放一起听按钮的位置/);
    assert.match(result.note, /没有 #page_pc_mini_bar/);
    assert.match(result.note, /这一带没找到任何可见控件/);
  });

  it("无论挂上挂不上都回报这一带的控件和坐标", () => {
    // 播放栏在不同页面结构不一样（分享、评论、音效都是条件渲染），这一行是判断「这个页面到底
    // 有什么」最直接的信息，所以成功时也要报。
    const f = fixture();
    const result = f.install();
    assert.match(result.bar, /有 #page_pc_mini_bar/);
    assert.match(result.bar, /分享<button>@189,700/);
  });

  it("补挂排在下一帧，不是 40ms 的防抖", () => {
    // 40ms 防抖一定会先画出一帧没按钮的画面，那正是切歌词界面时看到的「按钮消失又弹出来」。
    const f = fixture();
    f.install();
    f.bar.querySelector("[data-nemusic-together-button]")!.remove();
    f.mutate(f.bar);
    assert.deepEqual(f.pendingDelays(), [0], "补挂要排在下一帧（0ms）");
    f.flushTimers();
    const again = f.bar.querySelector("[data-nemusic-together-button]");
    assert.ok(again, "这一帧里就得回来");
    assert.equal(again!.nextElementSibling, f.share);
  });

  it("锚点晚点才出现时，没有新的 DOM 变化也能自己追上", () => {
    // 切界面那一下可能先把锚点拆了、隔一会儿才建出来，中间不保证还有新的 DOM 变化。光等下一次
    // 变化就得等插件 1.5 秒的轮询，那段时间按钮就是没了。
    const f = fixture({ lateBar: true });
    const first = f.install();
    assert.match(first.note, /没找到可放/);
    f.appendBar();
    f.flushTimers();
    assert.ok(f.body.querySelector("[data-nemusic-together-button]"), "没靠 DOM 变化也要追上");
  });

  it("播放栏被 CSS 藏起来时，按钮挪到还亮着的另一条播放栏", () => {
    // 切歌词界面：旧播放栏是 display:none/淡出的（纯样式变化，没有结构变化），按钮还连着也还在
    // 原位，但已经跟着一起看不见了。只看「连没连着」会以为一切正常。
    const f = fixture();
    f.install();
    const lyricBar = new FakeNode("div");
    const lyricShare = new FakeNode("button");
    lyricShare.title = "分享";
    lyricShare.rectLeft = 241;
    lyricShare.rectTop = 758;
    lyricBar.append(lyricShare);
    f.body.append(lyricBar);
    f.bar.hidden = true;
    f.mutate(f.bar, "attributes");
    f.flushTimers();
    const button = f.body.querySelector("[data-nemusic-together-button]");
    assert.ok(button, "不能跟着旧播放栏一起消失");
    assert.equal(button!.parent, lyricBar, "要挪到亮着的那条播放栏");
    assert.equal(button!.nextElementSibling, lyricShare);
    assert.equal(f.bar.children.includes(button!), false, "旧播放栏里不该再有它");
  });

  it("播放栏晚点才渲染出来时，按钮自己补上", () => {
    // 插件那边 1.5 秒才问一次，这段空窗正是「按钮凭空蹦出来」。页面自己盯着 DOM 就没有空窗。
    const f = fixture({ lateBar: true });
    const result = f.install();
    assert.match(result.note, /没找到可放一起听按钮的位置/);
    assert.equal(f.body.querySelector("[data-nemusic-together-button]"), null, "播放栏还没有，确实挂不上");
    // React 这时才把播放栏渲染出来
    f.appendBar();
    f.mutate(f.body);
    f.flushTimers();
    const button = f.body.querySelector("[data-nemusic-together-button]");
    assert.ok(button, "播放栏一出现按钮就该自己补上");
    assert.equal(button!.nextElementSibling, f.share);
  });

  it("页面重渲染把按钮冲掉后立刻补回来", () => {
    const f = fixture();
    f.install();
    f.bar.querySelector("[data-nemusic-together-button]")!.remove();
    f.mutate(f.bar);
    f.flushTimers();
    const again = f.bar.querySelector("[data-nemusic-together-button]");
    assert.ok(again, "按钮被冲掉后要自己回来");
    assert.equal(again!.nextElementSibling, f.share);
  });

  it("播放栏之外的改动不折腾按钮", () => {
    // 歌词、歌单列表天天在改 DOM，每次都全量扫一遍纯属浪费。只有播放栏那条横带附近的变化
    // 才需要重挂。
    const f = fixture();
    f.install();
    const api = f.api() as unknown as { ensure: () => string };
    let calls = 0;
    const original = api.ensure;
    api.ensure = () => {
      calls += 1;
      return original.call(api);
    };
    const far = new FakeNode("div");
    far.rectTop = 300;
    f.mutate(far);
    f.flushTimers();
    assert.equal(calls, 0, "页面上面的改动不该触发重挂");
    f.mutate(f.bar);
    f.flushTimers();
    assert.equal(calls, 1, "播放栏一带的改动要重挂一次");
  });

  it("destroy 之后不再往页面里补东西", () => {
    // 升级换脚本走的就是这条路：旧 api 拆干净，新的才能独占，不然会挂出第二个按钮。
    const f = fixture();
    f.install();
    const api = f.api() as unknown as { ensure: () => string; destroy: () => void };
    api.destroy();
    assert.equal(f.bar.querySelector("[data-nemusic-together-button]"), null);
    let calls = 0;
    api.ensure = () => {
      calls += 1;
      return "";
    };
    f.mutate(f.bar);
    f.flushTimers();
    assert.equal(calls, 0, "页面监听要跟着拆掉");
  });

  it("按钮被页面重建冲掉时如实报出来", () => {
    // 我们挂在 React 管理的子树里，页面重渲染可能把外来节点删掉。分清「没渲染分享按钮」和
    // 「挂上了但被冲掉」是两种完全不同的故障。
    const f = fixture();
    f.install();
    assert.doesNotMatch(f.run<{ bar: string }>(togetherButtonUpdateScript()).bar, /不在页面里/);
    // 模拟页面重渲染把外来节点删掉
    f.bar.querySelector("[data-nemusic-together-button]")!.remove();
    assert.match(f.run<{ bar: string }>(togetherButtonUpdateScript()).bar, /按钮当前不在页面里/);
  });

  it("分享按钮渲染了但不可见时不能当锚点，否则我们也跟着看不见", () => {
    // 网页版有不少按钮是渲染了但零尺寸/隐藏的。插在看不见的按钮前面，自己也是看不见的。
    const f = fixture();
    f.share.hidden = true;
    const comment = new FakeNode("button");
    comment.title = "评论";
    comment.rectLeft = 147;
    f.bar.append(comment);
    const result = f.install();
    assert.equal(result.anchor, "播放栏里的评论按钮（分享没渲染）");
    // 插在评论后面：那一组图标是[添加, 评论, 分享]，评论后面正好是分享原来的位置。
    assert.equal(f.bar.querySelector("[data-nemusic-together-button]")!.previousElementSibling, comment);
  });

  it("分享按钮只有埋点 oid 没有可访问名时也认得出来", () => {
    // 埋点属性比 title 更死：它是组件里写死的 oid，不随语言/实验变化。
    const f = fixture();
    f.share.title = "";
    const result = f.install();
    assert.equal(result.note, "");
    assert.equal(result.anchor, "播放栏里的分享按钮");
    assert.equal(f.bar.querySelector("[data-nemusic-together-button]")!.nextElementSibling, f.share);
  });

  it("title 落在 svg 图标上时要插到外层按钮前面，不能插进别人肚子里", () => {
    // 播放列表、音量、一起听都是「按钮里套 svg」，title 传给的是图标组件。插在 svg 前面的话，
    // 我们的按钮会变成那个按钮的子元素，既不是播放栏那一行的成员，也点不到。
    const f = fixture();
    const wrapped = iconButton("分享");
    wrapped.button.rectLeft = 189;
    f.share.remove();
    f.bar.append(wrapped.button);
    const result = f.install();
    assert.equal(result.anchor, "播放栏里的分享按钮");
    assert.equal(f.bar.querySelector("[data-nemusic-together-button]")!.nextElementSibling, wrapped.button);
    // 那个按钮自己还只有那一个 svg，没被塞进东西。
    assert.deepEqual(wrapped.button.children, [wrapped.svg]);
  });

  it("分享和评论都没有时，插到这一带最左边的控件前面", () => {
    // 网页版默认播放栏常常只渲染音量和歌单。插在最左边的控件旁边至少还在左下角这一片，
    // 总比跑到右边音量/歌单那边强。
    const f = fixture({ share: false });
    const add = new FakeNode("button");
    add.title = "添加";
    add.rectLeft = 105;
    const playlist = iconButton("播放列表");
    // 真实顺序：左边那组图标在播放键前面。
    f.bar.insertBefore(add, f.bar.querySelector("#btn_pc_minibar_play"));
    f.bar.append(playlist.button);
    const result = f.install();
    assert.equal(result.note, "");
    assert.equal(result.anchor, "播放栏最左边的控件");
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    assert.equal(button.nextElementSibling, add, "应该插在这一带最左的控件前面");
    assert.ok(
      f.bar.children.indexOf(button) < f.bar.children.indexOf(playlist.button),
      "不能插到右边音量/歌单那一侧去",
    );
  });

  it("反复安装不会挂出第二个按钮", () => {
    const f = fixture();
    f.install();
    f.run(togetherButtonUpdateScript());
    f.run(togetherButtonUpdateScript());
    assert.equal(f.bar.querySelectorAll("[data-nemusic-together-button]").length, 1);
  });

  it("更新脚本在整份脚本没装过时如实说没装", () => {
    const f = fixture();
    const result = f.run<{ ok: boolean; note: string }>(togetherButtonUpdateScript());
    assert.equal(result.ok, false);
    assert.match(result.note, /还没装上/);
  });

  it("未加入房间时只显示创建和加入", () => {
    const f = fixture();
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const labels = f.body
      .querySelectorAll("[data-nemusic-together-item]")
      .map((row) => row.textContent);
    assert.deepEqual(labels, ["创建房间", "加入房间"]);
  });

  it("未加入房间时隐藏退出、解散和复制", () => {
    const f = fixture({ status: { status: "alone" } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.ok(row("start"));
    assert.ok(row("join"));
    assert.equal(row("leave"), null);
    assert.equal(row("dissolve"), null);
    assert.equal(row("code"), null);
    assert.equal(row("link"), null);
  });

  it("创建动作刚发出、页面状态尚未回写时先显示房主操作", () => {
    const f = fixture();
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      pending: true,
      expiresAt: Date.now() + 30000,
      roomId: "",
      creatorId: "10001",
      createdByUs: true,
    };
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.equal(row("invite")!.textContent, "邀请好友");
    assert.equal(row("code"), null);
    assert.equal(row("link"), null);
  });

  it("房主在房间里只显示解散和复制，隐藏创建/加入/退出", () => {
    const f = fixture({ status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("leave"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.equal(row("invite")!.textContent, "邀请好友");
    assert.equal(row("code")!.textContent, "复制房间码");
    assert.equal(row("link")!.textContent, "复制房间链接");
  });

  it("创建后等待成员时也显示房主菜单", () => {
    const f = fixture({ status: { status: "waiting", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("leave"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.equal(row("invite")!.textContent, "邀请好友");
    assert.ok(row("code"));
    assert.ok(row("link"));
  });

  it("status 只有 together 但创建标记还在时仍识别为房主", () => {
    const f = fixture({ status: { status: "together", roomInfo: { roomId: "123456" } } });
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      roomId: "123456",
      creatorId: "10001",
      ownerUid: "10001",
      createdByUs: true,
      pending: false,
      expiresAt: 0,
    };
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("leave"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.equal(row("invite")!.textContent, "邀请好友");
  });

  it("创建流程还在 opening 但已有房间号时也不显示创建/加入", () => {
    const f = fixture({ status: { status: "opening", roomInfo: { roomId: "123456", creatorId: "10001" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.equal(row("invite")!.textContent, "邀请好友");
    assert.ok(row("code"));
    assert.ok(row("link"));
  });

  it("房间号已经写入但 status 还没更新时也能显示房主菜单", () => {
    const f = fixture({ status: { status: "alone", roomInfo: { roomId: "123456", creatorId: "10001" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("dissolve")!.textContent, "解散房间");
    assert.ok(row("code"));
    assert.ok(row("link"));
  });

  it("房主已经建房但暂时还没有房间号时也显示邀请好友", () => {
    const f = fixture({ status: { status: "togetherOwner" } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    assert.equal(f.body.querySelector('[data-nemusic-together-item="invite"]')!.textContent, "邀请好友");
  });

  it("成员在房间里显示退出而不是解散", () => {
    const f = fixture({ status: { status: "together", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const row = (key: string) => f.body.querySelector(`[data-nemusic-together-item="${key}"]`);
    assert.equal(row("start"), null);
    assert.equal(row("join"), null);
    assert.equal(row("dissolve"), null);
    assert.equal(row("leave")!.textContent, "退出房间");
    assert.ok(row("code"));
    assert.ok(row("link"));
  });

  it("菜单打开时会跟随房间状态切换项目", () => {
    const status: Status = { status: "alone" };
    const f = fixture({ status });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    status.status = "togetherOwner";
    status.roomInfo = { roomId: "123456" };
    f.run(togetherButtonUpdateScript());
    const labels = f.body
      .querySelectorAll("[data-nemusic-together-item]")
      .map((row) => row.textContent);
    assert.deepEqual(labels, ["解散房间", "邀请好友", "复制房间码", "复制房间链接"]);
  });

  it("点加入展开输入框，确定后把 join:码 摞给插件", () => {
    const f = fixture({ status: { status: "alone" } });
    f.install();
    const api = f.api();
    const click = { preventDefault() {}, stopPropagation() {} };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="join"]')!.dispatch("click", click);
    // 菜单没关，原地换成输入框。
    assert.notEqual(f.body.querySelector("[data-nemusic-together-menu]"), null);
    assert.equal(f.body.querySelectorAll("[data-nemusic-together-item]").length, 0);
    const input = f.body.querySelector("[data-nemusic-together-join-input]")!;
    input.value = "123456:10001";
    f.body.querySelector("[data-nemusic-together-join-confirm]")!.dispatch("click", click);
    assert.equal(api.pending, "join:123456:10001");
    // 提交完收起来。
    assert.equal(f.body.querySelector("[data-nemusic-together-menu]"), null);
  });

  it("加入输入框回车也提交，空的就拦下", () => {
    const f = fixture({ status: { status: "alone" } });
    f.install();
    const api = f.api();
    const click = { preventDefault() {}, stopPropagation() {} };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="join"]')!.dispatch("click", click);
    const confirm = f.body.querySelector("[data-nemusic-together-join-confirm]")!;
    confirm.dispatch("click", click);
    assert.equal(api.pending, "", "空输入不该摞动作");
    const input = f.body.querySelector("[data-nemusic-together-join-input]")!;
    input.value = "  123456  ";
    input.dispatch("keydown", { key: "Enter", preventDefault() {} });
    assert.equal(api.pending, "join:123456");
  });

  it("点创建/解散只是把动作记下，交给插件侧执行", () => {
    const f = fixture({ status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const api = f.api();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    f.body.querySelector('[data-nemusic-together-item="dissolve"]')!.dispatch("click", {
      preventDefault() {},
      stopPropagation() {},
    });
    assert.equal(api.pending, "leave");
    // 菜单点完就收起来
    assert.equal(f.body.querySelector("[data-nemusic-together-menu]"), null);
  });

  it("成员点退出房间也交给插件侧执行", () => {
    const f = fixture({ status: { status: "together", roomInfo: { roomId: "123456" } } });
    f.install();
    const api = f.api();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    f.body.querySelector('[data-nemusic-together-item="leave"]')!.dispatch("click", {
      preventDefault() {},
      stopPropagation() {},
    });
    assert.equal(api.pending, "leave");
  });

  it("邀请直接调用原生弹窗接口，不能点击会退出房间的播放栏按钮", () => {
    const f = fixture({ nativeInvite: true, nativeTogether: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456", creatorId: "10001", chatRoomId: "chat-123" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.equal(f.nativeTogetherClicks(), 0);
    assert.deepEqual(f.nativeInvites, [{
      roomInfo: { roomId: "123456", creatorId: "10001", chatRoomId: "chat-123" },
      refer: "songplay_more",
      target: f.curPlaying,
    }]);
    assert.deepEqual(f.dispatched, []);
    assert.deepEqual(f.copied, []);
  });

  it("原生邀请接口未加载时提示原因，不假装已打开或退回复制链接", () => {
    const f = fixture({ nativeTogether: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.copied, []);
    assert.equal(f.nativeTogetherClicks(), 0);
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /原生邀请入口尚未加载/);
  });

  it("原生邀请使用缓存里的完整房间信息，补上当前页面缺失的字段", () => {
    const f = fixture({ nativeInvite: true, status: { status: "togetherOwner" } });
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      roomId: "123456",
      creatorId: "10001",
      chatRoomId: "chat-123",
      roomInfo: { roomId: "123456", token: "native-room-token" },
    };
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.nativeInvites[0].roomInfo, {
      roomId: "123456", creatorId: "10001", chatRoomId: "chat-123", token: "native-room-token",
    });
  });

  it("创建尚未拿到房间号时不触发原生弹窗或再次创建房间", () => {
    const f = fixture({ nativeInvite: true, status: { status: "togetherOwner" } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.nativeInvites, []);
    assert.equal(f.api().pending, "");
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /房间还在创建/);
  });

  it("curPlaying 暂时缺失时构造当前歌曲 target，避免原生接口静默返回", () => {
    const f = fixture({ nativeInvite: true, curPlaying: false, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.nativeInvites[0].target, f.curPlaying);
  });

  it("按钮先于播放器状态安装，之后播放或切歌时邀请读取最新状态而不是初始空值", () => {
    const f = fixture({ nativeInvite: true, lateStore: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      roomId: "123456", creatorId: "10001", createdByUs: true,
    };
    f.install();
    f.revealStore();
    f.playing.resourceTrackId = 456;
    f.playing.curPlaying = { resourceType: "track", resourceId: "456", trackId: 456, track: { id: 456 } };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.equal(f.nativeInvites.length, 1);
    assert.deepEqual(f.nativeInvites[0].target, f.playing.curPlaying);
    assert.equal(f.body.querySelector("[data-nemusic-together-toast]"), null);
  });

  it("播放器尚未就绪时邀请明确提示状态未就绪，不误报用户未播放歌曲", () => {
    const f = fixture({ nativeInvite: true, lateStore: true });
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      roomId: "123456", creatorId: "10001", createdByUs: true,
    };
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.nativeInvites, []);
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /播放器状态尚未就绪/);
  });

  it("按钮先于播放器安装时也能读到随后设置的退房标记", () => {
    const f = fixture({ lateStore: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoom = {
      roomId: "123456", creatorId: "10001", createdByUs: true,
    };
    f.install();
    f.revealStore();
    (f.context as Record<string, unknown>).__NEMusicOnSteamRoomExit = { store: f.store };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    const labels = f.body.querySelectorAll("[data-nemusic-together-item]").map((row) => row.textContent);
    assert.deepEqual(labels, ["创建房间", "加入房间"]);
  });

  it("歌曲信息仅在 curTrack 时也能打开原生邀请，不误报未播放", () => {
    const track = { id: 456, name: "当前歌曲" };
    const f = fixture({ nativeInvite: true, playing: { resourceDuration: 200, curTrack: track }, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.equal(f.nativeInvites.length, 1);
    assert.deepEqual(f.nativeInvites[0].target, {
      resourceType: "track", resourceId: "456", trackId: 456, track,
    });
  });

  it("播放器 store 更新后，邀请不再读取安装时留下的旧 store", () => {
    const status: Status = { status: "togetherOwner", roomInfo: { roomId: "123456" } };
    const f = fixture({ nativeInvite: true, playing: { resourceDuration: 0 }, status });
    f.install();
    const target = { resourceType: "track", resourceId: "456", trackId: 456, track: { id: 456 } };
    (f.context as Record<string, unknown>).__NEMusicOnSteamPlayerStore = {
      getState: () => ({
        playing: { resourceDuration: 200, resourceTrackId: 456, curPlaying: target },
        host: { uid: "10001" },
        "async:listenTogether": status,
      }),
      dispatch: () => undefined,
    };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.equal(f.nativeInvites.length, 1);
    assert.deepEqual(f.nativeInvites[0].target, target);
  });

  it("播放器状态有效但确实没有歌曲时仍提示播放，不凭空构造歌曲", () => {
    const f = fixture({ nativeInvite: true, playing: { resourceDuration: 0 }, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.deepEqual(f.nativeInvites, []);
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /请先播放一首网易云歌曲/);
  });

  it("选择好友后执行原生发送回调，窗口还开着时重复点击不会再弹一个", async () => {
    const f = fixture({ nativeInvite: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    const invite = (): void => {
      button.dispatch("click", click);
      f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    };
    invite();
    invite();
    assert.equal(f.nativeInvites.length, 1);
    let sent = 0;
    f.finishNativeInvite(() => { sent += 1; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, 1);
    invite();
    assert.equal(f.nativeInvites.length, 2);
    assert.equal(f.webpackJsonp.length, 1);
  });

  it("取消原生邀请不会退出已创建的房间，之后可以再次邀请", async () => {
    const f = fixture({ nativeInvite: true, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    f.finishNativeInvite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.dispatched, []);
    assert.equal(f.api().pending, "");
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    assert.equal(f.nativeInvites.length, 2);
  });

  it("邀请窗口打开后退出房间，迟到的选择结果不能向旧房间发送邀请", async () => {
    const status: Status = { status: "togetherOwner", roomInfo: { roomId: "123456" } };
    const f = fixture({ nativeInvite: true, status });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
    status.status = "alone";
    status.roomInfo = undefined;
    let sent = 0;
    f.finishNativeInvite(() => { sent += 1; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, 0);
  });

  for (const errorMode of ["throw", "reject"] as const) {
    it(`原生邀请失败（${errorMode}）给出真实提示，并允许重试`, async () => {
      const f = fixture({ nativeInvite: true, nativeInviteError: errorMode, status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
      f.install();
      const button = f.bar.querySelector("[data-nemusic-together-button]")!;
      const click = { preventDefault() {}, stopPropagation() {} };
      button.dispatch("click", click);
      f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /原生邀请/);
      assert.deepEqual(f.copied, []);
      button.dispatch("click", click);
      f.body.querySelector('[data-nemusic-together-item="invite"]')!.dispatch("click", click);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.nativeInvites.length, 2);
    });
  }

  it("复制房间码和房间链接，链接把房主 uid 编进去", async () => {
    const f = fixture({ status: { status: "togetherOwner", roomInfo: { roomId: "123456" } } });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="code"]')!.dispatch("click", click);
    await Promise.resolve();
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="link"]')!.dispatch("click", click);
    await Promise.resolve();
    assert.equal(f.copied[0], "123456");
    // 加入端要拿 inviterId 过 accept 校验，房主复制链接时就得带上自己的 uid。
    assert.equal(f.copied[1], "https://st.music.163.com/listen-together/share/?songId=1900172235&roomId=123456&inviterId=10001");
  });

  it("未登录时不复制缺少房主 uid 的无效链接", async () => {
    const f = fixture({ status: { status: "togetherOwner", roomInfo: { roomId: "123456" } }, hostUid: null });
    f.install();
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    const click = { preventDefault() {}, stopPropagation() {} };
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="link"]')!.dispatch("click", click);
    await Promise.resolve();
    assert.deepEqual(f.copied, []);
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /房主账号/);
  });

  it("没有歌曲时不复制无法打开的邀请链接", async () => {
    const f = fixture({ status: { status: "togetherOwner", roomInfo: { roomId: "123456" } }, playing: { resourceDuration: 200, resourceTrackId: 0 } });
    f.install();
    const click = { preventDefault() {}, stopPropagation() {} };
    f.bar.querySelector("[data-nemusic-together-button]")!.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="link"]')!.dispatch("click", click);
    await Promise.resolve();
    assert.deepEqual(f.copied, []);
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /先播放/);
  });

  it("建房处理中隐藏创建和加入，成功后显示房间操作", () => {
    const status: Status = { status: "alone" };
    const f = fixture({ status });
    f.install();
    const click = { preventDefault() {}, stopPropagation() {} };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="start"]')!.dispatch("click", click);
    button.dispatch("click", click);
    assert.equal(f.body.querySelector('[data-nemusic-together-item="start"]'), null);
    assert.equal(f.body.querySelector('[data-nemusic-together-item="join"]'), null);
    assert.equal(f.body.querySelector('[data-nemusic-together-item="busy"]')?.disabled, true);
    status.status = "togetherOwner";
    status.roomInfo = { roomId: "123456", creatorId: "10001" };
    f.run(togetherButtonUpdateScript());
    assert.equal(f.body.querySelector('[data-nemusic-together-item="busy"]'), null);
    assert.ok(f.body.querySelector('[data-nemusic-together-item="invite"]'));
  });

  it("建房失败立即给出错误并恢复菜单，不必等待超时", () => {
    const f = fixture({ status: { status: "alone" } });
    f.install();
    const click = { preventDefault() {}, stopPropagation() {} };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="start"]')!.dispatch("click", click);
    button.dispatch("click", click);
    assert.ok(f.body.querySelector('[data-nemusic-together-item="busy"]'));
    f.run(togetherButtonFailureScript("创建失败，请重试"));
    assert.ok(f.body.querySelector('[data-nemusic-together-item="start"]'));
    assert.match(f.body.querySelector("[data-nemusic-together-toast]")!.textContent, /创建失败/);
  });

  it("退出处理中不重复提交，退出后恢复创建和加入", () => {
    const status: Status = { status: "togetherOwner", roomInfo: { roomId: "123456" } };
    const f = fixture({ status });
    f.install();
    const click = { preventDefault() {}, stopPropagation() {} };
    const button = f.bar.querySelector("[data-nemusic-together-button]")!;
    button.dispatch("click", click);
    f.body.querySelector('[data-nemusic-together-item="dissolve"]')!.dispatch("click", click);
    button.dispatch("click", click);
    assert.equal(f.body.querySelector('[data-nemusic-together-item="busy"]')?.disabled, true);
    status.status = "alone";
    status.roomInfo = undefined;
    f.run(togetherButtonUpdateScript());
    assert.ok(f.body.querySelector('[data-nemusic-together-item="start"]'));
    assert.ok(f.body.querySelector('[data-nemusic-together-item="join"]'));
  });

  it("取走动作时会清空，不会重复执行", () => {
    const f = fixture();
    f.install();
    const api = f.api();
    api.pending = "start";
    assert.equal(f.run<string>(TOGETHER_PENDING_SCRIPT), "start");
    assert.equal(api.pending, "");
    assert.equal(f.run<string>(TOGETHER_PENDING_SCRIPT), "");
  });

  it("没装按钮时取动作得到空串", () => {
    const f = fixture();
    assert.equal(f.run<string>(TOGETHER_PENDING_SCRIPT), "");
  });

  it("按钮里的图标就是 assets/icon/together.svg 那个素材", () => {
    // 图标是手抄进脚本的，抄错一个数字页面上一眼看不出来，所以拿素材原文比一遍路径。
    const asset = readFileSync(new URL("../../assets/icon/together.svg", import.meta.url), "utf8");
    // 脚本里它是 JSON.stringify 过的，先把转义去掉再比。
    const script = togetherButtonScript().replace(/\\"/g, '"');
    const icon = /<svg [^>]*aria-hidden[^>]*>.*?<\/svg>/.exec(script)?.[0] ?? "";
    const viewBox = /viewBox="([^"]+)"/.exec(asset)?.[1] ?? "";
    assert.match(icon, new RegExp(`viewBox="${viewBox}"`), "viewBox 要跟素材一致");
    assert.match(icon, /fill="currentColor"/, "素材里的 #ffffff 要换成 currentColor，否则在深色播放栏上会看不见");
    const paths = (source: string) => [...source.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(paths(icon), paths(asset), "图标路径和素材对不上");
  });

});
