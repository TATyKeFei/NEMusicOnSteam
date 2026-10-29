import { HelperConnectionError, type HelperClient } from "../runtime/helper-client.ts";
import type { NotificationMode } from "../settings.ts";
import {
  downloadScript,
  PLAYING_LIST_SCRIPT,
  songFileName,
  type DownloadSong,
  type DownloadTrack,
} from "./download-player.ts";
import { MENU_POLL_SCRIPT, MENU_TICK_SCRIPT, menuToastScript } from "./menu-player.ts";

type DownloadJob = {
  id?: string;
  active: boolean;
  received: number;
  total: number;
  filename: string;
  path: string;
  error: string;
  cancelled?: boolean;
  skipped?: boolean;
};

export type DownloadTask = {
  id: string;
  songId: number;
  title: string;
  artist: string;
  state: "queued" | "resolving" | "downloading" | "completed" | "failed" | "cancelled" | "skipped";
  error: string;
  path: string;
  key: string;
  song?: DownloadSong;
  options: DownloadOptions;
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
  tasks: DownloadTask[];
};

export type DownloadOptions = {
  quality: number;
  directory: string;
  nameTemplate: string;
  notificationMode: NotificationMode;
  skipDuplicates?: boolean;
};

export type DownloadDependencies = {
  helper: Pick<HelperClient, "request">;
  evaluate: (expression: string) => Promise<unknown>;
  notify: (title: string, body: string) => void;
  timers?: Pick<Window, "setInterval" | "clearInterval" | "setTimeout">;
};

const POLL_MS = 800;
const MENU_TICK_MS = 1000;
const DISABLED_STATUS = "打开播放器后可以下载当前歌曲";
const MENU_WAITING = "歌曲列表里每行的「···」菜单也能下载";
const MENU_LOST = "找到歌曲菜单但没认出这首歌，可能是网易云改版了";
const MENU_BROKEN = "菜单下载装不上，可能是网易云改版了";

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
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
  private queue: DownloadTask[] = [];
  private tasks: DownloadTask[] = [];
  private activeTask: DownloadTask | null = null;
  private serial = 0;
  private status = DISABLED_STATUS;
  private progress: DownloadProgress | null = null;
  private timer = 0;
  private menus = 0;
  private songs = 0;
  private menuBroken = false;
  private menuInstalled = false;
  private readonly resolveTrack?: (quality: number, song?: DownloadSong) => Promise<DownloadTrack>;
  private readonly dependencies: DownloadDependencies;
  private readonly timers: NonNullable<DownloadDependencies["timers"]>;

  constructor(options: () => DownloadOptions, dependencies: DownloadDependencies, resolveTrack?: (quality: number, song?: DownloadSong) => Promise<DownloadTrack>) {
    this.options = options;
    this.dependencies = dependencies;
    this.timers = dependencies.timers ?? window;
    this.resolveTrack = resolveTrack;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      if (this.activeTask) void this.cancelTask(this.activeTask.id);
      for (const task of this.queue) task.state = "cancelled";
    }
    this.generation++;
    this.busy = this.activeTask !== null;
    this.progress = null;
    this.queue = [];
    this.status = enabled ? "可以下载当前正在播放的歌曲" : DISABLED_STATUS;
    if (enabled) {
      this.timer = this.timers.setInterval((): void => void this.tickMenu(), MENU_TICK_MS);
      void this.tickMenu();
    } else {
      this.timers.clearInterval(this.timer);
      this.timer = 0;
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
      tasks: this.tasks.map(task => ({ ...task, song: task.song ? { ...task.song } : undefined })),
    };
  }

  /** 下载当前正在播放的歌曲，或用户在列表菜单里选中的那一首。 */
  async download(song?: DownloadSong, queuedTask?: DownloadTask): Promise<void> {
    if (!this.enabled) {
      this.status = "先打开播放器再下载";
      return;
    }
    if (this.busy) {
      // 辅助进程一次只跑一个任务；这一侧维护队列，把用户的重复点击变成依次下载，
      // 而不是撞上一堵 409 的墙。
      if (song != null) {
        if (!this.enqueue(song)) return;
        this.report(this.queue.length === 1 ? "已加入下载队列" : `已加入下载队列，前面还有 ${this.queue.length - 1} 首`);
      } else {
        this.report("正在下载，请稍候");
      }
      return;
    }
    const task = queuedTask ?? this.createTask(song);
    if (!task) return;
    const { quality, directory, nameTemplate, notificationMode, skipDuplicates } = task.options;
    task.state = "resolving";
    this.activeTask = task;
    const generation = ++this.generation;
    this.busy = true;
    this.progress = null;
    try {
      this.status = "正在解析音频地址";
      const track = await this.resolve(quality, song);
      if (generation !== this.generation || (task.state as string) === "cancelled") return;
      task.title = track.name;
      task.artist = track.artist;
      task.songId = song?.id ?? track.songId ?? 0;
      if (!task.song && task.songId) task.song = { id: task.songId, name: track.name, artist: track.artist };
      task.key = this.taskKey(task.songId, task.options);
      if (skipDuplicates !== false && this.tasks.some(item => item !== task && item.key === task.key && task.songId > 0 && ["completed", "skipped"].includes(item.state))) {
        task.state = "skipped"; this.status = "已跳过重复歌曲"; return;
      }
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
          notify: notificationMode,
          jobId: task.id,
          songId: task.songId,
          quality,
          skipDuplicates: skipDuplicates !== false,
        },
      });
      if (started.status === 409) {
        throw new Error(await failureText(started, "已有下载任务在进行"));
      }
      if (!started.ok) throw new Error(await failureText(started, "下载请求被拒绝"));
      const accepted = await started.json() as { skipped?: boolean; path?: string };
      if (generation !== this.generation) task.state = "cancelled";
      if (accepted.skipped) { task.state = "skipped"; task.path = accepted.path || ""; this.status = "文件已存在，已跳过下载"; return; }
      if ((task.state as string) === "cancelled") await this.cancelBackend(task.id);
      else task.state = "downloading";
      this.status = task.state === "cancelled" ? "正在取消下载，等待下载进程响应" : "正在下载";
      while (this.activeTask === task) {
        await new Promise(resolve => this.timers.setTimeout(resolve, POLL_MS));
        const response = await this.request("/download");
        if (!response.ok) throw new Error("读取下载进度失败");
        const job = (await response.json()) as DownloadJob;
        if (job.id && job.id !== task.id) throw new Error("下载任务已被替换，请重试");
        if (job.cancelled || task.state === "cancelled") {
          task.state = "cancelled";
          if (job.active) continue;
          this.status = "已取消下载";
          return;
        }
        if (job.error) throw new Error(job.error);
        if (job.active) {
          this.progress = { received: job.received, total: job.total, filename: job.filename };
          continue;
        }
        this.progress = null;
        this.status = job.path ? `已保存到 ${job.path}` : "下载已结束但没有生成文件";
        task.path = job.path || "";
        task.state = job.path ? "completed" : "failed";
        if (!job.path) task.error = this.status;
        if (notificationMode === "steam") {
          this.dependencies.notify("下载完成", job.path || this.status);
        }
        return;
      }
    } catch (error) {
      if (this.activeTask === task) {
        if ((task.state as string) === "cancelled") return;
        task.state = "failed";
        task.error = message(error);
        this.status = message(error);
        this.toast(this.status);
        if (notificationMode === "steam") {
          this.dependencies.notify("下载失败", this.status);
        }
      }
    } finally {
      if (this.activeTask === task) {
        this.busy = false;
        this.activeTask = null;
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
      const previous = this.queue.length;
      for (const song of songs) this.enqueue(song);
      const added = this.queue.length - previous;
      this.status = added ? `已加入 ${added} 首歌曲，开始依次下载` : "播放列表中的歌曲已在任务列表或下载记录中，已跳过";
      this.toast(this.status);
      this.pump();
    } catch {
      /* the player page is not there yet, or is mid-navigation */
    }
  }

  private pump(): void {
    if (this.busy || !this.enabled || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    void this.download(task.song, task);
  }

  private taskKey(id: number, options = this.options()): string { return `${id}:${options.quality}:${options.directory}`; }

  private createTask(song?: DownloadSong): DownloadTask | null {
    const key = this.taskKey(song?.id ?? 0);
    if (song && this.options().skipDuplicates !== false && this.tasks.some(task => task.key === key && ["queued", "resolving", "downloading", "completed", "skipped"].includes(task.state))) {
      this.report("已跳过重复歌曲"); return null;
    }
    this.tasks = this.tasks.filter((task, index) => task === this.activeTask || ["queued", "resolving", "downloading"].includes(task.state) || index >= this.tasks.length - 200);
    const task: DownloadTask = { id: `${Date.now()}-${++this.serial}`, songId: song?.id ?? 0, title: song?.name || "当前歌曲", artist: song?.artist || "", song,
      state: "queued", error: "", path: "", key, options: { ...this.options() } };
    this.tasks.push(task);
    return task;
  }

  private enqueue(song: DownloadSong): boolean { const task = this.createTask(song); if (task) this.queue.push(task); return task !== null; }

  async cancelTask(id: string): Promise<void> {
    const task = this.tasks.find(item => item.id === id);
    if (!task || !["queued", "resolving", "downloading"].includes(task.state)) return;
    const active = task === this.activeTask;
    task.state = "cancelled";
    this.queue = this.queue.filter(item => item !== task);
    if (active) { this.status = "正在取消下载，等待下载进程响应"; await this.cancelBackend(id); }
  }

  private async cancelBackend(id: string): Promise<void> {
    try { await this.request("/download/cancel", { method: "POST", body: { id } }); }
    catch { this.status = "取消请求未送达，正在等待下载进程响应"; }
  }

  retryTask(id: string): void {
    if (!this.enabled) { this.report("先打开播放器再重试下载"); return; }
    const task = this.tasks.find(item => item.id === id);
    if (task === this.activeTask) { this.report("正在等待取消完成，请稍后重试"); return; }
    if (task?.song && ["failed", "cancelled"].includes(task.state)) {
      const replacement = this.createTask(task.song);
      if (!replacement) return;
      this.tasks = this.tasks.filter(item => item !== task);
      this.queue.push(replacement);
      this.pump();
    }
  }

  retryFailed(): void { for (const task of [...this.tasks]) if (task.state === "failed") this.retryTask(task.id); }
  clearFinished(): void { this.tasks = this.tasks.filter(task => task === this.activeTask || ["queued", "resolving", "downloading"].includes(task.state)); }

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
      for (const song of pending) this.enqueue(song);
      this.pump();
    } catch {
      /* the player page is not there yet, or is mid-navigation */
    }
  }

  private async resolve(quality: number, song?: DownloadSong): Promise<DownloadTrack> {
    if (this.resolveTrack) return this.resolveTrack(quality, song);
    const result = await this.evaluate(downloadScript(quality, song));
    const track = result as DownloadTrack | null;
    if (!track?.url) throw new Error("没有解析到可下载的音频地址");
    return track;
  }

  /** 在共享的播放器会话上求值，该会话只 attach 一次然后反复复用。 */
  private async evaluate(expression: string): Promise<unknown> {
    return this.dependencies.evaluate(expression);
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
    try {
      return await this.dependencies.helper.request(path, {
        method: options.method ?? "GET",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      if (error instanceof HelperConnectionError) throw new Error("下载需要 Python 3 和 MPRIS 辅助进程，目前仅 Linux 支持");
      throw error;
    }
  }
}
