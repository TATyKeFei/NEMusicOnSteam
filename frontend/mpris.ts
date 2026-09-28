import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";
import { commandScript, LYRICS_SCRIPT, SNAPSHOT_SCRIPT, type Command } from "./mpris-player.ts";

type LyricLine = { time: number; text: string };

type TimedLyrics = { trackId: string; lines: LyricLine[] };

const LYRIC_LINE_LIMIT = 1000;

/**
 * Pick the lyric line that should be highlighted at `position`, preferring the
 * most recent line whose timestamp has already passed. Lines without usable
 * timestamps are ignored so a malformed page never makes the selection jitter.
 */
export function currentLyricLine(lines: LyricLine[], position: number): string {
  let best: LyricLine | null = null;
  for (const line of lines) {
    if (!Number.isFinite(line.time) || line.time < 0) continue;
    if (line.time > position + 0.25) continue;
    if (!best || line.time >= best.time) best = line;
  }
  return best?.text ?? "";
}

function parseTimedLyrics(raw: unknown): TimedLyrics | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { trackId?: unknown; lines?: unknown };
  if (typeof value.trackId !== "string" || !Array.isArray(value.lines)) return null;
  const lines: LyricLine[] = [];
  for (const entry of value.lines.slice(0, LYRIC_LINE_LIMIT)) {
    if (!entry || typeof entry !== "object") continue;
    const line = entry as { time?: unknown; text?: unknown };
    const time = Number(line.time);
    const text = typeof line.text === "string" ? line.text.replace(/\s+/g, " ").trim() : "";
    if (!Number.isFinite(time) || time < 0 || !text) continue;
    lines.push({ time, text });
  }
  return { trackId: value.trackId, lines };
}

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
  private lastTrackId = "";
  private lastPosition = 0;
  private lastLyricsTrackId = "";
  private lastLyricsAttemptAt = 0;
  private lastSentLyrics: string | null = null;
  private timedLyrics: TimedLyrics | null = null;
  private readonly lyricListeners = new Set<(line: string) => void>();
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
    this.timedLyrics = null;
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

  /**
   * Subscribe to the lyric line that is active right now. The bridge keeps a
   * timestamped copy of the lyrics and re-selects the current line on every
   * poll, so listeners only get called when the song actually moves to the
   * next (or previous) line instead of on every sync tick.
   */
  onLyricLineChange(listener: (line: string) => void): () => void {
    this.lyricListeners.add(listener);
    return () => this.lyricListeners.delete(listener);
  }

  private publishLyricLine(line: string): void {
    if (line === this.state.lyrics) return;
    for (const listener of this.lyricListeners) {
      try {
        listener(line);
      } catch {}
    }
  }

  private async updateLyrics(snapshot: TrackState): Promise<void> {
    const trackId = snapshot.trackId;
    if (!trackId) {
      this.lastLyricsTrackId = "";
      this.timedLyrics = null;
      snapshot.lyrics = "";
      return;
    }
    const now = Date.now();
    const trackChanged = trackId !== this.lastLyricsTrackId;
    const retry = !this.timedLyrics && now - this.lastLyricsAttemptAt >= 1500;
    if (trackChanged || retry) {
      this.lastLyricsTrackId = trackId;
      this.lastLyricsAttemptAt = now;
      let result: unknown = "";
      try {
        result = await this.evaluate(LYRICS_SCRIPT);
      } catch {
        result = "";
      }
      if (trackChanged || this.timedLyrics?.trackId !== trackId) this.timedLyrics = parseTimedLyrics(result);
    }
    // Re-pick the active line from the cached timestamps on every poll so the
    // published text only changes when the song really moves to another line.
    const timed = this.timedLyrics;
    if (timed && timed.trackId === trackId && timed.lines.length) {
      snapshot.lyrics = currentLyricLine(timed.lines, snapshot.position);
      return;
    }
    snapshot.lyrics = this.state.trackId === trackId ? this.state.lyrics : "";
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
      if (
        snapshot.playbackStatus === "Playing" &&
        this.state.playbackStatus === "Playing" &&
        snapshot.trackId === this.lastTrackId &&
        snapshot.position < this.lastPosition &&
        this.lastPosition - snapshot.position < 1.5
      ) {
        snapshot.position = this.lastPosition;
      }
      await this.updateLyrics(snapshot);
      this.publishLyricLine(snapshot.lyrics);
      this.state = snapshot;
      this.lastTrackId = snapshot.trackId;
      this.lastPosition = snapshot.position;
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
