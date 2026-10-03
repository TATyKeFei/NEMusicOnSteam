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
  TOGETHER_ADOPT_SCRIPT,
  TOGETHER_PROBE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_SYNC_ARM_SCRIPT,
  TOGETHER_SYNC_NOTICE_SCRIPT,
  TOGETHER_SYNC_PULL_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
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
      this.noticeTick = 0;
      this.joinRetries = 0;
      this.lastInRoom = false;
    if (enabled) {
      this.status = "正在读取网易云一起听状态";
      this.timer = window.setInterval((): void => void this.tick(), TICK_MS);
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
      syncNote: this.syncNote,
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
    if (!this.timer || this.pending || this.state.inRoom || !this.state.loggedIn || this.state.localOnly) return;
    this.pending = "start";
    void this.tick();
  }

  leave(): void {
    if (!this.timer || this.pending || !this.state.inRoom) return;
    this.pending = "leave";
    void this.tick();
  }

  /**
   * 加入别人的房间。链接/码的解析交给 parseTogetherCode（纯函数，单测覆盖）；这里只做
   * 守卫、把结果交给 tick。解析不出房间码就直接给一句人话，不白跑一次页面。
   */
  join(code: string): void {
    if (!this.timer || this.pending || this.state.inRoom || !this.state.loggedIn || this.state.localOnly) return;
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
   * 进房之后补一次播放指令上报开关（见 TOGETHER_SYNC_ARM_SCRIPT）。按 roomId 只补一次：
   * 页面自己在 playTracks 里会重新维护这个开关，我们不该每 1.5 秒去盖它一遍。
   */
  private armReport(): void {
    if (!this.state.inRoom || !this.state.roomId) {
      this.armedRoomId = "";
      return;
    }
    if (this.state.roomId === this.armedRoomId) return;
    this.armedRoomId = this.state.roomId;
    void evaluateInPlayer(TOGETHER_SYNC_ARM_SCRIPT).catch(() => {
      // 没派发成功就当作没补过，下个 tick 再试。
      this.armedRoomId = "";
    });
    // 探子跟开关一起装，省一次 CDP 往返；重复安装由页面自己挡掉。
    void evaluateInPlayer(TOGETHER_PROBE_SCRIPT).catch(() => {});
  }

  /**
   * 房间里就定期拉一次别人的播放指令。网页版的 IM 接收是空壳，这一票指令只能从
   * sync/playlist/get 拿（见 TOGETHER_SYNC_PULL_SCRIPT）。失败了不打扰界面，下个 tick 再来。
   */
  private pullRemoteCommands(): void {
    if (!this.state.inRoom || !this.state.roomId) return;
    void evaluateInPlayer(TOGETHER_SYNC_PULL_SCRIPT, { awaitPromise: true }).catch(() => {});
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
   */
  private adoptForNewMember(): void {
    if (!this.state.inRoom) {
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
      if (generation !== this.generation) return;
      if (action == null) {
        this.state = result as TogetherState;
        this.status = describe(this.state);
        // 上一个 tick 还在房间里、这个 tick 没了、又不是我们主动退的——页面把房间弄丢了
        // （刷新、切页、slot 被回收都可能）。补一次 restore 让页面自己把房间捞回来。
        if (this.lastInRoom && !this.state.inRoom && this.pending !== "leave") {
          void evaluateInPlayer(TOGETHER_RESTORE_SCRIPT).catch(() => {});
          this.status = "正在恢复房间连接";
        }
        this.lastInRoom = this.state.inRoom;
        if (this.maybeRestore()) void evaluateInPlayer(TOGETHER_RESTORE_SCRIPT).catch(() => {});
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
          if (action === "start") this.status = "已请求建房";
          else if (action === "join") this.status = "已加入房间";
          else this.status = "已请求退出房间";
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
      if (generation === this.generation && !retrying) this.pending = null;
      this.busy = false;
      // 按钮点完如果正好赶上一个 tick 的尾巴，就立刻把动作做掉，不然用户要干等一个间隔。
      const queued = this.queued;
      if (generation === this.generation && queued != null) {
        this.queued = null;
        if (queued === "start") this.start();
        else if (queued.startsWith("join:")) this.join(queued.slice("join:".length));
        else this.leave();
      }
    }
  }
}
