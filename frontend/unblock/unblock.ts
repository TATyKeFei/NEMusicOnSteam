import { ffi } from "millennium";
import { evaluateInPlayer, tryEvaluateInPlayer } from "../player/player-target.ts";
import { downloadScript, type DownloadSong, type DownloadTrack } from "../download/download-player.ts";
import type { UnblockSource } from "./sources.ts";
import { unblockPageHookScript, UNBLOCK_PAGE_UNINSTALL_SCRIPT } from "./page-hook.ts";

const getEndpoint = ffi<[], string>("unblock_endpoint");
const stopHelper = ffi<[], string>("unblock_stop");
type UnblockOptions = { enabled: boolean; sources: UnblockSource[] };
type MatchResult = { url: string; type: string; br: number; size: number; provider: string };

export class UnblockBridge {
  private endpoint = "";
  private token = "";
  private status = "等待需要替换的歌曲";
  private generation = 0;
  private pending = new Set<AbortController>();
  private connecting: Promise<void> | null = null;
  private stopping: Promise<unknown> | null = null;
  private hookTimer = 0;
  private readonly options: () => UnblockOptions;

  constructor(options: () => UnblockOptions) {
    this.options = options;
  }

  getStatus(): string {
    if (!this.options().enabled) return "已关闭";
    if (!/Linux/i.test(navigator.platform)) return "目前仅 Linux 支持";
    return this.status;
  }

  reset(): void {
    this.generation++;
    window.clearTimeout(this.hookTimer);
    this.hookTimer = 0;
    const uninstalling = tryEvaluateInPlayer(UNBLOCK_PAGE_UNINSTALL_SCRIPT).catch(() => {});
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    const settling = Promise.allSettled([this.connecting, this.stopping, uninstalling]);
    this.endpoint = "";
    this.token = "";
    this.status = "等待需要替换的歌曲";
    this.stopping = settling.then(() => stopHelper()).catch(() => {});
    this.connecting = null;
  }

  async check(): Promise<void> {
    if (!this.options().enabled || !/Linux/i.test(navigator.platform)) return;
    const generation = this.generation;
    try {
      await this.request("/status", undefined);
      if (generation === this.generation) this.status = "本地服务已连接（Node.js）";
    } catch (error) {
      if (generation === this.generation) this.status = this.errorMessage(error);
    }
  }

  async installPageHook(): Promise<void> {
    window.clearTimeout(this.hookTimer);
    this.hookTimer = 0;
    const generation = this.generation;
    const enabled = this.options().enabled && /Linux/i.test(navigator.platform);
    if (!enabled) {
      await tryEvaluateInPlayer(UNBLOCK_PAGE_UNINSTALL_SCRIPT).catch(() => {});
      return;
    }
    try {
      await this.connect(generation);
      if (generation !== this.generation) return;
      if (!this.endpoint || !this.token) return;
      const installed = await tryEvaluateInPlayer(unblockPageHookScript(this.endpoint, this.token, this.options().sources));
      if (generation !== this.generation) return;
      if (installed !== true) throw new Error("网页解灰尚未就绪，正在等待请求模块");
      const status = await tryEvaluateInPlayer("globalThis.__NEMusicOnSteamUnblockHook?.status || ''");
      if (generation !== this.generation) return;
      this.status = typeof status === "string" && status ? status : "网页解灰已就绪";
    } catch (error) {
      if (generation === this.generation) this.status = this.errorMessage(error);
    } finally {
      if (generation === this.generation && this.options().enabled) {
        this.hookTimer = window.setTimeout(() => { void this.installPageHook(); }, 30000);
      }
    }
  }

  async resolve(quality: number, song?: DownloadSong, signal?: AbortSignal): Promise<DownloadTrack> {
    const generation = this.generation;
    const options = this.options();
    const enabled = options.enabled && /Linux/i.test(navigator.platform);
    const track = await evaluateInPlayer(downloadScript(quality, song, enabled), { awaitPromise: true }) as DownloadTrack | null;
    if (signal?.aborted || generation !== this.generation) throw new Error("音频解析已取消");
    if (!track) throw new Error("没有解析到音频信息");
    if (track.url && (!enabled || !track.trial)) return track;
    if (!enabled) throw new Error("网易云没有返回可用的音频地址");
    if (!Number.isSafeInteger(track.songId) || track.songId! <= 0) throw new Error("没有识别到网易云歌曲 ID");
    this.status = `正在匹配：${track.name || track.songId}`;
    try {
      const matched = await this.request("/match", { id: track.songId, sources: options.sources }, signal) as MatchResult;
      if (signal?.aborted || generation !== this.generation) throw new Error("音频解析已取消");
      if (!/^https?:\/\//.test(matched.url)) throw new Error("音源没有返回可用地址");
      this.status = `已匹配 ${matched.provider}：${track.name || track.songId}`;
      return { ...track, ...matched, source: "unblock", trial: false, level: "" };
    } catch (error) {
      if (!signal?.aborted && generation === this.generation) this.status = this.errorMessage(error);
      throw error;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async connect(generation: number): Promise<void> {
    if (!this.connecting) {
      this.connecting = (async () => {
        await this.stopping;
        if (generation !== this.generation) throw new Error("音源服务已关闭");
        const result = await getEndpoint();
        if (generation !== this.generation) throw new Error("音源服务已关闭");
        const match = /^(http:\/\/127\.0\.0\.1:\d+)\|(.+)$/.exec(result);
        if (!match) throw new Error(`解灰服务启动失败，请安装 Node.js 22+${result.startsWith("!") ? `（${result.slice(1)}）` : ""}`);
        this.endpoint = match[1];
        this.token = match[2];
      })();
    }
    const connecting = this.connecting;
    try { await connecting; }
    finally { if (this.connecting === connecting) this.connecting = null; }
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const generation = this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.pending.add(controller);
    const timer = window.setTimeout(abort, 30000);
    try {
      if (signal?.aborted) controller.abort();
      if (controller.signal.aborted) throw new Error("音频解析已取消");
      await this.connect(generation);
      if (generation !== this.generation || controller.signal.aborted) throw new Error("音频解析已取消");
      const response = await fetch(`${this.endpoint}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "X-NEMusic-Token": this.token, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || `音源服务返回 ${response.status}`);
      return result;
    } catch (error) {
      if (generation === this.generation) { this.endpoint = ""; this.token = ""; }
      if (controller.signal.aborted) throw new Error(signal?.aborted || generation !== this.generation ? "音频解析已取消" : "音源匹配超时");
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
    }
  }
}
