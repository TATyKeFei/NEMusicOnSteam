import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";
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
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private state: TrackState = EMPTY_STATE;
  private lastLyricsTrackId = "";
  private settledLyricsTrackId = "";
  private lastLyricsAttemptAt = 0;
  private lastSentLyrics: string | null = null;
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
    await this.detach();
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
      this.status = "MPRIS 不可用；请检查 Python 3、PyGObject 和用户会话 D-Bus";
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    this.lastSentLyrics = null;
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
      result = await this.evaluate(LYRICS_SCRIPT);
    } catch {
      result = null;
    }
    const payload = result as { lyric?: unknown; resolved?: unknown } | null;
    const lyrics = typeof payload?.lyric === "string" ? payload.lyric.trim() : "";
    if (payload?.resolved === true) this.settledLyricsTrackId = trackId;
    snapshot.lyrics = lyrics || (this.state.trackId === trackId ? this.state.lyrics : "");
  }

  private async attach(): Promise<void> {
    if (!this.enabled) {
      await this.detach();
      return;
    }
    const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
    const target = targets.targetInfos.find((item) => isPlayerDocument(item.url));
    if (target?.targetId === this.targetId) return;
    await this.detach();
    if (!target) return;
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    this.targetId = target.targetId;
    this.sessionId = attached.sessionId;
  }

  private async detach(): Promise<void> {
    const sessionId = this.sessionId;
    this.targetId = null;
    this.sessionId = null;
    if (sessionId) {
      try {
        await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId });
      } catch {}
    }
  }

  private async evaluate(expression: string, userGesture = false): Promise<unknown> {
    if (!this.sessionId) return null;
    const result = await ChromeDevToolsProtocol.send("Runtime.evaluate", { expression, returnByValue: true, userGesture, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
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
      if (!this.sessionId || !this.pendingCommands.length || !this.enabled) await this.attach();
      if (!this.timer) {
        await this.detach();
        return;
      }
      while (this.pendingCommands.length) {
        const command = this.pendingCommands.shift()!;
        if (command.action === "open") this.open();
        else if (command.action === "close") this.close();
        else if (this.sessionId) {
          const handled = await this.evaluate(commandScript(command), true);
          if (["volume", "seek", "setposition"].includes(command.action)) {
            this.commandError = handled ? "" : `MPRIS ${command.action} 未执行；未找到可用的网易云播放器状态`;
            if (!handled) console.warn("[NEMusic] MPRIS command not handled", command.action);
          }
        }
      }
      const snapshot = this.sessionId ? (await this.evaluate(SNAPSHOT_SCRIPT)) as TrackState : EMPTY_STATE;
      await this.updateLyrics(snapshot);
      this.state = snapshot;
      if (!this.timer) return;
      const payload: Partial<TrackState> = { ...this.state };
      if (this.lastSentLyrics === this.state.lyrics) delete payload.lyrics;
      const update = await this.request("/state", payload);
      if (!update.ok) throw new Error(`MPRIS state update failed: ${update.status}`);
      this.lastSentLyrics = this.state.lyrics;
      this.status = this.commandError || "MPRIS 已连接";
    } catch (error) {
      console.warn("[NEMusic] MPRIS bridge", error);
      this.status = "MPRIS 连接失败；请检查 Steam 控制台和辅助进程日志或去Github反馈";
      this.commandRequest?.abort();
      await this.detach();
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
      if (this.pendingCommands.length && this.timer && this.endpoint) void this.tick();
    }
  }
}
