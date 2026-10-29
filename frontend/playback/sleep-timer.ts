import type { TrackState } from "../mpris/mpris.ts";

export type SleepSnapshot = { mode: "off" | "countdown" | "track"; remaining: number; status: string };
type Dependencies = {
  state(): Promise<TrackState | null>;
  pause(): Promise<void>;
  volume(value: number): Promise<void>;
  guard(trackId: string | null): Promise<void>;
  prepareEnd(): void;
  restoreEnd?(): void;
  fadeSeconds(): number;
};

/** 串行执行音量与停止操作，避免取消或重新计时被旧请求覆盖。 */
export class SleepTimer {
  private timer = 0;
  private mode: SleepSnapshot["mode"] = "off";
  private deadline = 0;
  private trackId = "";
  private originalVolume: number | null = null;
  private fadedVolume = -1;
  private prepared = false;
  private busy = false;
  private generation = 0;
  private operations: Promise<void> = Promise.resolve();
  private status = "未启用";
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) { this.dependencies = dependencies; }

  snapshot(): SleepSnapshot {
    return { mode: this.mode, remaining: this.mode === "countdown" ? Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)) : 0, status: this.status };
  }

  recoveryVolume(current: number): number { return this.originalVolume ?? current; }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => {});
    return pending;
  }

  private invalidate(): number {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.mode = "off";
    return ++this.generation;
  }

  private async cleanup(): Promise<void> {
    const volume = this.originalVolume;
    const prepared = this.prepared;
    this.originalVolume = null;
    this.fadedVolume = -1;
    this.prepared = false;
    try { await this.dependencies.guard(null); }
    finally {
      try { if (volume !== null) await this.dependencies.volume(volume); }
      finally { if (prepared) this.dependencies.restoreEnd?.(); }
    }
  }

  start(value: number | "track"): Promise<void> {
    const generation = this.invalidate();
    return this.serialize(async () => {
      await this.cleanup();
      if (generation !== this.generation) return;
      try {
        const state = await this.dependencies.state();
        if (generation !== this.generation) return;
        if (!state?.trackId || !state.active) { this.status = "请先播放一首歌曲"; return; }
        if (value !== "track" && (!Number.isFinite(value) || value < 1 || value > 240)) { this.status = "请选择 1–240 分钟"; return; }
        this.trackId = state.trackId;
        this.mode = value === "track" ? "track" : "countdown";
        this.deadline = value === "track" ? 0 : Date.now() + value * 60000;
        if (value === "track") {
          await this.dependencies.guard(this.trackId);
          if (generation !== this.generation) return;
          this.prepared = true;
          this.dependencies.prepareEnd();
        }
        this.status = value === "track" ? "播完当前歌曲后停止" : "倒计时停止播放";
        this.timer = window.setInterval(() => { void this.tick(); }, 250);
      } catch (error) {
        if (generation !== this.generation) return;
        this.invalidate();
        await this.cleanup().catch(() => {});
        this.status = `定时设置失败：${error instanceof Error ? error.message : String(error)}`;
      }
    });
  }

  cancel(): Promise<void> {
    this.invalidate();
    this.status = "未启用";
    return this.serialize(() => this.cleanup());
  }

  private async tick(): Promise<void> {
    if (this.busy || this.mode === "off") return;
    this.busy = true;
    const generation = this.generation;
    try {
      await this.serialize(async () => {
        if (generation !== this.generation || this.mode === "off") return;
        const state = await this.dependencies.state();
        if (generation !== this.generation || !state) return;
        const remaining = this.mode === "countdown" ? (this.deadline - Date.now()) / 1000
          : state.trackId !== this.trackId || state.playbackStatus === "Stopped" ? 0 : state.duration > 0 ? state.duration - state.position : Infinity;
        const fade = this.dependencies.fadeSeconds();
        if (remaining > fade && this.originalVolume !== null) {
          await this.dependencies.volume(this.originalVolume);
          this.originalVolume = null;
          this.fadedVolume = -1;
        }
        if (remaining > 0 && remaining <= fade && state.playbackStatus === "Playing" && state.volume !== null) {
          if (this.originalVolume === null) this.originalVolume = state.volume;
          const target = this.originalVolume * Math.max(0, remaining / fade);
          if (this.fadedVolume < 0 || Math.abs(this.fadedVolume - target) >= 0.02) {
            this.fadedVolume = target;
            await this.dependencies.volume(target);
          }
        }
        if (generation !== this.generation) return;
        if (remaining <= 0.15) {
          await this.dependencies.pause();
          if (generation !== this.generation) return;
          this.invalidate();
          await this.cleanup();
          this.status = "已按定时设置停止播放";
        }
      });
    } catch (error) {
      if (generation === this.generation) {
        this.invalidate();
        await this.serialize(() => this.cleanup()).catch(() => {});
        this.status = `定时停止失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } finally { this.busy = false; }
  }
}
