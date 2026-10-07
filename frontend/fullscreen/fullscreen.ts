import { evaluateInPlayer, PLAYER_TARGET_MISSING } from "../player/player-target.ts";
import { fullscreenButtonScript, fullscreenButtonStateScript, fullscreenButtonUpdateScript } from "./fullscreen-player.ts";

/** 在页面与 Steam 主窗口之间传递一次性的桌面全屏请求。 */
export class FullscreenButtonBridge {
  private timer = 0;
  private busy = false;
  private stateBusy = false;
  private installed = false;
  private request = 0;
  private generation = 0;
  private onRequest: ((active: boolean, fillWindow: boolean) => void) | null = null;
  private stateTimer = 0;

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
    this.generation++;
    if (!enabled) {
      window.clearInterval(this.timer);
      window.clearInterval(this.stateTimer);
      this.timer = 0;
      this.stateTimer = 0;
      this.busy = false;
      this.stateBusy = false;
      this.installed = false;
      this.request = 0;
      this.onRequest = null;
      return;
    }
    if (this.timer) return;
    this.timer = window.setInterval((): void => { void this.install(); }, 2000);
    this.stateTimer = window.setInterval((): void => {
      if (this.onRequest) this.refresh(this.onRequest);
    }, 120);
    void this.install();
  }

  refresh(onRequest: (active: boolean, fillWindow: boolean) => void): void {
    if (!this.timer || this.stateBusy) return;
    this.onRequest = onRequest;
    this.stateBusy = true;
    const generation = this.generation;
    void evaluateInPlayer(fullscreenButtonStateScript()).then(value => {
      if (generation !== this.generation || !this.timer) return;
      if (!value || typeof value !== "object") return;
      const state = value as { active?: boolean; fillWindow?: boolean; request?: number };
      if (Number.isFinite(state.request) && state.request !== this.request) {
        this.request = state.request ?? this.request;
        this.onRequest?.(state.active === true, state.fillWindow === true);
      }
    }).catch(error => {
      if (generation !== this.generation) return;
      if (error instanceof Error && error.message === PLAYER_TARGET_MISSING) this.onRequest = null;
    }).finally(() => {
      if (generation === this.generation) this.stateBusy = false;
    });
  }

  private async install(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const updated = this.installed && await evaluateInPlayer(fullscreenButtonUpdateScript());
      if (generation !== this.generation || !this.timer) return;
      if (updated !== true) await evaluateInPlayer(fullscreenButtonScript());
      if (generation !== this.generation || !this.timer) return;
      this.installed = true;
    } catch (error) {
      if (generation !== this.generation) return;
      if (!(error instanceof Error && error.message === PLAYER_TARGET_MISSING)) {
        this.installed = false;
        console.warn("[NEMusic] fullscreen button", error);
      }
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
}
