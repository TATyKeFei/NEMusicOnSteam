import type { TrackState } from "../mpris/mpris.ts";
import type { Command } from "../mpris/mpris-player.ts";
import type { SongLyrics } from "./lyrics.ts";

export type NowPlayingSource = {
  readPlaybackState(): Promise<TrackState | null>;
  controlPlayback(command: Command, trackId?: string): Promise<boolean>;
  readSongLyrics(trackId: string): Promise<SongLyrics | null>;
  open(): string;
};

export type NowPlayingState = {
  track: TrackState | null;
  lyrics: SongLyrics | null;
  lyricsLoading: boolean;
  error: string;
  lyricsError: string;
  pending: boolean;
};

/** 面板关闭即停止轮询；歌词单独加载，不阻塞播放进度和操作。 */
export class NowPlayingSession {
  private generation = 0;
  private active = false;
  private busy = false;
  private lyricsTrack = "";
  private state: NowPlayingState = { track: null, lyrics: null, lyricsLoading: false, error: "", lyricsError: "", pending: false };
  private readonly source: NowPlayingSource;
  private readonly changed: (state: NowPlayingState) => void;

  constructor(source: NowPlayingSource, changed: (state: NowPlayingState) => void) {
    this.source = source;
    this.changed = changed;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.lyricsTrack = "";
    this.state = { ...this.state, pending: false };
    void this.refresh();
  }
  stop(): void { this.active = false; this.generation++; }

  async refresh(): Promise<void> {
    if (!this.active || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    try {
      const track = await this.source.readPlaybackState();
      if (!this.active || generation !== this.generation) return;
      const nextId = track?.trackId || "";
      const changed = nextId !== this.state.track?.trackId;
      this.state = { ...this.state, track, error: this.state.error === "暂时无法读取播放状态" ? "" : this.state.error,
        ...(changed ? { lyrics: null, lyricsError: "", lyricsLoading: false } : {}) };
      if (!nextId) this.lyricsTrack = "";
      else if (this.lyricsTrack !== nextId) {
        this.lyricsTrack = nextId;
        this.state.lyricsLoading = true;
        void this.loadLyrics(nextId, generation);
      }
      this.publish();
    } catch {
      if (this.active && generation === this.generation) {
        this.state = { ...this.state, error: "暂时无法读取播放状态" };
        this.publish();
      }
    } finally {
      this.busy = false;
      if (this.active && generation !== this.generation) void this.refresh();
    }
  }

  async command(command: Command, trackId?: string): Promise<void> {
    if (!this.active || this.state.pending || !this.state.track?.active) return;
    if (trackId && trackId !== this.state.track.trackId) return;
    const generation = this.generation;
    this.state = { ...this.state, pending: true, error: "" };
    this.publish();
    try {
      if (!await this.source.controlPlayback(command, trackId)) throw new Error("播放器尚未响应，请稍后重试");
    } catch (error) {
      if (this.active && generation === this.generation) this.state = { ...this.state,
        error: error instanceof Error ? error.message : "播放操作失败，请稍后重试" };
    } finally {
      if (this.active && generation === this.generation) {
        this.state = { ...this.state, pending: false };
        this.publish();
        void this.refresh();
      }
    }
  }

  private async loadLyrics(trackId: string, generation: number): Promise<void> {
    try {
      const lyrics = await this.source.readSongLyrics(trackId);
      if (!this.active || generation !== this.generation || trackId !== this.state.track?.trackId) return;
      this.state = { ...this.state, lyrics, lyricsLoading: false };
    } catch {
      if (!this.active || generation !== this.generation || trackId !== this.state.track?.trackId) return;
      this.state = { ...this.state, lyricsLoading: false, lyricsError: "歌词暂时无法加载" };
    }
    this.publish();
  }

  private publish(): void { this.changed({ ...this.state }); }
}
