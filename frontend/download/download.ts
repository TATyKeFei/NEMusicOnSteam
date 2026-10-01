import { ffi } from "millennium";
import { evaluateInPlayer } from "../player/player-target.ts";
import type { NotificationMode } from "../settings.ts";
import { steamToast } from "../widget/toast.ts";
import {
  downloadScript,
  PLAYING_LIST_SCRIPT,
  songFileName,
  type DownloadSong,
  type DownloadTrack,
} from "./download-player.ts";
import { MENU_POLL_SCRIPT, MENU_TICK_SCRIPT, menuToastScript } from "./menu-player.ts";

type DownloadJob = {
  active: boolean;
  received: number;
  total: number;
  filename: string;
  path: string;
  error: string;
};

type MenuTick = {
  installed: boolean;
  menus: number;
  songs: number;
  pending: DownloadSong[];
  error?: string;
};

export type DownloadProgress = { received: number; total: number; filename: string };

export type DownloadSnapshot = {
  available: boolean;
  busy: boolean;
  status: string;
  menu: string;
  progress: DownloadProgress | null;
};

export type DownloadOptions = {
  quality: number;
  directory: string;
  nameTemplate: string;
  notificationMode: NotificationMode;
  downloadNotificationMode: NotificationMode;
};

const POLL_MS = 800;
const MENU_TICK_MS = 1000;
const DISABLED_STATUS = "打开播放器后可以下载当前歌曲";
const MENU_WAITING = "歌曲列表里每行的「···」菜单也能下载";
const MENU_LOST = "找到歌曲菜单但没认出这首歌，可能是网易云改版了";
const MENU_BROKEN = "菜单下载装不上，可能是网易云改版了";
const getEndpoint = ffi<[], string>("mpris_endpoint");

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/** 辅助进程会用 {"error": "..."} 回应被拒绝的请求；优先用它，而不是笼统的提示。 */
async function failureText(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload?.error) return payload.error;
  } catch {}
  return fallback;
}

export class DownloadBridge {
  private readonly options: () => DownloadOptions;
  private enabled = false;
  private busy = false;
  private generation = 0;
  private queue: DownloadSong[] = [];
  private status = DISABLED_STATUS;
  private progress: DownloadProgress | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private timer = 0;
  private menus = 0;
  private songs = 0;
  private menuBroken = false;
  private menuInstalled = false;

  constructor(options: () => DownloadOptions) {
    this.options = options;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.generation++;
    this.busy = false;
    this.progress = null;
    this.queue = [];
    this.status = enabled ? "可以下载当前正在播放的歌曲" : DISABLED_STATUS;
    if (enabled) {
      this.timer = window.setInterval((): void => void this.tickMenu(), MENU_TICK_MS);
      void this.tickMenu();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.endpoint = null;
      this.token = null;
      this.menus = 0;
      this.songs = 0;
      this.menuBroken = false;
      this.menuInstalled = false;
    }
  }

  snapshot(): DownloadSnapshot {
    return {
      available: this.enabled,
      busy: this.busy,
      status: this.status,
      menu: this.menuText(),
      progress: this.progress ? { ...this.progress } : null,
    };
  }

  /** 下载当前正在播放的歌曲，或用户在列表菜单里选中的那一首。 */
  async download(song?: DownloadSong): Promise<void> {
    if (!this.enabled) {
      this.status = "先打开播放器再下载";
      return;
    }
    if (this.busy) {
      // 辅助进程一次只跑一个任务；这一侧维护队列，把用户的重复点击变成依次下载，
      // 而不是撞上一堵 409 的墙。
      if (song != null) {
        this.queue.push(song);
        this.report(this.queue.length === 1 ? "已加入下载队列" : `已加入下载队列，前面还有 ${this.queue.length - 1} 首`);
      } else {
        this.report("正在下载，请稍候");
      }
      return;
    }
    const { quality, directory, nameTemplate, downloadNotificationMode } = this.options();
    const generation = ++this.generation;
    this.busy = true;
    this.progress = null;
    try {
      this.status = "正在解析音频地址";
      const track = await this.resolve(quality, song);
      if (generation !== this.generation) return;
      if (track.source === "player") this.status = "网易云没有返回所选音质，改用当前播放的音频流";
      else this.status = `正在下载 ${track.artist ? `${track.artist} - ` : ""}${track.name}${this.queue.length > 0 ? `（队列还有 ${this.queue.length} 首）` : ""}`;
      this.toast(this.status);
      const started = await this.request("/download", {
        method: "POST",
        body: {
          url: track.url,
          filename: songFileName(nameTemplate, { title: track.name, artist: track.artist, album: track.album }),
          directory,
          type: track.type,
          title: track.name,
          artist: track.artist,
          album: track.album,
          cover: track.cover,
          notify: downloadNotificationMode,
        },
      });
      if (generation !== this.generation) return;
      if (started.status === 409) {
        this.status = await failureText(started, "已有下载任务在进行");
        this.toast(this.status);
        return;
      }
      if (!started.ok) throw new Error(await failureText(started, "下载请求被拒绝"));
      this.status = "正在下载";
      while (generation === this.generation) {
        await delay(POLL_MS);
        if (generation !== this.generation) return;
        const response = await this.request("/download");
        if (!response.ok) throw new Error("读取下载进度失败");
        const job = (await response.json()) as DownloadJob;
        if (job.error) throw new Error(job.error);
        if (job.active) {
          this.progress = { received: job.received, total: job.total, filename: job.filename };
          continue;
        }
        this.progress = null;
        this.status = job.path ? `已保存到 ${job.path}` : "下载已结束但没有生成文件";
        if (downloadNotificationMode === "steam") {
          steamToast("下载完成", job.path || this.status);
        }
        return;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.status = message(error);
        this.toast(this.status);
        if (downloadNotificationMode === "steam") {
          steamToast("下载失败", this.status);
        }
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.pump();
      }
    }
  }

  /** 读取播放器的播放列表，把里面每首歌都排进队列依次下载。 */
  async downloadPlayingList(): Promise<void> {
    if (!this.enabled) {
      this.status = "先打开播放器再下载";
      return;
    }
    if (this.busy) {
      this.report("正在下载，请稍候");
      return;
    }
    try {
      const songs = (await this.evaluate(PLAYING_LIST_SCRIPT)) as DownloadSong[] | null;
      if (!Array.isArray(songs) || songs.length === 0) {
        this.status = "没有读到播放列表，可能网易云改版了";
        this.toast(this.status);
        return;
      }
      this.queue.push(...songs);
      this.status = `播放列表共 ${songs.length} 首，开始依次下载`;
      this.toast(this.status);
      this.pump();
    } catch {
      /* the player page is not there yet, or is mid-navigation */
    }
  }

  private pump(): void {
    if (this.busy || !this.enabled || this.queue.length === 0) return;
    void this.download(this.queue.shift());
  }

  private menuText(): string {
    if (!this.enabled) return "";
    if (this.menuBroken) return MENU_BROKEN;
    if (this.menus > 0 && this.songs === 0) return MENU_LOST;
    return MENU_WAITING;
  }

  private report(text: string): void {
    this.status = text;
    this.toast(text);
  }

  /** 把信息报到用户真正会看到的地方；设置页通常不在当前屏幕上。 */
  private toast(text: string): void {
    void this.evaluate(menuToastScript(text)).catch(() => {});
  }

  /**
   * 扫描器会汇报自己是否还在页面上，而页面刷新会把它一起带走：所以只有发现它不见的那次
   * tick 才需要付出安装代码的代价，其余每次 tick 都只发那个小轮询。
   */
  private async tickMenu(): Promise<void> {
    if (!this.enabled) return;
    const generation = this.generation;
    try {
      const result = (await this.evaluate(this.menuInstalled ? MENU_POLL_SCRIPT : MENU_TICK_SCRIPT)) as MenuTick | null;
      if (generation !== this.generation || result == null) return;
      if (result.error) this.menuBroken = true;
      this.menuInstalled = result.installed === true;
      this.menus = Math.max(this.menus, Number(result.menus) || 0);
      this.songs = Math.max(this.songs, Number(result.songs) || 0);
      const pending = Array.isArray(result.pending) ? result.pending : [];
      if (pending.length === 0) return;
      await this.download(pending[0]);
    } catch {
      /* the player page is not there yet, or is mid-navigation */
    }
  }

  private async resolve(quality: number, song?: DownloadSong): Promise<DownloadTrack> {
    const result = await this.evaluate(downloadScript(quality, song));
    const track = result as DownloadTrack | null;
    if (!track?.url) throw new Error("没有解析到可下载的音频地址");
    return track;
  }

  /** 在共享的播放器会话上求值，该会话只 attach 一次然后反复复用。 */
  private async evaluate(expression: string): Promise<unknown> {
    return evaluateInPlayer(expression, { awaitPromise: true });
  }

  private async connect(): Promise<boolean> {
    if (this.endpoint && this.token) return true;
    const result = await getEndpoint();
    const separator = result.lastIndexOf("|");
    if (separator < 0) return false;
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    return true;
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
    if (!(await this.connect())) throw new Error("下载需要 Python 3 和 MPRIS 辅助进程，目前仅 Linux 支持");
    return fetch(`${this.endpoint}${path}`, {
      method: options.method ?? "GET",
      headers: { "X-NEMusic-Token": this.token!, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }
}
