import { ffi } from "millennium";
import { evaluateInPlayer, PLAYER_TARGET_MISSING } from "../player/player-target.ts";
import { recognitionScript, recognitionUpdateScript } from "./recognition-player.ts";

const getEndpoint = ffi<[], string>("mpris_endpoint");

/** 两个注入脚本的返回值：note 是人话版的失败原因，装不上时直接显示到设置页。 */
type InstallReport = { ok: boolean; note: string };

function report(value: unknown): InstallReport {
  if (value && typeof value === "object" && "ok" in value) {
    const parsed = value as Partial<InstallReport>;
    return { ok: parsed.ok === true, note: typeof parsed.note === "string" ? parsed.note : "" };
  }
  // 旧版脚本只会返回 true/false。
  return { ok: value === true, note: "" };
}

/**
 * 按钮装不上时不要把状态覆盖成「一切正常」：可能是辅助进程没起来（真错误），也可能
 * 只是页面顶栏还没渲染出来（下一轮就好了）。分开说清楚，免得把暂时性问题报成永久故障。
 */
const READY = "可以识别系统声音或麦克风；顶栏按钮已就位，首次使用需联网加载识曲引擎";

function statusFor(note: string): string {
  return note ? `${note}；识曲面板仍可从设置页打开` : READY;
}

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
      let note = "";
      if (this.installed) {
        try {
          const update = report(await evaluateInPlayer(recognitionUpdateScript(this.endpoint, this.token, open)));
          ready = update.ok;
          note = update.note;
        } catch (error) {
          // 用户还没打开播放器时没有页面是正常状态：这里保持安静，
          // 并把这个待处理请求留到后面的 tick 再试。
          if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) return;
          ready = false;
        }
        this.installed = ready;
      }
      if (!ready) {
        note = report(await evaluateInPlayer(recognitionScript(this.endpoint, this.token, open))).note;
        this.installed = true;
      }
      if (!this.timer) return;
      this.pendingOpen = false;
      this.status = statusFor(note);
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
