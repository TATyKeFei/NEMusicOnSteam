import { ChromeDevToolsProtocol } from "millennium";
import { isPlayerDocument } from "./constants.ts";
import { QUALITY_OPTIONS, QUALITY_SNAPSHOT_SCRIPT, qualityCommandScript, type QualityState } from "./quality-player.ts";

export type QualitySnapshot = QualityState & { updating: boolean; status: string };

const EMPTY_QUALITY: QualityState = { available: false, preferred: null, current: null, playing: false };

export class QualityBridge {
  private timer = 0;
  private generation = 0;
  private busy = false;
  private pending: number | null = null;
  private state: QualityState = EMPTY_QUALITY;
  private status = "打开播放器后可以设置音质";
  private updating = false;

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
    this.generation++;
    this.state = EMPTY_QUALITY;
    this.pending = null;
    this.updating = false;
    if (enabled) {
      this.status = "正在读取网易云音质设置";
      this.timer = window.setInterval(() => void this.tick(), 1500);
      void this.tick();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.status = "打开播放器后可以设置音质";
    }
  }

  snapshot(): QualitySnapshot {
    return { ...this.state, updating: this.updating, status: this.status };
  }

  setQuality(value: number): void {
    if (!this.timer || !this.state.available || this.updating || !QUALITY_OPTIONS.some(option => option.data === value)) return;
    this.pending = value;
    this.updating = true;
    this.status = "正在设置音质";
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    let sessionId: string | null = null;
    let value: number | null = null;
    try {
      const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
      if (generation !== this.generation) return;
      const target = targets.targetInfos.find((item: { url: string; targetId: string }) => isPlayerDocument(item.url));
      if (!target) throw new Error("等待网易云播放器加载");
      const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      sessionId = attached.sessionId;
      if (generation !== this.generation) return;
      value = this.pending;
      this.pending = null;
      const result = await ChromeDevToolsProtocol.send("Runtime.evaluate", {
        expression: value == null ? QUALITY_SNAPSHOT_SCRIPT : qualityCommandScript(value),
        returnByValue: true,
        awaitPromise: true,
        userGesture: value != null,
      }, attached.sessionId);
      if (generation !== this.generation) return;
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      if (value == null) {
        this.state = result.result.value as QualityState;
        if (!this.state?.available) {
          this.state = EMPTY_QUALITY;
          this.status = "网易云音质设置尚未就绪";
        } else if (this.status.startsWith("正在读取") || this.status.startsWith("等待") || this.status === "网易云音质设置尚未就绪") {
          this.status = "音质设置保存在网易云播放器中";
        }
      } else {
        const response = result.result.value as { state: QualityState; message: string };
        this.state = response.state;
        this.status = response.message;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.status = error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
        if (value == null) this.state = EMPTY_QUALITY;
        this.pending = null;
        this.updating = false;
      }
    } finally {
      if (sessionId) {
        try {
          await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId });
        } catch {}
      }
      if (generation === this.generation && value != null) this.updating = false;
      this.busy = false;
    }
  }
}
