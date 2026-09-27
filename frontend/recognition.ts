import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";
import { recognitionScript } from "./recognition-player.ts";

const getEndpoint = ffi<[], string>("mpris_endpoint");

export class RecognitionBridge {
  private timer = 0;
  private busy = false;
  private pendingOpen = false;
  private generation = 0;
  private endpoint = "";
  private token = "";
  private status = "支持识别系统声音和麦克风，仅 Linux 可用";

  getStatus(): string {
    return this.status;
  }

  setEnabled(enabled: boolean): void {
    const generation = ++this.generation;
    if (!enabled) {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.pendingOpen = false;
      if (this.endpoint) {
        void fetch(`${this.endpoint}/recognition`, { headers: { "X-NEMusic-Token": this.token } })
          .then(response => response.json())
          .then(job => generation === this.generation && job.id && fetch(`${this.endpoint}/recognition/cancel`, {
            method: "POST",
            headers: { "X-NEMusic-Token": this.token, "Content-Type": "application/json" },
            body: JSON.stringify({ id: job.id }),
          })).catch(() => {});
      }
      return;
    }
    if (this.timer || !/Linux/i.test(navigator.platform)) return;
    this.timer = window.setInterval(() => void this.install(), 2000);
    void this.install();
  }

  open(): void {
    this.pendingOpen = true;
    void this.install();
  }

  private async install(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    let sessionId: string | null = null;
    try {
      if (!this.endpoint) {
        const result = await getEndpoint();
        const separator = result.lastIndexOf("|");
        if (separator < 0) throw new Error("听歌识曲需要 Python 3 和 PyGObject 辅助进程");
        this.endpoint = result.slice(0, separator);
        this.token = result.slice(separator + 1);
      }
      const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
      const target = targets.targetInfos.find(item => isPlayerDocument(item.url));
      if (!target || !this.timer) return;
      const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      sessionId = attached.sessionId;
      if (!this.timer) return;
      const open = this.pendingOpen;
      this.pendingOpen = false;
      const result = await ChromeDevToolsProtocol.send("Runtime.evaluate", {
        expression: recognitionScript(this.endpoint, this.token, open), returnByValue: true,
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      this.status = "可以识别系统声音或麦克风；首次使用需联网加载识曲引擎";
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      console.warn("[NEMusic] recognition", error);
    } finally {
      if (sessionId) {
        try { await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId }); } catch {}
      }
      this.busy = false;
    }
  }
}
