import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { WEB_PRELOAD_CLEAR_SCRIPT, webPreloadScript } from "./web-preload-player.ts";

export class WebPreloadBridge {
  private timer = 0;
  private busy = false;
  private generation = 0;
  private readonly enabled: () => boolean;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
    this.generation++;
    if (enabled) {
      this.timer = window.setInterval(() => { void this.tick(); }, 1500);
      void this.tick();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
      void tryEvaluateInPlayer(WEB_PRELOAD_CLEAR_SCRIPT).catch(() => {});
    }
  }

  refresh(): void {
    this.generation++;
    void tryEvaluateInPlayer(WEB_PRELOAD_CLEAR_SCRIPT).catch(() => {}).then(() => this.tick());
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    try {
      await tryEvaluateInPlayer(webPreloadScript(this.enabled()));
    } catch (error) {
      if (generation === this.generation) console.warn("[NEMusic] web preload", error);
    } finally {
      this.busy = false;
      if (generation !== this.generation && this.timer) void this.tick();
    }
  }
}
