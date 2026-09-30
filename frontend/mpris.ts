import { ffi } from "millennium";
import { releasePlayerSession, tryEvaluateInPlayer } from "./player-target.ts";
import { commandScript, LYRICS_SCRIPT, SNAPSHOT_SCRIPT, type Command } from "./mpris-player.ts";

type TrackState = {
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

const getEndpoint = ffi<[], string>("mpris_endpoint");

const FAILURE_REASONS: Record<string, string> = {
  retry: "MPRIS 辅助进程启动失败，正在重试",
  "asset-helper": "插件包缺少 backend/mpris_helper.py",
  "asset-recognition": "插件包缺少 backend/recognition.py",
  "write-helper": "无法写入辅助进程脚本",
  "write-recognition": "无法写入识曲模块",
  "write-token": "无法写入辅助进程令牌",
  spawn: "辅助进程启动后没有监听端口",
};

/** mpris_endpoint returns "!<code>:<detail>" when the helper cannot start. */
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

export class MprisBridge {
  private timer = 0;
  private busy = false;
  private enabled = false;
  private endpoint: string | null = null;
  private token: string | null = null;
  private state: TrackState = EMPTY_STATE;
  private lastLyricsTrackId = "";
  private settledLyricsTrackId = "";
  private lastLyricsAttemptAt = 0;
  private lastSentLyrics: string | null = null;
  private lastSentState: string | null = null;
  private status = "尚未连接";
  private commandError = "";
  private commandRequest: AbortController | null = null;
  private pendingCommands: Command[] = [];

  private readonly open: () => void;
  private readonly close: () => void;

  constructor(open: () => void, close: () => void) {
    this.open = open;
    this.close = close;
  }

  start(): void {
    if (this.timer) return;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 MPRIS";
      return;
    }
    this.timer = window.setInterval(() => void this.tick(), 500);
    void this.tick();
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.commandRequest?.abort();
    this.pendingCommands = [];
    const endpoint = this.endpoint;
    const token = this.token;
    this.endpoint = null;
    this.token = null;
    this.lastSentLyrics = null;
    this.lastSentState = null;
    releasePlayerSession();
    if (endpoint && token) {
      try {
        await fetch(`${endpoint}/shutdown`, { method: "POST", headers: { "X-NEMusic-Token": token } });
      } catch {}
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getStatus(): string {
    return this.status;
  }

  private async connect(): Promise<boolean> {
    if (this.endpoint && this.token) return true;
    const result = await getEndpoint();
    if (!this.timer) return false;
    const separator = result.lastIndexOf("|");
    if (separator < 0) {
      this.status = describeFailure(result);
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    this.lastSentLyrics = null;
    this.lastSentState = null;
    return true;
  }

  private async request(path: string, body?: Partial<TrackState>): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "X-NEMusic-Token": this.token!, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async updateLyrics(snapshot: TrackState): Promise<void> {
    const trackId = snapshot.trackId;
    if (!trackId) {
      this.lastLyricsTrackId = "";
      this.settledLyricsTrackId = "";
      snapshot.lyrics = "";
      return;
    }
    const now = Date.now();
    const trackChanged = trackId !== this.lastLyricsTrackId;
    const settled = this.settledLyricsTrackId === trackId;
    const retry = !settled && !this.state.lyrics && now - this.lastLyricsAttemptAt >= 1500;
    if (!trackChanged && !retry) {
      snapshot.lyrics = this.state.trackId === trackId ? this.state.lyrics : "";
      return;
    }
    this.lastLyricsTrackId = trackId;
    this.lastLyricsAttemptAt = now;
    let result: unknown = null;
    try {
      result = await tryEvaluateInPlayer(LYRICS_SCRIPT, { awaitPromise: true });
    } catch {
      result = null;
    }
    const payload = result as { lyric?: unknown; resolved?: unknown } | null;
    const lyrics = typeof payload?.lyric === "string" ? payload.lyric.trim() : "";
    if (payload?.resolved === true) this.settledLyricsTrackId = trackId;
    snapshot.lyrics = lyrics || (this.state.trackId === trackId ? this.state.lyrics : "");
  }

  private async listenForCommands(): Promise<void> {
    if (this.commandRequest || !this.timer || !this.endpoint || !this.token) return;
    const controller = new AbortController();
    this.commandRequest = controller;
    try {
      while (this.timer && !controller.signal.aborted) {
        const response = await fetch(`${this.endpoint}/commands?wait=1`, {
          headers: { "X-NEMusic-Token": this.token! },
          signal: controller.signal,
        });
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
      if (!(await this.connect())) return;
      if (!this.timer) return;
      void this.listenForCommands();
      while (this.pendingCommands.length) {
        const command = this.pendingCommands.shift()!;
        if (command.action === "open") this.open();
        else if (command.action === "close") this.close();
        else {
          const handled = await tryEvaluateInPlayer(commandScript(command), { userGesture: true, awaitPromise: true });
          if (["volume", "seek", "setposition"].includes(command.action)) {
            this.commandError = handled ? "" : `MPRIS ${command.action} 未执行；未找到可用的网易云播放器状态`;
            if (!handled) console.warn("[NEMusic] MPRIS command not handled", command.action);
          }
        }
      }
      // A closed player has no page to read; report Stopped without a CDP round trip per tick.
      const snapshot = this.enabled
        ? ((await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true })) as TrackState | null) ?? EMPTY_STATE
        : EMPTY_STATE;
      await this.updateLyrics(snapshot);
      this.state = snapshot;
      if (!this.timer) return;
      const payload: Partial<TrackState> = { ...this.state };
      if (this.lastSentLyrics === this.state.lyrics) delete payload.lyrics;
      // An install with no player open reports the same stopped state forever; posting it twice a
      // second only keeps an upload and its response body alive in the Steam UI renderer.
      const encoded = JSON.stringify(payload);
      if (encoded !== this.lastSentState) {
        const update = await this.request("/state", payload);
        // A response body nobody reads stays in the renderer's heap until GC; drain it either way.
        await update.arrayBuffer().catch(() => {});
        if (!update.ok) throw new Error(`MPRIS state update failed: ${update.status}`);
        this.lastSentState = encoded;
      }
      this.lastSentLyrics = this.state.lyrics;
      this.status = this.commandError || "MPRIS 已连接";
    } catch (error) {
      console.warn("[NEMusic] MPRIS bridge", error);
      this.status = "MPRIS 连接失败；请检查 Steam 控制台和辅助进程日志或去Github反馈";
      this.commandRequest?.abort();
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
      if (this.pendingCommands.length && this.timer && this.endpoint) void this.tick();
    }
  }
}
