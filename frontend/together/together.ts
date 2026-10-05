import { evaluateInPlayer, PLAYER_TARGET_MISSING } from "../player/player-target.ts";
import {
  IDENTITY_IDLE,
  TOGETHER_IDENTITY_APPLY_SCRIPT,
  normalizeIdentity,
  type IdentitySnapshot,
  type IdentityVariant,
} from "./identity-player.ts";
import { togetherButtonScript, togetherButtonUpdateScript } from "./together-button.ts";
import { parseTogetherCode, type TogetherCode } from "./together-code.ts";
import {
  TOGETHER_JOIN_SCRIPT,
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_CLEAR_SCRIPT,
  TOGETHER_ADOPT_SCRIPT,
  TOGETHER_PROBE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_SYNC_ARM_SCRIPT,
  TOGETHER_SYNC_NOTICE_SCRIPT,
  TOGETHER_SYNC_PULL_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
  type TogetherMember,
  type TogetherState,
} from "./together-player.ts";

/**
 * note 是给设置页看的中文说明，status 是网易云房间状态机的原始值——两个都叫 status
 * 会让交叉类型退化成联合类型，所以面向人的那个叫 note。
 */
export type TogetherSnapshot = TogetherState & {
  note: string;
  busy: boolean;
  identity: IdentitySnapshot;
  identityVariant: IdentityVariant;
  /** 播放栏按钮挂不上时的原因，空串表示在位。 */
  buttonNote: string;
  /** 按钮实际挂到哪个锚点上。 */
  buttonAnchor: string;
  /** 播放栏现状（按钮标题与 id），排查用。 */
  buttonBar: string;
  /** sync/notice 最近一次调用的结果，排查手机端不同步用。 */
  syncNote: string;
  /**
   * 服务端 status/get 说的房间状态：真话。页面 store 里的 status 是我们自己写进去的，
   * 加入没被服务端登记时它照样显示「在房间里」（真机上的「鬼房」）。
   */
  serverInRoom: boolean;
  serverRoomId: string;
  serverMembers: TogetherMember[];
};

const IDLE: TogetherState = {
  supported: false,
  loggedIn: false,
  accountId: "",
  status: "",
  inRoom: false,
  isHost: false,
  roomId: "",
  chatRoomId: "",
  creatorId: "",
  hostNickname: "",
  hostAvatarUrl: "",
  members: [],
  currentSongId: "",
  songIds: [],
  playing: false,
  positionMs: 0,
  localOnly: false,
  probe: [],
  action: "",
  error: "",
  diagnostic: "",
};

const TICK_MS = 1500;
const REMOTE_POLL_MS = 500;
/**
 * 按钮要「一开始就在」，等 1.5 秒的主 tick 会看见它凭空蹦出来。脚本没进去、或者进去了但播放栏
 * 还没渲染出来的时候，按这个间隔连着补几次；一直补不上（播放器压根没开）就停手交回主 tick，
 * 免得关着播放器还拿 CDP 打风暴。
 */
const BUTTON_FAST_MS = 300;
/** 脚本在页面里时的盯梢间隔：页面刷新要赶在播放栏渲染出来之前重新装上。 */
const BUTTON_WATCH_MS = 600;
/** 快速补装最多追这么多次，见 scheduleButton。 */
const BUTTON_FAST_LIMIT = 10;
/** 隔几个 tick 发一次 sync/notice。1.5s 一个 tick，5 就是 7.5s。 */
const NOTICE_EVERY = 5;
/** 加入房间最多重试几次。 */
const JOIN_MAX_RETRIES = 3;
/** 服务端连着几次说我们不在房间里，才把页面里那个假房间拆掉。 */
const GHOST_ROOM_TICKS = 2;
const NOT_READY = "打开播放器后可以使用一起听";

/** deviceId 要在一次会话里保持稳定，网易云拿它做风控画像，每个 tick 换一个反而更显眼。 */
function randomDeviceId(): string {
  let hex = "";
  for (let i = 0; i < 16; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

/** 页面里房间状态机的中文说法，失败时直接用它们解释发生了什么。 */
function describe(state: TogetherState): string {
  if (!state.loggedIn) return "请先在网易云播放器里登录";
  switch (state.status) {
    case "togetherOwner":
      return state.roomId ? `你是房主，房间号 ${state.roomId}` : "你是房主";
    case "together":
      return state.roomId ? `在 ${state.hostNickname || "对方"} 的房间里，房间号 ${state.roomId}` : "正在一起听";
    case "waiting":
      return "房间已建好，等待对方加入";
    case "timeout":
      return "对方长时间无响应，可以重新邀请";
    case "opening":
      return "正在创建房间";
    case "closing":
    case "closed":
      return "房间已结束";
    case "alone":
      return state.localOnly ? "本地歌曲不支持一起听，换一首网易云歌曲" : "当前不在房间里";
    default:
      return "打开播放器后可以使用一起听";
  }
}

/**
 * 把 TOGETHER_SYNC_PULL_SCRIPT 的回包翻成一句人话。设置页上就这一句能回答
 * 「为什么还是各听各的」：服务端认不认这个房间、房间里几个人、房间队列搬过来没有、
 * 房主在听什么、我们在听什么。
 */
function describePull(result: unknown): string {
  const r = result as {
    error?: string;
    reason?: string;
    via?: string;
    serverInRoom?: boolean;
    serverMembers?: number;
    serverRoomId?: string;
    serverShape?: Record<string, string>;
    serverRoomShape?: Record<string, string>;
    rebound?: boolean;
    queue?: number;
    local?: number;
    queueShape?: Record<string, string>;
    localShape?: Record<string, string>;
    target?: string;
    localHas?: boolean;
    follow?: string;
    aligned?: boolean;
    /** 页面认不认识对方：page=认得、sent=刚派了补人、missing=还是不认得。 */
    otherSide?: string;
    /** 房间歌单的可播权限条数，otherSide 不是 page 时几乎必然是 0。 */
    privileges?: number;
  } | null;
  if (!r) return "";
  if (r.error) return `拉取失败：${r.error}`;
  // 服务端视角先说：本地显示「在房间里」不算数，页面 status 是我们自己写进去的。
  const parts = [
    r.serverInRoom ? `服务端在房间 ${r.serverRoomId || ""} 里（${r.serverMembers ?? 0} 人）` : "服务端没有这个房间",
  ];
  if (r.rebound) parts.push("页面的房间信息丢了，已补回");
  if (r.queue !== undefined) parts.push(`房间队列 ${r.queue} 首（本地 ${r.local ?? 0} 首）`);
  if (r.target) parts.push(r.target === r.follow ? `已跟上 ${r.target}` : `正追上房主的 ${r.target}`);
  if (r.aligned) parts.push("已搬房间队列");
  // 房间名单读不到人时把服务端回包的字段名列出来：一起听的字段名换过好几次，
  // 认错了只能靠这个形状来对（只列字段名和类型，不带值）。
  if (r.serverInRoom && !r.serverMembers) {
    parts.push(`回包字段 ${JSON.stringify(r.serverRoomShape || r.serverShape || {})}`);
  }
  // otherMember 空时页面的 playTracks 会卡在权限那道门上（只暂停、进度归零，歌换不动），
  // 所以这一条和权限条数要摆在 reason 旁边，一眼能看出是不是卡在这。
  if (r.otherSide && r.otherSide !== "page") {
    parts.push(r.otherSide === "sent" ? "正在补对方信息" : "页面不知道对方是谁（otherMember 空），权限拉不到");
    if (r.privileges !== undefined) parts.push(`权限 ${r.privileges} 条`);
  }
  if (r.reason) parts.push(r.reason);
  // 切歌失败时把走过的档位带上：playTracks 还是 playByTrackId 停住的，指向的排查方向不一样。
  if (r.reason && r.via) parts.push(`走过 ${r.via}`);
  // 房间队列搬不过来的时候，把两个 slice 的字段名列出来——这是唯一能把「搬不过来」变成
  // 「字段名认错了」的办法，比再猜一轮靠谱。
  if (r.local === 0 && (r.queue ?? 0) > 0) {
    parts.push(`房间队列字段 ${JSON.stringify(r.queueShape || {})}`);
    parts.push(`本地队列字段 ${JSON.stringify(r.localShape || {})}`);
  }
  return parts.join("，");
}

export class TogetherBridge {
  private timer = 0;
  private generation = 0;
  private busy = false;
  private pending: "start" | "leave" | "join" | null = null;
  /** 加入要的房间码 + 房主 uid，随 pending === "join" 一起用。 */
  private pendingJoin: TogetherCode = { roomId: "", inviterId: "" };
  private state: TogetherState = IDLE;
  private status = NOT_READY;
  private started = false;
  private armedRoomId = "";
  /** 上一次看到的房间人数，用来发现有人进来。 */
  private memberCount = -1;
  /** 播放栏按钮攒下的动作（start / leave / join:<code>），等当前 tick 结束后立刻执行，省掉一个 1.5 秒的间隔。 */
  private queued: string | null = null;
  /** 播放栏按钮脚本是否已经装上过。 */
  private buttonReady = false;
  /** 按钮挂不上时的人话原因，显示在设置页上。 */
  private buttonNote = "";
  /** 按钮实际挂到了哪个锚点上，排查「按钮跑哪去了」用。 */
  private buttonAnchor = "";
  /** 播放栏里现有哪些按钮。播放栏在不同页面结构不一样，这一行是唯一可靠的现场信息。 */
  private buttonBar = "";
  /** 按钮的快速补装定时器，和主 tick 分开——页面刚打开那一段等不起 1.5 秒。 */
  private buttonTimer = 0;
  /** 快速补装和主 tick 都会调 ensureButton，这里挡掉重叠的那一次。 */
  private buttonBusy = false;
  /** 快速补装已经追了几次，见 scheduleButton。 */
  private buttonMisses = 0;
  private identityVariant: IdentityVariant = "off";
  private readonly identityDeviceId = randomDeviceId();
  private identity: IdentitySnapshot = IDENTITY_IDLE;
  private identityApplied = false;
  /** sync/notice 最近一次的结果文案，排查手机端不同步用。 */
  private syncNote = "";
  /** 拉房间快照最近一次的结果文案，排查加入房间后不同步用。 */
  private pullNote = "";
  private pulling: { generation: number; roomId: string } | null = null;
  private pullTimer = 0;
  /** 服务端连着几次说我们不在房间里了。 */
  private ghostRoomTicks = 0;
  /** 服务端 status/get 的答案：真房间还是鬼房间，房间里都有谁。 */
  private serverInRoom = false;
  private serverRoomId = "";
  private serverMembers: TogetherMember[] = [];
  /** 主 tick 的次数，隔几个 tick 发一次 sync/notice。 */
  private noticeTick = 0;
  /** 加入房间的重试计数，重试时不消 pending。 */
  private joinRetries = 0;
  /** 上一个 tick 是否在房间里，用来发现页面自己把房间丢了。 */
  private lastInRoom = false;

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
      this.generation++;
      this.state = IDLE;
      this.pending = null;
      this.pendingJoin = { roomId: "", inviterId: "" };
      this.started = false;
      this.armedRoomId = "";
      this.memberCount = -1;
      this.queued = null;
      this.buttonReady = false;
      this.buttonMisses = 0;
      window.clearTimeout(this.buttonTimer);
      this.buttonTimer = 0;
      this.syncNote = "";
      this.pullNote = "";
      this.serverInRoom = false;
      this.serverRoomId = "";
      this.serverMembers = [];
      this.ghostRoomTicks = 0;
      this.noticeTick = 0;
      this.joinRetries = 0;
      this.lastInRoom = false;
      window.clearInterval(this.pullTimer);
      this.pullTimer = 0;
    if (enabled) {
      this.status = "正在读取网易云一起听状态";
      this.timer = window.setInterval((): void => void this.tick(), TICK_MS);
      this.pullTimer = window.setInterval((): void => this.pullRemoteCommands(), REMOTE_POLL_MS);
      void this.tick();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.status = NOT_READY;
    }
  }

  snapshot(): TogetherSnapshot {
    return {
      ...this.state,
      note: this.status,
      busy: this.pending != null,
      identity: this.identity,
      identityVariant: this.identityVariant,
      buttonNote: this.buttonNote,
      buttonAnchor: this.buttonAnchor,
      buttonBar: this.buttonBar,
      // 两件事都写在这一个字段里：拉快照看加入房间后跟没跟上，notice 看手机端收不收得到。
      syncNote: [this.pullNote, this.syncNote].filter(Boolean).join("｜"),
      serverInRoom: this.serverInRoom,
      serverRoomId: this.serverRoomId,
      serverMembers: this.serverMembers,
    };
  }

  /**
   * 换身份变体。改完立刻打一次补丁，这样设置页的回读是真实生效后的值，而不是「我觉得
   * 我写进去了」。播放器没开的时候这次会失败，identityApplied 保持 false，等 tick 再补。
   */
  setIdentityVariant(variant: IdentityVariant): void {
    if (variant === this.identityVariant) return;
    this.identityVariant = variant;
    this.identityApplied = false;
    this.identity = { ...IDENTITY_IDLE, variant, note: "正在应用身份" };
    void this.ensureIdentity(this.generation);
  }

  start(): void {
    if (!this.timer || this.pending || this.hasRoom() || !this.state.loggedIn || this.state.localOnly) return;
    this.pending = "start";
    void this.tick();
  }

  leave(): void {
    if (!this.timer || this.pending || !this.hasRoom()) return;
    this.pending = "leave";
    this.clearRoomState();
    this.status = "正在退出房间";
    void this.tick();
  }

  /**
   * 加入别人的房间。链接/码的解析交给 parseTogetherCode（纯函数，单测覆盖）；这里只做
   * 守卫、把结果交给 tick。解析不出房间码就直接给一句人话，不白跑一次页面。
   */
  join(code: string): void {
    if (!this.timer || this.pending || this.hasRoom() || !this.state.loggedIn || this.state.localOnly) return;
    const parsed = parseTogetherCode(code);
    if (!parsed.roomId) {
      this.status = "请输入房间码或邀请链接";
      return;
    }
    this.pendingJoin = parsed;
    this.pending = "join";
    void this.tick();
  }

  /**
   * 首次读到状态时补一次 restore。页面自己也会在登录后调，但插件重启、用户中途登录
   * 的情况下补一次更稳妥——否则房间明明还在，我们这边一直显示「不在房间里」。
   */
  private maybeRestore(): boolean {
    if (this.started) return false;
    this.started = true;
    return this.state.supported && this.state.loggedIn;
  }

  private hasRoom(): boolean {
    return this.state.inRoom || !!this.state.roomId
      || this.state.status === "waiting" || this.state.status === "opening";
  }

  /**
   * 打身份补丁。每个 tick 都打太浪费 CDP，所以只在变体刚换、以及每次建房前打——建房那一下
   * 是真正决定服务端记到什么版本的时刻，页面中途重载把补丁冲掉也只会在建房时露馅。
   */
  private async ensureIdentity(generation: number): Promise<void> {
    try {
      const result = await evaluateInPlayer(
        TOGETHER_IDENTITY_APPLY_SCRIPT(this.identityVariant, this.identityDeviceId),
        { awaitPromise: true },
      );
      if (generation !== this.generation) return;
      this.identity = normalizeIdentity(result, this.identityVariant);
      this.identityApplied = true;
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
      this.identity = {
        ...IDENTITY_IDLE,
        variant: this.identityVariant,
        note: error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error),
      };
    }
  }

  /**
   * 进房之后调一次播放指令上报开关（见 TOGETHER_SYNC_ARM_SCRIPT）：房主打开、成员关掉。
   *
   * 房主一个房间补一次就够了——这个开关本来就该一直开着。
   * 成员要每个 tick 都看一眼：页面自己的 playTracks（我们采用房间队列时会走到）切完歌会把
   * isCanReport 打开，成员开着就会去抢服务端的 playCommand。派发前脚本自己会判重，值是对的就
   * 什么都不做，所以每个 tick 多这一次往返换来的是「成员一定没在上报」。
   */
  private armReport(): void {
    if (!this.state.inRoom || !this.state.roomId) {
      this.armedRoomId = "";
      return;
    }
    const firstTime = this.state.roomId !== this.armedRoomId;
    if (firstTime) this.armedRoomId = this.state.roomId;
    // 房主一个房间补一次就够了，这个开关本来就该一直开着。
    if (!firstTime && this.state.isHost) return;
    void evaluateInPlayer(TOGETHER_SYNC_ARM_SCRIPT).catch(() => {
      // 没派发成功就当作没补过，下个 tick 再试。
      this.armedRoomId = "";
    });
    // 探子跟开关一起装，省一次 CDP 往返；重复安装由页面自己挡掉，所以只装一次。
    if (firstTime) void evaluateInPlayer(TOGETHER_PROBE_SCRIPT).catch(() => {});
  }

  /**
   * 服务端说我们不在房间里，那就把页面里那个我们自己写进去的假房间拆掉。
   *
   * 之前 accept 回 200 就直接派 onUpdate 把状态设成 together，服务端到底认没认这次加入我们不知道，
   * 于是本地显示在房间里、成员列表里只有自己（还没有头像），对面手机上压根没有第二个人。这种房间
   * 留着只会让人以为还在房间里一直等同步，不如直接退出来，重新拿房间码加一次。
   */
  private leaveGhostRoom(): void {
    if (!this.hasRoom()) return;
    this.clearRoomState();
    this.status = "房间已结束或你已退出，已清理网页的一起听状态";
    void evaluateInPlayer(TOGETHER_CLEAR_SCRIPT, { awaitPromise: true }).catch(() => {});
  }

  private clearRoomState(): void {
    this.serverInRoom = false;
    this.serverRoomId = "";
    this.serverMembers = [];
    this.ghostRoomTicks = 0;
    this.state = {
      ...this.state, inRoom: false, isHost: false, status: "alone", roomId: "", chatRoomId: "", creatorId: "",
      hostNickname: "", hostAvatarUrl: "", members: [], songIds: [], action: "",
    };
    this.armedRoomId = "";
    this.memberCount = -1;
    this.lastInRoom = false;
    this.started = true;
    this.noticeTick = 0;
    this.pullNote = "";
    this.syncNote = "";
  }

  /**
   * 房间里就定期拉一次房间快照：房间队列和房主在播的歌都要追平（见 TOGETHER_SYNC_PULL_SCRIPT）。
   * 网页版的 IM 接收是空壳，这一票东西只能从 sync/playlist/get 拿。失败了不打扰界面，下个 tick
   * 再来；成功/失败都留一句人话在设置页上，不然「为什么不同步」只能靠猜。
   */
  private pullRemoteCommands(): void {
    if (!this.state.inRoom || !this.state.roomId) {
      this.pullNote = "";
      return;
    }
    if (this.pulling?.generation === this.generation) return;
    const pulling = { generation: this.generation, roomId: this.state.roomId };
    this.pulling = pulling;
    const active = (): boolean => pulling.generation === this.generation && this.state.inRoom
      && pulling.roomId === this.state.roomId && this.pending !== "leave" && this.pending !== "join";
    void evaluateInPlayer(TOGETHER_SYNC_PULL_SCRIPT, { awaitPromise: true })
      .then((result) => {
        if (!active()) return;
        const r = result as {
          serverInRoom?: boolean;
          serverChecked?: boolean;
          serverRoomId?: string;
          serverUsers?: TogetherMember[];
        } | null;
        // 服务端说不在房间里时把页面状态也纠正过来：不然设置页一直显示「在房间里」，
        // 让人以为还在房间、其实对面根本看不到我们。连着两次才拆，免得偶发一次问歪了就把
        // 好端端的房间拆了。
        if (r?.serverInRoom === false && r.serverChecked !== false) {
          this.ghostRoomTicks += 1;
          if (this.ghostRoomTicks >= GHOST_ROOM_TICKS) {
            this.leaveGhostRoom();
            return;
          }
        } else {
          this.ghostRoomTicks = 0;
        }
        if (r?.serverInRoom) {
          this.serverInRoom = true;
          this.serverRoomId = r.serverRoomId ?? "";
          this.serverMembers = Array.isArray(r.serverUsers) ? r.serverUsers : [];
        }
        this.pullNote = describePull(result);
      })
      .catch((error) => {
        if (!active()) return;
        this.pullNote = `拉取异常：${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        if (this.pulling === pulling) this.pulling = null;
      });
  }

  /**
   * 隔几个 tick 发一次 sync/notice，告诉服务端「这里有变化，推给其他客户端」。
   *
   * 网页版只能发不能收——IM 是空壳，收不到别的客户端发来的指令，这是 TOGETHER_SYNC_PULL_SCRIPT
   * 解决的问题。反过来也一样：别的客户端（手机原生端）收 IM 的，而服务端收到我们 HTTP
   * play/command/report 之后不一定推 IM——所以补 sync/notice 当触发点。每 NOTICE_EVERY 个 tick
   * 打一次，和 pullRemoteCommands 不一样——notice 是 fire-and-forget，不要求立即出结果。
   */
  private maybeSyncNotice(): void {
    if (!this.state.inRoom || !this.state.roomId) {
      this.noticeTick = 0;
      this.syncNote = "";
      return;
    }
    this.noticeTick += 1;
    if (this.noticeTick % NOTICE_EVERY !== 0) return;
    void evaluateInPlayer(TOGETHER_SYNC_NOTICE_SCRIPT, { awaitPromise: true }).then((result) => {
      const r = result as { sent?: boolean; error?: string };
      if (r?.sent) this.syncNote = "同步通知已发送";
      else if (r?.error) this.syncNote = `同步通知失败：${r.error}`;
      else this.syncNote = "";
    }).catch((error) => {
      this.syncNote = `同步通知异常：${error instanceof Error ? error.message : String(error)}`;
    });
  }

  /**
   * 有人进来就主动把房主在听的歌推给对方。
   *
   * 正常客户端靠 USER_JOIN_IN 房间消息触发这件事，而那个消息走 IM，网页版的 IM 是空壳，
   * 房主这边永远收不到，结果新加入的人一直播自己那首。非首次变化才发：刚进房时成员还在陆续
   * 到达，重复推会互相打断。
   *
   * 只有房主做。backupPlayList 拿的是自己的本地队列，成员推一遍就是把房主的歌单顶掉（见
   * TOGETHER_ADOPT_SCRIPT）。
   */
  private adoptForNewMember(): void {
    if (!this.state.inRoom || !this.state.isHost) {
      this.memberCount = -1;
      return;
    }
    const count = this.state.members.length;
    if (count === this.memberCount) return;
    const grew = this.memberCount >= 0 && count > this.memberCount;
    this.memberCount = count;
    if (grew) void evaluateInPlayer(TOGETHER_ADOPT_SCRIPT).catch(() => {});
  }

  /**
   * 让播放栏里那个一起听按钮保持在位。整份安装脚本很大，不能每 1.5 秒重发一次，所以第一次
   * 装、之后只发一小段更新脚本（和识曲那边一样的分工）。页面刷新会把自己那份 api 清掉，
   * 更新脚本会回来说「还没装上」，那就再装一次。
   *
   * 装不上就自己接着补几次（scheduleButton）：主 tick 1.5 秒一次，页面刷新后那段空白正好是
   * 用户看得见的「按钮凭空蹦出来」。脚本一旦进去就停手——之后由页面里的 MutationObserver
   * 负责把按钮按回原位，插件这边不再每 300 毫秒跑一趟。
   */
  private async ensureButton(generation: number): Promise<void> {
    if (this.buttonBusy) return;
    this.buttonBusy = true;
    let installed = false;
    try {
      const script = this.buttonReady ? togetherButtonUpdateScript() : togetherButtonScript();
      const result = (await evaluateInPlayer(script)) as
        | { ok: boolean; note?: string; anchor?: string; bar?: string }
        | null;
      if (generation !== this.generation) return;
      this.buttonReady = Boolean(result?.ok);
      this.buttonAnchor = result?.anchor ?? "";
      this.buttonBar = result?.bar ?? "";
      if (result?.note) this.buttonNote = result.note;
      else if (result?.ok) this.buttonNote = "";
      installed = Boolean(result?.ok);
    } catch (error) {
      // 播放器还没加载好是常态，不该把它变成设置页上的一句报错。
      if (generation === this.generation) this.buttonReady = false;
    } finally {
      this.buttonBusy = false;
    }
    if (generation === this.generation) this.scheduleButton(installed);
  }

  /**
   * 按钮的补装节奏，两段：
   *
   * - 脚本还没进到页面里 → 300ms 连着追几次。页面刷新、播放器刚打开都是这个状态，主 tick
   *   1.5 秒一次的话，那 1.5 秒正好是用户看得见的「按钮凭空蹦出来」。
   * - 脚本在页面里 → 600ms 盯着。页面一刷新，window 上那份 api 就没了，这个频率能赶在播放栏
   *   渲染出来之前把脚本重新装上，之后页面里的 MutationObserver 就能把按钮按到原位。
   *
   * 一直追不上（播放器压根没开）就停手交回主 tick，关着播放器的时候不能拿 CDP 打风暴。
   */
  private scheduleButton(installed: boolean): void {
    if (!this.timer) return;
    window.clearTimeout(this.buttonTimer);
    this.buttonTimer = 0;
    const delay = installed ? BUTTON_WATCH_MS : BUTTON_FAST_MS;
    if (installed) this.buttonMisses = 0;
    else if (this.buttonMisses >= BUTTON_FAST_LIMIT) return;
    else this.buttonMisses += 1;
    this.buttonTimer = window.setTimeout((): void => {
      if (this.timer) void this.ensureButton(this.generation);
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    const action = this.pending;
    try {
      if (action === "start" || action === "join" || !this.identityApplied) await this.ensureIdentity(generation);
      let result: unknown;
      if (action == null) {
        result = await evaluateInPlayer(TOGETHER_STATE_SCRIPT);
      } else if (action === "start") {
        // userGesture 走真，跟用户手点那个按钮一样——网易云建房前会弹确认框，
        // 没有用户手势的时候那个框可能直接被吞掉。
        result = await evaluateInPlayer(TOGETHER_START_SCRIPT, { awaitPromise: true, userGesture: true });
      } else if (action === "join") {
        result = await evaluateInPlayer(
          TOGETHER_JOIN_SCRIPT(this.pendingJoin.roomId, this.pendingJoin.inviterId),
          { awaitPromise: true, userGesture: true },
        );
      } else {
        result = await evaluateInPlayer(TOGETHER_LEAVE_SCRIPT, { awaitPromise: true, userGesture: true });
      }
      if (generation !== this.generation || (action == null && this.pending != null)) return;
      if (action == null) {
        this.state = result as TogetherState;
        this.status = describe(this.state);
        // 上一个 tick 还在房间里、这个 tick 没了、又不是我们主动退的——页面把房间弄丢了
        // （刷新、切页、slot 被回收都可能）。补一次 restore 让页面自己把房间捞回来。
        if (this.lastInRoom && !this.state.inRoom && this.pending !== "leave") {
          void evaluateInPlayer(TOGETHER_RESTORE_SCRIPT, { awaitPromise: true }).catch(() => {});
          this.status = "正在恢复房间连接";
        }
        this.lastInRoom = this.state.inRoom;
        if (this.maybeRestore()) void evaluateInPlayer(TOGETHER_RESTORE_SCRIPT, { awaitPromise: true }).catch(() => {});
        this.armReport();
        this.pullRemoteCommands();
        this.maybeSyncNotice();
        this.adoptForNewMember();
        await this.ensureButton(generation);
        // 按钮那边只能记下「想建房 / 退房 / 加房」，执行还是得走这里——身份补丁必须在建房前打好，
        // 加入也要过一次同样的 tick 通道。按钮把房间码拼成 "join:<code>" 摞在 action 上。
        const act = this.state.action;
        if (act === "start" || act === "leave" || act.startsWith("join:")) {
          this.queued = act;
        }
      } else {
        const response = result as { ok: boolean; error?: string; retryable?: boolean };
        if (response?.ok) {
          this.joinRetries = 0;
          // 建房/退房/进房的结果要等页面自己跑完 saga，所以再读一次状态当作确认。
          this.state = (await evaluateInPlayer(TOGETHER_STATE_SCRIPT)) as TogetherState;
          if (generation !== this.generation) return;
          if (action === "start") this.status = "已请求建房";
          else if (action === "join") this.status = "已加入房间";
          else {
            this.clearRoomState();
            this.status = "已退出房间";
          }
          this.armReport();
        } else if (action === "join" && response?.retryable && this.joinRetries < JOIN_MAX_RETRIES) {
          this.joinRetries += 1;
          this.status = `${response?.error || "加入失败"}（第 ${this.joinRetries} 次重试）`;
          // 不清 pending，下个 tick 自动重试（约 1.5s 后）。
        } else {
          this.joinRetries = 0;
          this.status = response?.error || "一起听操作失败";
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
      if (generation === this.generation) {
        this.status = error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
      }
    } finally {
      // 加入房间重试时 pending 还挂在 "join" 上，别清掉，否则下个 tick 就不知道该重试了。
      const retrying = this.pending === "join" && this.joinRetries > 0;
      if (generation === this.generation && this.pending === action && !retrying) this.pending = null;
      this.busy = false;
      // 按钮点完如果正好赶上一个 tick 的尾巴，就立刻把动作做掉，不然用户要干等一个间隔。
      const queued = this.queued;
      if (generation === this.generation && queued != null) {
        this.queued = null;
        if (queued === "start") this.start();
        else if (queued.startsWith("join:")) this.join(queued.slice("join:".length));
        else this.leave();
      } else if (generation === this.generation && this.pending != null && !retrying) {
        void this.tick();
      }
    }
  }
}
