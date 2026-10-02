import { evaluateInPlayer, PLAYER_TARGET_MISSING } from "../player/player-target.ts";
import {
  TOGETHER_LEAVE_SCRIPT,
  TOGETHER_RESTORE_SCRIPT,
  TOGETHER_START_SCRIPT,
  TOGETHER_STATE_SCRIPT,
  type TogetherState,
} from "./together-player.ts";

/**
 * note 是给设置页看的中文说明，status 是网易云房间状态机的原始值——两个都叫 status
 * 会让交叉类型退化成联合类型，所以面向人的那个叫 note。
 */
export type TogetherSnapshot = TogetherState & { note: string; busy: boolean };

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
  error: "",
};

const TICK_MS = 1500;
const NOT_READY = "打开播放器后可以使用一起听";

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
  private pending: "start" | "leave" | null = null;
  private state: TogetherState = IDLE;
  private status = NOT_READY;
  private started = false;

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
    this.generation++;
    this.state = IDLE;
    this.pending = null;
    this.started = false;
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
    return { ...this.state, note: this.status, busy: this.pending != null };
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
   * 首次读到状态时补一次 restore。页面自己也会在登录后调，但插件重启、用户中途登录
   * 的情况下补一次更稳妥——否则房间明明还在，我们这边一直显示「不在房间里」。
   */
  private maybeRestore(): boolean {
    if (this.started) return false;
    this.started = true;
    return this.state.supported && this.state.loggedIn;
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    const action = this.pending;
    try {
      let result: unknown;
      if (action == null) {
        result = await evaluateInPlayer(TOGETHER_STATE_SCRIPT);
      } else if (action === "start") {
        // userGesture 走真，跟用户手点那个按钮一样——网易云建房前会弹确认框，
        // 没有用户手势的时候那个框可能直接被吞掉。
        result = await evaluateInPlayer(TOGETHER_START_SCRIPT, { awaitPromise: true, userGesture: true });
      } else {
        result = await evaluateInPlayer(TOGETHER_LEAVE_SCRIPT, { awaitPromise: true, userGesture: true });
      }
      if (generation !== this.generation) return;
      if (action == null) {
        this.state = result as TogetherState;
        this.status = describe(this.state);
        if (this.maybeRestore()) void evaluateInPlayer(TOGETHER_RESTORE_SCRIPT).catch(() => {});
      } else {
        const response = result as { ok: boolean; error?: string };
        if (response?.ok) {
          // 建房/退房的结果要等页面自己跑完 saga，所以再读一次状态当作确认。
          this.state = (await evaluateInPlayer(TOGETHER_STATE_SCRIPT)) as TogetherState;
          this.status = action === "start" ? "已请求建房" : "已请求退出房间";
        } else {
          this.status = response?.error || "一起听操作失败";
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
      if (generation === this.generation) {
        this.status = error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
      }
    } finally {
      if (generation === this.generation) this.pending = null;
      this.busy = false;
    }
  }
}
