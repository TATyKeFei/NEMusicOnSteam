import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { WEB_PRELOAD_CLEAR_SCRIPT, WEB_PRELOAD_UPDATE_SCRIPT, webPreloadScript } from "./web-preload-player.ts";

export class WebPreloadBridge {
  private timer = 0;
  private busy = false;
  private generation = 0;
  private viewEnabled = false;
  private status = "已关闭";
  private installed = false;
  private readonly enabled: () => boolean;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.viewEnabled) return;
    this.viewEnabled = enabled;
    this.refresh();
  }

  getStatus(): string { return this.status; }

  refresh(): void {
    this.generation++;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.installed = false;
    const generation = this.generation;
    this.status = this.enabled() ? "等待播放器" : "已关闭";
    void tryEvaluateInPlayer(WEB_PRELOAD_CLEAR_SCRIPT).catch(() => {}).then(() => {
      if (generation !== this.generation || !this.viewEnabled || !this.enabled()) return;
      this.timer = window.setInterval(() => { void this.tick(); }, 1500);
      void this.tick();
    });
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    try {
      let value = this.installed ? await tryEvaluateInPlayer(WEB_PRELOAD_UPDATE_SCRIPT) : null;
      if (generation !== this.generation) return;
      if (!(value as { installed?: boolean } | null)?.installed) value = await tryEvaluateInPlayer(`(() => { const installed = ${webPreloadScript(true)}; return { installed, status: globalThis.__NEMusicOnSteamWebPreload?.status || '' }; })()`);
      if (generation !== this.generation) return;
      const result = value as { installed?: boolean; status?: string } | null;
      this.installed = result?.installed === true;
      this.status = result?.status || "页面播放模块尚未就绪，正在等待";
    } catch (error) {
      if (generation === this.generation) console.warn("[NEMusic] web preload", error);
    } finally {
      if (generation !== this.generation) {
        await tryEvaluateInPlayer(WEB_PRELOAD_CLEAR_SCRIPT).catch(() => {});
        this.installed = false;
      }
      this.busy = false;
      if (generation !== this.generation && this.timer) void this.tick();
    }
  }
}
