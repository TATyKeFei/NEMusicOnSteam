import { mprisHelper } from "../runtime/mpris-helper.ts";
import { HelperConnectionError, type HelperConnection } from "../runtime/helper-client.ts";
import { releasePlayerSession, tryEvaluateInPlayer } from "../player/player-target.ts";
import type { NotificationMode } from "../settings.ts";
import { steamToast } from "../widget/toast.ts";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { commandScript, LYRICS_SCRIPT, type Command } from "./mpris-player.ts";

export type TrackState = {
  active: boolean;
  playbackStatus: "Playing" | "Paused" | "Stopped";
  title: string;
  artist: string;
  lyrics: string;
  album: string;
  artUrl: string;
  trackId: string;
  duration: number;
  position: number;
  canSeek: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  volume: number | null;
  loopStatus: "None" | "Track" | "Playlist";
  shuffle: boolean;
  rate: number;
};

const FAILURE_REASONS: Record<string, string> = {
  retry: "MPRIS 辅助进程启动失败，正在重试",
  "asset-helper": "插件包缺少 backend/mpris_helper.py",
  "asset-recognition": "插件包缺少 backend/recognition.py",
  "write-helper": "无法写入辅助进程脚本",
  "write-recognition": "无法写入识曲模块",
  "write-token": "无法写入辅助进程令牌",
  spawn: "辅助进程启动后没有监听端口",
};

/** 辅助进程起不来时，mpris_endpoint 会返回 "!<code>:<detail>"。 */
function describeFailure(result: string): string {
  const match = /^!([a-z-]+)(?::(.*))?$/.exec(result);
  const code = match?.[1] ?? "";
  const detail = match?.[2] ?? "";
  if (code === "mkdir") return `MPRIS 不可用：无法创建运行目录 ${detail}`;
  const reason = FAILURE_REASONS[code];
  if (reason) return `MPRIS 不可用：${reason}${detail ? `（${detail}）` : ""}`;
  return "MPRIS 不可用；请检查 Python 3、PyGObject 和用户会话 D-Bus";
}

const EMPTY_STATE: TrackState = {
  active: false,
  playbackStatus: "Stopped",
  title: "",
  artist: "",
  lyrics: "",
  album: "",
  artUrl: "",
  trackId: "",
  duration: 0,
  position: 0,
  canSeek: false,
  canGoNext: false,
  canGoPrevious: false,
  volume: 1,
  loopStatus: "None",
  shuffle: false,
  rate: 1,
};

export type ExternalPlayback = {
  snapshot(): TrackState;
  command(command: Command): Promise<boolean>;
};

export class MprisBridge {
  private timer = 0;
  private busy = false;
  private enabled = false;
  private connection: HelperConnection | null = null;
  private state: TrackState = EMPTY_STATE;
  private lastLyricsTrackId = "";
  private settledLyricsTrackId = "";
  private lastLyricsAttemptAt = 0;
  private lyricsBusy = false;
  private fetchedLyrics: { trackId: string; text: string } | null = null;
  private lastSentLyrics: string | null = null;
  private lastSentState: string | null = null;
  private lastToastedTrack = "";
  private status = "尚未连接";
  private connectionFailed = false;
  private reconnectRequested = false;
  private commandError = "";
  private commandRequest: AbortController | null = null;
  private pendingCommands: Command[] = [];
  private external: ExternalPlayback | null = null;

  private readonly open: () => void;
  private readonly close: () => void;
  private readonly notifyMode: () => NotificationMode;

  constructor(open: () => void, close: () => void, notifyMode: () => NotificationMode = () => "system") {
    this.open = open;
    this.close = close;
    this.notifyMode = notifyMode;
  }

  start(): void {
    if (this.timer) return;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 MPRIS";
      return;
    }
    this.timer = window.setInterval((): void => void this.tick(), 500);
    void this.tick();
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.connectionFailed = false;
    this.reconnectRequested = false;
    this.commandRequest?.abort();
    this.pendingCommands = [];
    const connection = this.connection;
    this.connection = null;
    mprisHelper.invalidate();
    this.lastSentLyrics = null;
    this.lastSentState = null;
    this.fetchedLyrics = null;
    this.lastToastedTrack = "";
    releasePlayerSession();
    if (connection) {
      try {
        await mprisHelper.request("/shutdown", { method: "POST", keepalive: true }, connection);
      } catch {}
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setExternalPlayback(external: ExternalPlayback | null): void {
    this.external = external;
    this.lastSentState = null;
    this.lastSentLyrics = null;
    this.lastLyricsTrackId = "";
    this.settledLyricsTrackId = "";
    this.fetchedLyrics = null;
  }

  getStatus(): string {
    return this.status;
  }

  canReconnect(): boolean {
    return Boolean(this.timer && this.connectionFailed && !this.reconnectRequested);
  }

  reconnect(): void {
    if (!this.canReconnect()) return;
    this.connectionFailed = false;
    this.reconnectRequested = true;
    this.status = "正在重新连接 MPRIS";
    void this.tick();
  }

  private async connect(): Promise<boolean> {
    const reconnect = this.reconnectRequested;
    if (reconnect) {
      this.reconnectRequested = false;
      this.connectionFailed = false;
      this.status = "正在重新连接 MPRIS";
      this.commandRequest?.abort();
      this.commandRequest = null;
      this.pendingCommands = [];
      this.connection = null;
      this.commandError = "";
    }
    if (this.connection && this.connection === mprisHelper.peek()) return true;
    try {
      const connection = await mprisHelper.connect(reconnect);
      if (!this.timer) return false;
      this.commandRequest?.abort();
      this.commandRequest = null;
      this.pendingCommands = [];
      this.connection = connection;
      this.lastSentLyrics = null;
      this.lastSentState = null;
      return true;
    } catch (error) {
      if (!(error instanceof HelperConnectionError)) throw error;
      this.status = describeFailure(error.result);
      this.connectionFailed = true;
      return false;
    }
  }

  private async request(path: string, body?: Partial<TrackState>): Promise<Response> {
    return mprisHelper.request(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }, this.connection!);
  }

  // 歌词在后台抓取：LYRICS_SCRIPT 会等待页面自己调 /api/song/lyric（2 秒超时），在 tick
  // 里 await 它会导致每次切歌后，命令处理和进度更新都被这次请求卡住那么久。现在 tick
  // 在歌词这件事上保持同步，抓取任务把结果存到一旁，由下一个 tick 发布。
  private requestLyrics(snapshot: TrackState): void {
    const trackId = snapshot.trackId;
    if (!trackId) {
      this.lastLyricsTrackId = "";
      this.settledLyricsTrackId = "";
      this.fetchedLyrics = null;
      snapshot.lyrics = "";
      return;
    }
    const fetched = this.fetchedLyrics?.trackId === trackId ? this.fetchedLyrics.text : "";
    snapshot.lyrics = fetched || (this.state.trackId === trackId ? this.state.lyrics : "");
    const trackChanged = trackId !== this.lastLyricsTrackId;
    const settled = this.settledLyricsTrackId === trackId;
    const retry = !settled && !fetched && Date.now() - this.lastLyricsAttemptAt >= 1500;
    if ((!trackChanged && !retry) || this.lyricsBusy) return;
    this.lastLyricsTrackId = trackId;
    this.lastLyricsAttemptAt = Date.now();
    void this.fetchLyrics(trackId);
  }

  private async fetchLyrics(trackId: string): Promise<void> {
    this.lyricsBusy = true;
    try {
      let result: unknown = null;
      try {
        result = await tryEvaluateInPlayer(LYRICS_SCRIPT, { awaitPromise: true });
      } catch {
        result = null;
      }
      if (!this.timer) return;
      const payload = result as { lyric?: unknown; resolved?: unknown } | null;
      const lyrics = typeof payload?.lyric === "string" ? payload.lyric.trim() : "";
      if (payload?.resolved === true) this.settledLyricsTrackId = trackId;
      this.fetchedLyrics = lyrics ? { trackId, text: lyrics } : null;
    } finally {
      this.lyricsBusy = false;
    }
  }

  private async listenForCommands(): Promise<void> {
    if (this.commandRequest || !this.timer || !this.connection) return;
    const connection = this.connection;
    const controller = new AbortController();
    this.commandRequest = controller;
    try {
      while (this.timer && !controller.signal.aborted) {
        const response = await mprisHelper.request("/commands?wait=1", {
          signal: controller.signal,
        }, connection);
        if (!response.ok) throw new Error(`MPRIS command poll failed: ${response.status}`);
        const commands = (await response.json()) as Command[];
        if (controller.signal.aborted || !this.timer) return;
        if (commands.length) {
          this.pendingCommands.push(...commands);
          await this.tick();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[NEMusic] MPRIS commands", error);
    } finally {
      if (this.commandRequest === controller) this.commandRequest = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      const connected = await this.connect();
      if (!this.timer) return;
      if (connected) {
        void this.listenForCommands();
        while (this.pendingCommands.length) {
          const command = this.pendingCommands.shift()!;
          if (command.action === "open") this.open();
          else if (command.action === "close") this.close();
          else {
            const handled = this.external
              ? await this.external.command(command)
              : await tryEvaluateInPlayer(commandScript(command), { userGesture: true, awaitPromise: true });
            if (["volume", "seek", "setposition"].includes(command.action)) {
              this.commandError = handled ? "" : `MPRIS ${command.action} 未执行；未找到可用的网易云播放器状态`;
              if (!handled) console.warn("[NEMusic] MPRIS command not handled", command.action);
            }
          }
        }
      }
      // 播放器关闭时没有页面可读，直接上报 Stopped，不必每个 tick 都跑一趟 CDP。
      const snapshot = this.external
        ? this.external.snapshot()
        : this.enabled
          ? ((await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true })) as TrackState | null) ?? EMPTY_STATE
          : EMPTY_STATE;
      this.requestLyrics(snapshot);
      this.state = snapshot;
      if (!this.timer) return;
      this.maybeToastTrack(snapshot);
      if (!connected) return;
      const payload: Partial<TrackState> & { notify: NotificationMode } = { ...this.state, notify: this.notifyMode() };
      if (this.lastSentLyrics === this.state.lyrics) delete payload.lyrics;
      // 没打开播放器的安装会永远上报同一个停止状态；每秒上报两次，只是让一份上传和
      // 它的响应体一直留在 Steam UI 渲染器的堆里。
      const encoded = JSON.stringify(payload);
      if (encoded !== this.lastSentState) {
        const update = await this.request("/state", payload);
        // 没人读的响应体会一直留在渲染器堆里等 GC，不管怎样都把它读掉。
        await update.arrayBuffer().catch(() => {});
        if (!update.ok) throw new Error(`MPRIS state update failed: ${update.status}`);
        this.lastSentState = encoded;
      }
      this.lastSentLyrics = this.state.lyrics;
      this.status = this.commandError || "MPRIS 已连接";
      this.connectionFailed = false;
    } catch (error) {
      console.warn("[NEMusic] MPRIS bridge", error);
      this.status = "MPRIS 连接失败；请检查 Steam 控制台和辅助进程日志或去Github反馈";
      this.connectionFailed = true;
      this.commandRequest?.abort();
      if (this.connection) mprisHelper.invalidate(this.connection);
      this.connection = null;
    } finally {
      this.busy = false;
      if (this.timer && (this.reconnectRequested || (this.pendingCommands.length && this.connection))) void this.tick();
    }
  }

  // Steam 弹窗放在这里触发，这样即使 Python 辅助进程不可用也能工作；
  // "system" 模式下的桌面通知仍然由辅助进程自己发出。
  private maybeToastTrack(state: TrackState): void {
    if (this.notifyMode() !== "steam") return;
    if (!state.active || state.playbackStatus !== "Playing" || !state.title) return;
    const track = [state.trackId, state.title, state.artist].join("\u0000");
    if (track === this.lastToastedTrack) return;
    this.lastToastedTrack = track;
    steamToast(state.title, state.artist, /^https?:/.test(state.artUrl) ? state.artUrl : undefined);
  }
}
