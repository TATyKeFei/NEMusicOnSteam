import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";
import { commandScript, SNAPSHOT_SCRIPT, type Command } from "./mpris-player.ts";

type TrackState = {
  active: boolean;
  playbackStatus: "Playing" | "Paused" | "Stopped";
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  trackId: string;
  duration: number;
  position: number;
  canSeek: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  volume: number | null;
};

const getEndpoint = ffi<[], string>("mpris_endpoint");
const EMPTY_STATE: TrackState = {
  active: false,
  playbackStatus: "Stopped",
  title: "",
  artist: "",
  album: "",
  artUrl: "",
  trackId: "",
  duration: 0,
  position: 0,
  canSeek: false,
  canGoNext: false,
  canGoPrevious: false,
  volume: 1,
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
  private status = "尚未连接";
  private commandError = "";

  constructor(private readonly open: () => void, private readonly close: () => void) {}

  start(): void {
    if (this.timer) return;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 MPRIS";
      return;
    }
    this.timer = window.setInterval(() => void this.tick(), 1200);
    void this.tick();
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    this.timer = 0;
    const endpoint = this.endpoint;
    const token = this.token;
    this.endpoint = null;
    this.token = null;
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
    const separator = result.lastIndexOf("|");
    if (separator < 0) {
      this.status = "MPRIS 不可用；请检查 Python 3、PyGObject 和用户会话 D-Bus";
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    return true;
  }

  private async request(path: string, body?: TrackState): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "X-NEMusic-Token": this.token!, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
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

  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      if (!(await this.connect())) return;
      await this.attach();
      const commands = await this.request("/commands");
      if (!commands.ok) throw new Error(`MPRIS command poll failed: ${commands.status}`);
      for (const command of (await commands.json()) as Command[]) {
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
      this.state = this.sessionId ? (await this.evaluate(SNAPSHOT_SCRIPT)) as TrackState : EMPTY_STATE;
      const update = await this.request("/state", this.state);
      if (!update.ok) throw new Error(`MPRIS state update failed: ${update.status}`);
      this.status = this.commandError || "MPRIS 已连接";
    } catch (error) {
      console.warn("[NEMusic] MPRIS bridge", error);
      this.status = "MPRIS 连接失败；请检查 Steam 控制台和辅助进程日志";
      await this.detach();
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
    }
  }
}
