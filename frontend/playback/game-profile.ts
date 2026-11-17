import type { TrackState } from "../mpris/mpris.ts";
import type { Command } from "../mpris/mpris-player.ts";

export type GameProfile = { id: string; name: string; action: "pause" | "lower" | "none"; volumePercent: number; muteNotifications: boolean };
export const DEFAULT_GAME_PROFILES: GameProfile[] = [
  { id: "competitive", name: "竞技游戏", action: "pause", volumePercent: 30, muteNotifications: true },
  { id: "relaxed", name: "休闲游戏", action: "lower", volumePercent: 40, muteNotifications: true },
];
export function sanitizeGameProfiles(value: unknown): GameProfile[] {
  if (!Array.isArray(value)) return DEFAULT_GAME_PROFILES.map(profile => ({ ...profile }));
  const ids = new Set<string>();
  return value.slice(0, 30).flatMap(item => {
    if (!item || typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id) || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim()) return [];
    ids.add(item.id);
    return [{ id: item.id, name: item.name.trim().slice(0, 60),
      action: item.action === "pause" || item.action === "lower" ? item.action : "none",
      volumePercent: Number.isFinite(item.volumePercent) ? Math.max(0, Math.min(100, Math.round(item.volumePercent))) : 40,
      muteNotifications: item.muteNotifications === true } as GameProfile];
  });
}

export class GameProfileSession {
  private active: GameProfile | null = null;
  private previous: { trackId: string; volume: number | null; playing: boolean } | null = null;
  private appliedVolume: number | null = null;
  private pausedByProfile = false;
  private pending = false;
  private note = "未启用游戏配置";
  private revision = 0;
  private readonly state: () => Promise<TrackState | null>;
  private readonly command: (command: Command) => Promise<boolean>;
  constructor(state: () => Promise<TrackState | null>, command: (command: Command) => Promise<boolean>) {
    this.state = state; this.command = command;
  }
  snapshot() { return { activeId: this.active?.id ?? "", busy: this.pending, status: this.note, muteNotifications: this.active?.muteNotifications ?? false }; }
  recoveryVolume(volume: number): number {
    return this.previous?.volume != null && this.appliedVolume != null && Math.abs(volume - this.appliedVolume) < 0.015 ? this.previous.volume : volume;
  }
  async select(profile: GameProfile | null): Promise<void> {
    if (this.pending) return;
    const revision = ++this.revision;
    this.pending = true;
    try {
      await this.restore(revision);
      if (revision !== this.revision) return;
      if (!profile) { this.note = "已退出游戏配置"; return; }
      const state = await this.state();
      if (revision !== this.revision) return;
      if (!state?.active) throw new Error("请先打开播放器并选择歌曲");
      this.previous = { trackId: state.trackId, volume: state.volume, playing: state.playbackStatus === "Playing" };
      this.active = { ...profile };
      if (profile.action === "pause" && this.previous.playing) {
        if (!await this.command({ action: "pause" })) throw new Error("暂停失败，请检查播放连接");
        if (revision !== this.revision) return;
        this.pausedByProfile = true;
      } else if (profile.action === "lower" && state.volume != null) {
        const volume = state.volume * profile.volumePercent / 100;
        if (!await this.command({ action: "volume", value: volume })) throw new Error("调整音量失败，请检查播放连接");
        if (revision !== this.revision) return;
        this.appliedVolume = volume;
      }
      this.note = `当前游戏配置：${profile.name}`;
    } catch (error) {
      if (revision !== this.revision) return;
      this.note = error instanceof Error ? error.message : "切换游戏配置失败";
      if (this.appliedVolume == null && !this.pausedByProfile) { this.active = null; this.previous = null; }
    } finally { if (revision === this.revision) this.pending = false; }
  }
  private async restore(revision: number): Promise<void> {
    if (this.previous) {
      const state = await this.state();
      if (revision !== this.revision) return;
      if (state?.active && this.appliedVolume != null && state.volume != null && Math.abs(state.volume - this.appliedVolume) < 0.015) {
        if (!await this.command({ action: "volume", value: this.previous.volume! })) throw new Error("原音量恢复失败，请重试退出配置");
        if (revision !== this.revision) return;
      }
      if (state?.trackId === this.previous.trackId && state.playbackStatus === "Paused" && this.pausedByProfile && this.previous.playing) {
        if (!await this.command({ action: "play" })) throw new Error("原播放状态恢复失败，请重试退出配置");
        if (revision !== this.revision) return;
      }
    }
    this.active = null; this.previous = null; this.appliedVolume = null; this.pausedByProfile = false;
  }
  reset(): void { this.revision++; this.pending = false; this.active = null; this.previous = null; this.appliedVolume = null; this.pausedByProfile = false; this.note = "未启用游戏配置"; }
}
