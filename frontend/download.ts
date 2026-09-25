import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";
import { downloadScript, songFileName, type DownloadSong, type DownloadTrack } from "./download-player.ts";
import { MENU_TICK_SCRIPT, menuToastScript } from "./menu-player.ts";

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

export type DownloadOptions = { quality: number; directory: string };

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

/** The helper answers a rejected request with {"error": "..."}; prefer that over a generic message. */
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
  private status = DISABLED_STATUS;
  private progress: DownloadProgress | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private timer = 0;
  private menus = 0;
  private songs = 0;
  private menuBroken = false;

  constructor(options: () => DownloadOptions) {
    this.options = options;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.generation++;
    this.busy = false;
    this.progress = null;
    this.status = enabled ? "可以下载当前正在播放的歌曲" : DISABLED_STATUS;
    if (enabled) {
      this.timer = window.setInterval(() => void this.tickMenu(), MENU_TICK_MS);
      void this.tickMenu();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
      this.endpoint = null;
      this.token = null;
      this.menus = 0;
      this.songs = 0;
      this.menuBroken = false;
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

  /** Downloads the song playing right now, or one the user picked from a list menu. */
  async download(song?: DownloadSong): Promise<void> {
    if (!this.enabled) {
      this.status = "先打开播放器再下载";
      return;
    }
    if (this.busy) {
      this.report("正在下载，请稍候");
      return;
    }
    const { quality, directory } = this.options();
    const generation = ++this.generation;
    this.busy = true;
    this.progress = null;
    try {
      this.status = "正在解析音频地址";
      const track = await this.resolve(quality, song);
      if (generation !== this.generation) return;
      if (track.source === "player") this.status = "网易云没有返回所选音质，改用当前播放的音频流";
      else this.status = `正在下载 ${track.artist ? `${track.artist} - ` : ""}${track.name}`;
      this.toast(this.status);
      const started = await this.request("/download", {
        method: "POST",
        body: { url: track.url, filename: songFileName(track.artist, track.name), directory, type: track.type },
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
        return;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.status = message(error);
        this.toast(this.status);
      }
    } finally {
      if (generation === this.generation) this.busy = false;
    }
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

  /** Reports where the user is actually looking; the settings tab is usually not on screen. */
  private toast(text: string): void {
    void this.evaluate(menuToastScript(text)).catch(() => {});
  }

  /**
   * The menu scanner installs itself through this very call and is idempotent, so a page reload
   * only means it gets installed again on the next tick.
   */
  private async tickMenu(): Promise<void> {
    if (!this.enabled) return;
    const generation = this.generation;
    try {
      const result = (await this.evaluate(MENU_TICK_SCRIPT)) as MenuTick | null;
      if (generation !== this.generation || result == null) return;
      if (result.error) this.menuBroken = true;
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

  /** One attach/evaluate/detach round trip against the player page. */
  private async evaluate(expression: string): Promise<unknown> {
    const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
    const target = targets.targetInfos.find((item: { url: string }) => isPlayerDocument(item.url));
    if (!target) throw new Error("等待网易云播放器加载");
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      const result = await ChromeDevToolsProtocol.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        attached.sessionId,
      );
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } finally {
      try {
        await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId: attached.sessionId });
      } catch {}
    }
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
