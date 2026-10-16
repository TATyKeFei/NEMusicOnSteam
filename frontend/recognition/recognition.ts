import { HelperConnectionError, type HelperClient, type HelperConnection } from "../runtime/helper-client.ts";
import { recognitionScript, recognitionUpdateScript } from "./recognition-player.ts";

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

export type RecognitionDependencies = {
  helper: Pick<HelperClient, "connect" | "request">;
  evaluate: (expression: string) => Promise<unknown>;
  supported: () => boolean;
  targetMissing: (error: unknown) => boolean;
  timers?: Pick<Window, "setInterval" | "clearInterval">;
};

export class RecognitionBridge {
  private timer = 0;
  private busy = false;
  private pendingOpen = false;
  private generation = 0;
  private installed = false;
  private status = "支持识别系统声音和麦克风，仅 Linux 可用";
  private connection: HelperConnection | null = null;
  private readonly dependencies: RecognitionDependencies;
  private readonly timers: NonNullable<RecognitionDependencies["timers"]>;

  constructor(dependencies: RecognitionDependencies) {
    this.dependencies = dependencies;
    this.timers = dependencies.timers ?? window;
  }

  getStatus(): string {
    return this.status;
  }

  setEnabled(enabled: boolean): void {
    const generation = ++this.generation;
    if (!enabled) {
      this.timers.clearInterval(this.timer);
      this.timer = 0;
      this.pendingOpen = false;
      this.installed = false;
      const connection = this.connection;
      this.connection = null;
      if (connection) {
        void this.dependencies.helper.request("/recognition", {}, connection)
          .then(response => response.json())
          .then(job => generation === this.generation && job.id && this.dependencies.helper.request("/recognition/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: job.id }),
          }, connection)).catch(() => {});
      }
      return;
    }
    if (this.timer || !this.dependencies.supported()) return;
    this.timer = this.timers.setInterval((): void => void this.install(), 2000);
    void this.install();
  }

  open(): void {
    this.pendingOpen = true;
    void this.install();
  }

  private async install(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const connection = await this.dependencies.helper.connect();
      if (generation !== this.generation || !this.timer) return;
      this.connection = connection;
      const { endpoint, token } = connection;
      const open = this.pendingOpen;
      let ready = false;
      let note = "";
      if (this.installed) {
        try {
          const update = report(await this.dependencies.evaluate(recognitionUpdateScript(endpoint, token, open)));
          if (generation !== this.generation || !this.timer) return;
          ready = update.ok;
          note = update.note;
        } catch (error) {
          // 用户还没打开播放器时没有页面是正常状态：这里保持安静，
          // 并把这个待处理请求留到后面的 tick 再试。
          if (this.dependencies.targetMissing(error)) return;
          ready = false;
        }
        this.installed = ready;
      }
      if (!ready) {
        const installed = report(await this.dependencies.evaluate(recognitionScript(endpoint, token, open)));
        if (generation !== this.generation || !this.timer) return;
        note = installed.note;
        this.installed = installed.ok;
      }
      if (generation !== this.generation || !this.timer) return;
      this.pendingOpen = false;
      this.status = statusFor(note);
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.dependencies.targetMissing(error)) return;
      this.installed = false;
      this.status = error instanceof HelperConnectionError
        ? "听歌识曲需要 Python 3 和 PyGObject 辅助进程"
        : error instanceof Error ? error.message : String(error);
      console.warn("[NEMusic] recognition", error);
    } finally {
      this.busy = false;
    }
  }
}
