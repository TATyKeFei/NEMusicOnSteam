import { ffi } from "millennium";
import { evaluateInPlayer, PLAYER_TARGET_MISSING } from "../player/player-target.ts";
import { recognitionScript, recognitionUpdateScript } from "./recognition-player.ts";

const getEndpoint = ffi<[], string>("mpris_endpoint");

export class RecognitionBridge {
  private timer = 0;
  private busy = false;
  private pendingOpen = false;
  private generation = 0;
  private endpoint = "";
  private token = "";
  private installed = false;
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
      this.installed = false;
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
    this.timer = window.setInterval((): void => void this.install(), 2000);
    void this.install();
  }

  open(): void {
    this.pendingOpen = true;
    void this.install();
  }

  private async install(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      if (!this.endpoint) {
        const result = await getEndpoint();
        const separator = result.lastIndexOf("|");
        if (separator < 0) throw new Error("听歌识曲需要 Python 3 和 PyGObject 辅助进程");
        this.endpoint = result.slice(0, separator);
        this.token = result.slice(separator + 1);
      }
      const open = this.pendingOpen;
      let ready = false;
      if (this.installed) {
        try {
          ready = (await evaluateInPlayer(recognitionUpdateScript(this.endpoint, this.token, open))) === true;
        } catch (error) {
          // No player page yet is the normal state before the user opens one: stay quiet
          // and keep the pending request queued for a later tick.
          if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
          ready = false;
        }
        this.installed = ready;
      }
      if (!ready) {
        await evaluateInPlayer(recognitionScript(this.endpoint, this.token, open));
        this.installed = true;
      }
      if (!this.timer) return;
      this.pendingOpen = false;
      this.status = "可以识别系统声音或麦克风；首次使用需联网加载识曲引擎";
    } catch (error) {
      if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
      this.installed = false;
      this.status = error instanceof Error ? error.message : String(error);
      console.warn("[NEMusic] recognition", error);
    } finally {
      this.busy = false;
    }
  }
}
