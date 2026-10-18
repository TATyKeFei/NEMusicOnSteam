import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { downloadScript, type DownloadSong, type DownloadTrack } from "../download/download-player.ts";
import { TRANSITION_CANDIDATE_SCRIPT, transitionClockScript, transitionCommitScript, type TransitionCandidate } from "./transition-player.ts";
import type { Command } from "../mpris/mpris-player.ts";
import type { ExternalPlayback, TrackState } from "../mpris/mpris.ts";

/** /analyze 的单曲特征：BPM、开头平均能量、Camelot 调性编号。 */
export type AnalyzedTrack = { trackId: string; bpm: number | null; energy: number | null; key: string | null };

const EMPTY_STATE: TrackState = {
  active: false,
  playbackStatus: "Stopped",
  title: "",
  artist: "",
  lyrics: "",
  album: "",
  artUrl: "",
  trackId: "",
  duration: 0,
  position: 0,
  canSeek: false,
  canGoNext: false,
  canGoPrevious: false,
  volume: 1,
  loopStatus: "None",
  shuffle: false,
  rate: 1,
};

const FAILURE_REASONS: Record<string, string> = {
  retry: "辅助进程启动失败，正在重试",
  "asset-helper": "插件包缺少播放辅助进程脚本",
  "write-helper": "无法写入播放辅助进程脚本",
  "write-token": "无法写入辅助进程令牌",
  spawn: "辅助进程启动后没有监听端口",
  "asset-playback-http": "插件包缺少 backend/playback_http.py",
  "write-playback-http": "无法写入播放辅助进程接口模块",
};

/**
 * 网易云的音乐是 Howler 用 html5 模式播的，真实的 <audio> 是 Howler 从自己的对象池里
 * 拿的游离节点，从来不进 DOM，所以光扫 document.querySelector('audio, video') 一只
 * 也找不到，网页和 外部播放器 就会一起出声。这里同时沿 Howler._howls -> _sounds -> _node 走
 * 一遍、装上 HTMLMediaElement.prototype.play 钩子把之后新建的节点挡在出声之前，
 * 并给每个节点挂 volumechange 监听防止 Howler 又把音量调回来。
 * 只静音、绝不 pause：页面一旦被 pause，它的 ended 事件就不会来，歌就不会自己往下走。
 */
export const EXTERNAL_MUTE_SCRIPT = `(() => {
  const key = '__NEMusicOnSteamMpvMedia';
  const bridge = globalThis[key] || {};
  if (!bridge.saved || typeof bridge.saved.clear !== 'function') bridge.saved = new Map();
  if (!bridge.paused || typeof bridge.paused.clear !== 'function') bridge.paused = new Set();
  const collect = root => {
    const media = Array.from(root.querySelectorAll('audio, video'));
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot) media.push(...collect(element.shadowRoot));
    }
    return media;
  };
  const howlerNodes = () => {
    const nodes = [];
    const howler = globalThis.Howler;
    const add = node => { if (node instanceof HTMLMediaElement) nodes.push(node); };
    for (const howl of (howler && howler._howls) || []) {
      if (!howl) continue;
      for (const sound of howl._sounds || []) add(sound && sound._node);
    }
    for (const node of (howler && howler._html5AudioPool) || []) add(node);
    return nodes;
  };
  bridge.silence = element => {
    if (!(element instanceof HTMLMediaElement)) return;
    if (!bridge.saved.has(element)) bridge.saved.set(element, { volume: element.volume, muted: element.muted });
    if (!element.nemusicMpvGuard) {
      element.nemusicMpvGuard = true;
      element.addEventListener('volumechange', () => {
        if (bridge.active && (element.muted !== true || element.volume !== 0)) {
          element.muted = true;
          element.volume = 0;
        }
      });
    }
    element.muted = true;
    element.volume = 0;
  };
  if (!bridge.playHook && typeof HTMLMediaElement.prototype.play === 'function') {
    bridge.playHook = true;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (bridge.active) bridge.silence(this);
      return play.apply(this, arguments);
    };
  }
  bridge.active = true;
  for (const element of collect(document).concat(howlerNodes())) bridge.silence(element);
  globalThis[key] = bridge;
  return bridge.saved.size;
})()`;

/**
 * 放开静音；resume 为真时把被我们 pause 掉的页面声音接回去（经 Howler API，
 * 这样页面自己的状态机也一起恢复），让 外部播放器 后端关闭后网页能接着出声。
 */
function externalUnmuteScript(resume: boolean): string {
  return `(() => {
    const key = '__NEMusicOnSteamMpvMedia';
    const bridge = globalThis[key];
    if (bridge) bridge.active = false;
    const controls = globalThis.__NEMusicOnSteamMpvControls;
    if (controls) {
      controls.active = false;
      controls.allowAction = '';
      controls.actions?.splice?.(0, controls.actions.length);
      if (typeof controls.onClick === 'function') document.removeEventListener('click', controls.onClick, true);
      controls.onClick = null;
      controls.installed = false;
    }
    let restored = 0;
    if (bridge && bridge.saved) {
      for (const entry of bridge.saved) {
        entry[0].volume = entry[1].volume;
        entry[0].muted = entry[1].muted;
        restored++;
      }
      bridge.saved.clear();
    }
    const paused = bridge && bridge.paused ? Array.from(bridge.paused) : [];
    if (bridge && bridge.paused) bridge.paused.clear();
    if (${resume ? "true" : "false"}) {
      const howler = globalThis.Howler;
      const howls = (howler && howler._howls) || [];
      for (const howl of paused) {
        if (howls.indexOf(howl) < 0 || !howl || typeof howl.play !== 'function') continue;
        if (typeof howl.playing === 'function' && howl.playing()) continue;
        const sounds = howl._sounds || [];
        if (!sounds.some(sound => sound && sound._node && !sound._ended)) continue;
        howl.play();
        restored++;
      }
    }
    return restored;
  })()`;
}

/**
 * 外部播放器 是唯一的音频出口，页面只是播放列表和状态源：外部播放器 在播就把页面接回去，
 * 外部播放器 暂停/停止就把页面 pause 掉，否则页面会静音地把整首歌播完并自动切歌，
 * 新歌一进 loadFromWeb 就又把暂停中的 外部播放器 拉起来。只能经 Howler 的 API 动手，
 * howler 没有给 audio 节点绑 play/pause 事件，直接戳节点页面根本不知道。
 * allowPause 为假表示正处在切歌过渡里，此时页面必须保持播放，不然歌会断。
 */
function externalSyncScript(playing: boolean, allowPause: boolean, holdWeb = false): string {
  return `(() => {
    const howler = globalThis.Howler;
    const bridge = globalThis.__NEMusicOnSteamMpvMedia;
    if (!howler || !howler._howls || !bridge) return 0;
    if (!bridge.paused || typeof bridge.paused.clear !== 'function') bridge.paused = new Set();
    const resumable = howl => (howl._sounds || []).some(sound => sound && sound._node && !sound._ended);
    let touched = 0;
    for (const howl of howler._howls) {
      if (!howl || typeof howl.playing !== 'function') continue;
      if (${playing && !holdWeb ? "true" : "false"}) {
        if (howl.playing() || !resumable(howl) || typeof howl.play !== 'function') continue;
        howl.play();
        bridge.paused.delete(howl);
        touched++;
      } else if (${allowPause || holdWeb ? "true" : "false"}) {
        if (!howl.playing()) continue;
        howl.pause();
        bridge.paused.add(howl);
        touched++;
      }
    }
    return touched;
  })()`;
}

const EXTERNAL_CONTROL_INSTALL_SCRIPT = `(() => {
  const key = '__NEMusicOnSteamMpvControls';
  const existing = globalThis[key];
  const bridge = existing || { actions: [] };
  bridge.active = true;
  if (!bridge.installed) {
    bridge.installed = true;
    bridge.onClick = event => {
      if (!bridge.active) return;
      const target = event.target instanceof Element ? event.target.closest('#btn_pc_minibar_play, #btn_pc_next, #btn_pc_previous') : null;
      if (!target) return;
      const action = target.id === 'btn_pc_next' ? 'next' : target.id === 'btn_pc_previous' ? 'previous' : 'playpause';
      if (bridge.allowAction === action) {
        bridge.allowAction = '';
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      bridge.actions.push(action);
    };
    document.addEventListener('click', bridge.onClick, true);
  }
  // 音量不走 DOM 监听：滑块是 div[role=slider]，拖动时不派发 input/change；
  // tick 拿快照里的网页音量跟 外部播放器 对账（网页 store 才是音量的唯一来源）。
  globalThis[key] = bridge;
  return true;
})()`;

const EXTERNAL_CONTROL_POLL_SCRIPT = `(() => {
  const bridge = globalThis.__NEMusicOnSteamMpvControls;
  if (!bridge || !Array.isArray(bridge.actions)) return { actions: [] };
  return { actions: bridge.actions.splice(0, bridge.actions.length) };
})()`;

function allowWebActionScript(action: string): string {
  return `(() => { const bridge = globalThis.__NEMusicOnSteamMpvControls; if (bridge) bridge.allowAction = ${JSON.stringify(action)}; return true; })()`;
}

const CLEAR_WEB_ACTION_SCRIPT = `(() => { const bridge = globalThis.__NEMusicOnSteamMpvControls; if (bridge) bridge.allowAction = ''; return true; })()`;

function describeFailure(result: string, name: string): string {
  const match = /^!([a-z-]+)(?::(.*))?$/.exec(result);
  const code = match?.[1] ?? "";
  const detail = match?.[2] ?? "";
  if (code === "mkdir") return `${name} 不可用：无法创建运行目录 ${detail}`;
  const reason = FAILURE_REASONS[code];
  if (reason) return `${name} 不可用：${reason}${detail ? `（${detail}）` : ""}`;
  return `${name} 不可用；请检查辅助进程和连接配置`;
}

export type ExternalAudioOptions = {
  name: string;
  endpoint: () => Promise<string>;
  configuration?: () => unknown;
  supportsRate?: boolean;
  quality: () => number;
  commandWeb: (command: Command) => Promise<boolean>;
  resolveTrack?: (quality: number, signal?: AbortSignal) => Promise<DownloadTrack>;
  holdWebDuringResolution?: () => boolean;
  transition?: () => { mode: "off" | "normal" | "smart"; seconds: number; fallback?: "normal" | "none" | "force" };
  resolveNextTrack?: (quality: number, song: DownloadSong, signal?: AbortSignal) => Promise<DownloadTrack>;
};

type ExternalAudioPayload = Partial<TrackState> & {
  url?: string; autoplay?: boolean; position?: number;
  transition?: { from: string; trackId: string; ready: boolean; seconds: number; trim: number; startAt?: number; mode?: string; reason?: string };
  transitioning?: boolean;
  transportRevision?: number;
  transitionCancelled?: boolean;
  transitioned?: boolean;
};

// 切歌（MPRIS 的上一首/下一首、播完自动切歌）到新歌真的喂进 外部播放器 之间有一段窗口，
// 窗口里 外部播放器 还是 Stopped、页面也可能正 Paused；这个标记让 loadFromWeb 一定要 autoplay、
// 并让 sync 别把正在切歌的页面按住。用 tick 预算而不是布尔，否则一次没有生效的切歌
// （原地重播、播放列表到底）会让它永久挂着，外部播放器 暂停之后页面又自己切歌把它带起来。
const PENDING_AUTOPLAY_TICKS = 12;

// 外部播放器 的 volume 是 0..100、网页 store 是 0..1，来回取整会有抖动，差一个百分点才算数。
const VOLUME_EPSILON = 0.01;

// 进度门槛要远大于 tick 间隔：两边都在走表，读数天然差着几十毫秒，太敏感会拿 seek 打架。
// 用户拖进度条一次跳的都是好几秒，1.5 秒的门槛足够把拖动和正常漂移分开。
const SEEK_EPSILON = 1.5;

// 接管后等网页切歌过来的观察窗。官网解析/更新 store 慢是常态，期间只观察绝不撤销：
// 撤销（cancelFade）会立刻掐掉正在淡出的旧歌、把新歌顶到全音量——听感就是一秒硬切。
const TRANSITION_COMMIT_WINDOW = 12000;

// 后端过渡分析给出的回退原因（transition_analysis 的 reason 字段），翻成状态里给用户看的话。
const TRANSITION_REASONS: Record<string, string> = {
  "unstable-beats": "拍点不稳",
  "tempo-gap": "速度差太大",
  "late-intro-beat": "前奏太静",
  "short-beat-window": "拍点窗口太短",
};

// 「已连接（……）」里的过渡说明。分析回退时带上原因，让用户随时能看出为什么没混音；
// 普通模式（reason "normal"）和还在分析（"analysis-unavailable"）不打扰。
function transitionNote(planned: { mode?: string; reason?: string } | null | undefined): string {
  if (!planned) return "";
  if (planned.mode === "smart") return "节拍混音";
  const reason = TRANSITION_REASONS[planned.reason ?? ""] ?? "";
  if (!reason) return "";
  return `${reason}，${planned.mode === "none" ? "不做混音" : "普通过渡"}`;
}

// 网页 store 记着这些状态，外部播放器 只是跟着走的输出端，命令必须先落到网页再发给 外部播放器。
const WEB_AUTHORED_COMMANDS = ["volume", "seek", "setposition", "rate", "shuffle", "loop"];

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class ExternalAudioBridge implements ExternalPlayback {
  private timer = 0;
  private busy = false;
  private enabled = false;
  private generation = 0;
  private requests: AbortController | null = null;
  private stopping: Promise<void> | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private state: TrackState = { ...EMPTY_STATE };
  private status = "尚未连接";
  private previousStatus: TrackState["playbackStatus"] = "Stopped";
  /** 用户要求过 stop：粘性标志，挡掉 外部播放器 掉轨之后的自动重载和自动切歌。 */
  private stopRequested = false;
  /** 用户要求过 play：外部播放器 手里没歌时用来把它重新拉起来。 */
  private playRequested = false;
  private pauseRequested = false;
  private lastWebTrackId = "";
  private pendingAutoplay = 0;
  private alternateTrack = false;
  private transportEpoch = 0;
  private transitionKey = "";
  private transitionPrepared: { track: DownloadTrack } | null = null;
  private transitionPreparing: Promise<void> | null = null;
  private transitionNeedsClear = false;
  private transitionRetryAt = 0;
  private transitionClockTrack = "";
  private transitionClockUntil = 0;
  /** 混音已交接给后端、等网页切到新歌的等待阶段；见 advanceTransitionCommit。 */
  private transitionCommit: { candidate: TransitionCandidate; key: string; alternate: boolean; smart: boolean; note: string; until: number; clicked: boolean } | null = null;
  private readonly options: ExternalAudioOptions;

  constructor(options: ExternalAudioOptions) {
    this.options = options;
  }

  start(): void {
    if (!/Linux/i.test(navigator.platform)) {
      this.status = `仅 Linux 支持 ${this.options.name} 后端`;
    }
  }

  setEnabled(enabled: boolean, restoreWeb = true): void {
    if (enabled === this.enabled) return;
    const generation = ++this.generation;
    this.enabled = enabled;
    if (!enabled) {
      // 用户按停的意图要活到关后端这一刻：resume 得赶在清标志之前算出来，
      // 否则 stop() 会以为页面该被接回去，凭空把用户停掉的歌放出来。
      const resume = !this.stopRequested && this.state.playbackStatus !== "Paused";
      this.stopRequested = false;
      this.playRequested = false;
      this.pauseRequested = false;
      this.pendingAutoplay = 0;
      window.clearInterval(this.timer);
      this.timer = 0;
      this.requests?.abort();
      if (!this.stopping) {
        const stopping = this.stop(resume, restoreWeb);
        this.stopping = stopping;
        const clearStopping = () => {
          if (this.stopping === stopping) this.stopping = null;
        };
        void stopping.then(clearStopping, clearStopping);
      }
      return;
    }
    this.stopRequested = false;
    this.playRequested = false;
    this.pauseRequested = false;
    this.pendingAutoplay = 0;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = `仅 Linux 支持 ${this.options.name} 后端`;
      return;
    }
    const start = (): void => {
      if (!this.enabled || generation !== this.generation) return;
      this.requests = new AbortController();
      this.timer = window.setInterval((): void => void this.tick(), 500);
      void this.tick();
    };
    if (this.stopping) void this.stopping.then(start, start);
    else start();
  }

  reconnect(): void {
    if (!this.enabled) return;
    this.setEnabled(false, false);
    this.setEnabled(true);
  }

  whenStopped(): Promise<void> {
    return this.stopping ?? Promise.resolve();
  }

  getStatus(): string {
    return this.status;
  }

  snapshot(): TrackState {
    return { ...this.state };
  }

  /**
   * 让后端离线分析一批歌曲的开头（BPM/能量/调性），供歌单智能排序使用。
   * 走独立的 /analyze 接口，不碰播放队列；后端不可用时抛错，由调用方提示。
   */
  async analyze(tracks: { trackId: string; url: string }[]): Promise<{ tracks: AnalyzedTrack[] }> {
    const generation = this.generation;
    if (!this.enabled || !(await this.connect(generation)) || !this.isCurrent(generation)) {
      throw new Error(`${this.options.name} 后端未连接，无法分析歌曲`);
    }
    const response = await this.request("/analyze", generation, { tracks });
    if (!this.isCurrent(generation)) throw new Error("连接已失效，请重试");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `分析失败：${response.status}`);
    }
    return await response.json() as { tracks: AnalyzedTrack[] };
  }

  async command(command: Command): Promise<boolean> {
    const generation = this.generation;
    if (!this.isCurrent(generation)) return false;
    try {
      return await this.executeCommand(command, generation);
    } catch (error) {
      if (!this.isCurrent(generation)) return false;
      throw error;
    }
  }

  private async executeCommand(command: Command, generation: number): Promise<boolean> {
    if (command.action === "rate" && this.options.supportsRate === false) return false;
    if (["play", "pause", "playpause", "stop", "next", "previous", "seek", "setposition", "loop", "shuffle"].includes(command.action)) this.transportEpoch++;
    if (["next", "previous", "stop", "seek", "setposition", "loop", "shuffle"].includes(command.action)) {
      this.invalidateTransition();
      this.transitionClockTrack = "";
    }
    if (command.action === "next" || command.action === "previous") {
      const autoplay = this.state.playbackStatus === "Playing" || this.pendingAutoplay > 0;
      await tryEvaluateInPlayer(allowWebActionScript(command.action));
      if (!this.isCurrent(generation)) return false;
      const handled = await this.options.commandWeb(command);
      if (!this.isCurrent(generation)) return false;
      await tryEvaluateInPlayer(CLEAR_WEB_ACTION_SCRIPT);
      if (!this.isCurrent(generation)) return false;
      if (handled) {
        if (autoplay) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
        this.stopRequested = false;
      }
      return handled;
    }
    if (!this.endpoint || !this.token) return false;
    // 网页 store 是音量/进度/倍速/循环/随机的唯一来源：这些命令先写网页再动 外部播放器。
    // 顺序反了会在"外部播放器 已新、网页还旧"的窗口里被 tick 的对账把 外部播放器 拽回旧值。
    if (WEB_AUTHORED_COMMANDS.includes(command.action)) {
      await this.options.commandWeb(command);
      if (!this.isCurrent(generation)) return false;
    }
    // 外部播放器 的播放状态是权威，这些标志要在 /command 之前落好：请求失败时下个 tick 还会照着
    // 它们重试，而播放类命令失败的唯一常见原因就是 外部播放器 手里已经没歌了。
    if (command.action === "stop") {
      this.stopRequested = true;
      this.playRequested = false;
      this.pauseRequested = false;
      this.pendingAutoplay = 0;
    } else if (command.action === "pause") {
      this.playRequested = false;
      this.pauseRequested = true;
    } else if (command.action === "play") {
      this.stopRequested = false;
      this.playRequested = true;
      this.pauseRequested = false;
    } else if (command.action === "playpause") {
      if (this.state.playbackStatus === "Playing") { this.playRequested = false; this.pauseRequested = true; }
      else {
        this.stopRequested = false;
        this.playRequested = true;
        this.pauseRequested = false;
      }
    }
    const response = await this.request("/command", generation, command);
    if (!this.isCurrent(generation)) return false;
    const payload = (await response.json()) as { handled?: boolean };
    return this.isCurrent(generation) && response.ok && payload.handled === true;
  }

  private isCurrent(generation: number): boolean {
    return this.enabled && this.timer !== 0 && generation === this.generation;
  }

  private async connect(generation: number): Promise<boolean> {
    if (this.endpoint && this.token) return true;
    const result = await this.options.endpoint();
    if (!this.isCurrent(generation)) return false;
    const separator = result.lastIndexOf("|");
    if (separator < 0) {
      this.status = describeFailure(result, this.options.name);
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    if (this.options.configuration) {
      const response = await this.request("/configure", generation, this.options.configuration());
      if (!this.isCurrent(generation)) return false;
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "连接配置失败");
      }
    }
    this.status = `${this.options.name} 已连接`;
    return true;
  }

  private async request(path: string, generation: number, body?: unknown): Promise<Response> {
    if (!this.isCurrent(generation) || !this.endpoint || !this.token) throw new Error(`${this.options.name} 后端已关闭`);
    return fetch(`${this.endpoint}${path}`, {
      method: body == null ? "GET" : "POST",
      headers: { "X-NEMusic-Token": this.token!, ...(body == null ? {} : { "Content-Type": "application/json" }) },
      body: body == null ? undefined : JSON.stringify(body),
      signal: this.requests?.signal,
    });
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    const generation = this.generation;
    this.busy = true;
    try {
      if (this.pendingAutoplay > 0) this.pendingAutoplay--;
      if (!(await this.connect(generation)) || !this.isCurrent(generation)) return;
      await tryEvaluateInPlayer(EXTERNAL_CONTROL_INSTALL_SCRIPT);
      if (!this.isCurrent(generation)) return;
      const actions = (await tryEvaluateInPlayer(EXTERNAL_CONTROL_POLL_SCRIPT)) as unknown;
      if (!this.isCurrent(generation)) return;
      const queued = Array.isArray(actions) ? actions : (actions as { actions?: unknown } | null)?.actions;
      if (Array.isArray(queued)) {
        for (const action of queued) {
          if (action === "next" || action === "previous" || action === "playpause") {
            await this.command({ action });
            if (!this.isCurrent(generation)) return;
          }
        }
      }
      // 先静音再读快照：新一首歌的游离 audio 可能这一 tick 才被 Howler 拿出来。
      await tryEvaluateInPlayer(EXTERNAL_MUTE_SCRIPT);
      if (!this.isCurrent(generation)) return;
      const web = (await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true })) as TrackState | null;
      if (!this.isCurrent(generation)) return;
      if (web?.trackId && web.trackId !== this.lastWebTrackId) {
        // 混音已经交接到这一首时，网页只是慢慢切过来：绝不能重新换源。
        // loadFromWeb 会把正在淡入的新歌 loadfile 顶掉——旧歌被掐、新歌从 0 秒重放。
        const arriving = this.transitionCommit ? String(this.transitionCommit.candidate.song.id) : "";
        if (web.trackId === arriving || web.trackId === this.state.trackId) {
          this.lastWebTrackId = web.trackId;
        } else {
          await this.loadFromWeb(web, this.shouldAutoplay(web), generation);
          if (!this.isCurrent(generation)) return;
        }
      }
      const response = await this.request("/state", generation);
      if (!this.isCurrent(generation)) return;
      if (!response.ok) {
        const failure = await response.json() as { error?: string };
        throw new Error(failure.error || `${this.options.name} state failed: ${response.status}`);
      }
      const payload = (await response.json()) as ExternalAudioPayload;
      if (!this.isCurrent(generation)) return;
      if (await this.updateTransition(web, payload, generation)) return;
      if (!this.isCurrent(generation)) return;
      const next = this.normalize(payload, web);
      let protectClock = this.transitionClockTrack === next.trackId
        && (payload.transitioning || Date.now() < this.transitionClockUntil);
      if (protectClock) {
        const drift = Math.abs((web?.position ?? 0) - next.position);
        const clock = await tryEvaluateInPlayer(transitionClockScript(next.trackId, next.position, drift > SEEK_EPSILON), { awaitPromise: true }) as { seek?: number | null } | null;
        if (!this.isCurrent(generation)) return;
        if (typeof clock?.seek === "number" && Number.isFinite(clock.seek)) {
          this.invalidateTransition();
          await this.request("/command", generation, { action: "setposition", value: Math.round(clock.seek * 1_000_000) });
          if (!this.isCurrent(generation)) return;
          next.position = clock.seek;
          this.transitionClockTrack = "";
        } else if (!payload.transitioning && web?.trackId === this.transitionClockTrack && web?.position > 0 && drift <= SEEK_EPSILON) {
          // 网页真的落在目标歌、进度也对齐了才放下保护：网页还没切过来时它一放手，
          // 下面的进度对账就会把后端拽到旧歌的进度上。
          this.transitionClockTrack = "";
        }
        // 本轮快照在对齐前读取，不能再拿它反向改回真实音频时钟。
        protectClock = true;
      }
      // 网页 store 是音量的唯一来源（网页滑块和媒体键最后都落到它），外部播放器 只跟着走：
      // 拖滑块时网页那边的 div[role=slider] 不派发事件，只能靠这里的对账把音量送过去。
      if (next.active && next.volume != null && web?.volume != null && Math.abs(web.volume - next.volume) > VOLUME_EPSILON) {
        await this.request("/command", generation, { action: "volume", value: web.volume });
        if (!this.isCurrent(generation)) return;
        next.volume = web.volume;
      }
      // 进度同理：网页的进度条也是 div[role=slider]，拖完没有事件可听，只能靠快照发现。
      // 只在两边同一首且都在播时对账——暂停中 seek 会把刚按住的 外部播放器 拽走；
      // position 为 0 视作读不到进度（页面还没量出来），否则会把 外部播放器 甩回开头。
      if (!protectClock && !this.alternateTrack && next.active && web?.canSeek && web.trackId && web.trackId === next.trackId
        && next.playbackStatus === "Playing" && web.playbackStatus === "Playing"
        && web.position > 0 && Math.abs(web.position - next.position) > SEEK_EPSILON) {
        this.invalidateTransition();
        await this.request("/command", generation, { action: "setposition", value: Math.round(web.position * 1_000_000) });
        if (!this.isCurrent(generation)) return;
        next.position = web.position;
      }
      // 播完和掉轨是两回事：播完时 path 还在，掉轨时辅助进程连 path 都没有了。
      // 前者往下一首走，后者把原来那首原样接回来，不然 外部播放器 辅助进程重启一次就跳歌。
      const ended = next.active && this.previousStatus === "Playing" && next.playbackStatus === "Stopped" && !this.stopRequested;
      const alternatePlaying = this.alternateTrack && this.state.playbackStatus === "Playing";
      const lost = !next.active && !this.stopRequested && Boolean(web?.trackId) && web?.trackId === this.lastWebTrackId
        && (web.playbackStatus === "Playing" || this.playRequested || alternatePlaying);
      this.state = next;
      this.previousStatus = next.playbackStatus;
      if (ended && next.trackId) {
        const handled = await this.command({ action: "next" });
        if (!this.isCurrent(generation)) return;
        if (handled) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
      } else if (lost && web) {
        await this.loadFromWeb(web, this.shouldAutoplay(web) || alternatePlaying, generation);
        if (!this.isCurrent(generation)) return;
      }
      if (next.playbackStatus === "Playing") this.playRequested = false;
      // 过渡计划里带原因：分析回退时把「为什么没混音」放进状态里，随时可见。
      const liveNote = transitionNote(payload.transition);
      const label = payload.transitioning ? liveNote || this.transitionCommit?.note || "" : liveNote;
      this.status = label ? `${this.options.name} 已连接（${label}${payload.transitioning ? "中" : ""}）` : `${this.options.name} 已连接`;
      // 外部播放器 是唯一的音频出口：它停了页面就必须停，否则页面会静音地把整首歌播完再自动
      // 切歌，新歌又会把暂停中的 外部播放器 拉起来。切歌过渡期（pendingAutoplay）不许按停。
      await tryEvaluateInPlayer(externalSyncScript(next.playbackStatus === "Playing", this.pendingAutoplay === 0, this.alternateTrack), { userGesture: true });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      console.warn(`[NEMusic] ${this.options.name} bridge`, error);
      this.status = error instanceof Error ? `${this.options.name} 连接失败：${error.message}` : `${this.options.name} 连接失败`;
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
      if (generation !== this.generation && this.timer) void this.tick();
    }
  }

  /** 页面状态自己会撒谎（切歌的瞬间可能还挂着旧的 Paused），外部播放器 的状态才是准的。 */
  private shouldAutoplay(web: TrackState): boolean {
    return !this.pauseRequested && (this.pendingAutoplay > 0
      || this.playRequested
      || (web.playbackStatus === "Playing" && this.state.playbackStatus !== "Paused"));
  }

  private invalidateTransition(): void {
    if (this.transitionKey || this.transitionPrepared || this.transitionPreparing) this.transitionNeedsClear = true;
    this.transitionKey = "";
    this.transitionPrepared = null;
    this.transitionCommit = null;
  }

  /** 解析和网络缓冲放在独立任务里，暂停/切歌不必等预加载结束。 */
  private async updateTransition(web: TrackState | null, payload: ExternalAudioPayload, generation: number): Promise<boolean> {
    if (!this.options.transition) return false;
    const settings = this.options.transition();
    if (this.transitionCommit) {
      // 等网页切歌的阶段：只观察，不撤销、不重新准备。网页慢只是慢，
      // 最终会切到同一首（点过下一首，或播完旧歌自然到达）。
      if (settings.mode !== "off" && !this.stopRequested) {
        await this.advanceTransitionCommit(generation);
        return true;
      }
      // 用户关掉了过渡：落回下面的取消路径。
      this.transitionCommit = null;
    }
    const context = settings.mode !== "off" && !this.stopRequested
      ? await tryEvaluateInPlayer(TRANSITION_CANDIDATE_SCRIPT) as (TransitionCandidate & { blocked?: boolean }) | null : null;
    const candidate = context?.blocked ? null : context;
    if (!this.isCurrent(generation)) return false;
    const valid = candidate?.song?.id && candidate.from === web?.trackId && payload.trackId === web?.trackId
      && payload.active && web.loopStatus !== "Track" && !web.shuffle;
    const key = valid ? `${candidate.from}:${candidate.song.id}:${settings.mode}:${settings.seconds}:${settings.fallback ?? "normal"}:${this.options.quality()}` : "";
    if (key !== this.transitionKey) {
      this.invalidateTransition();
      this.transitionKey = key;
      this.transitionRetryAt = 0;
    }
    const cancelFade = settings.mode === "off" || context?.blocked === true || this.stopRequested;
    if (!this.transitionPreparing && (this.transitionNeedsClear || (cancelFade && payload.transitioning))) {
      const cleared = await this.request("/prepare", generation, { cancelFade });
      if (!this.isCurrent(generation)) return false;
      if (!cleared.ok) return false;
      this.transitionNeedsClear = false;
    }
    if (!valid || !candidate || !web) return false;
    const remaining = Math.max(0, numberOr(payload.duration, 0) - numberOr(payload.position, 0));
    if (this.transitionPrepared && !payload.transition) this.transitionPrepared = null;
    const prepared = this.transitionPrepared;
    const planned = payload.transition;
    if (!this.pauseRequested && prepared && planned?.ready && planned.from === candidate.from && planned.trackId === String(candidate.song.id)
      && payload.playbackStatus === "Playing" && web.playbackStatus === "Playing"
      && (this.alternateTrack || Math.abs(web.position - numberOr(payload.position, web.position)) <= SEEK_EPSILON)
      && remaining > 0 && planned.mode !== "none" && (planned.mode === "smart" && planned.startAt != null
        // 智能混音在拍点前就可交给后端：接管后会等真正的拍点再放声。
        ? numberOr(payload.position, 0) >= planned.startAt - 1.2 : remaining <= planned.seconds + planned.trim + 0.5)) {
      // 先让 mpv 的两路音频交接，再等待网页切歌。官网解析/渲染可能耗时数秒，
      // 等它完成才淡化会让旧歌先播完，实际听起来只剩提前硬切。
      const response = await this.request("/load", generation, {
        url: prepared.track.url, ...this.transitionMetadata(candidate, prepared.track),
        from: candidate.from, transition: true, position: 0, autoplay: true, volume: web.volume,
        transportRevision: payload.transportRevision,
      });
      if (!this.isCurrent(generation)) return true;
      if (!response.ok) { this.invalidateTransition(); return true; }
      const state = await response.json() as ExternalAudioPayload;
      if (!this.isCurrent(generation)) return true;
      if (state.transitionCancelled) { this.invalidateTransition(); return true; }
      if (!state.transitioned) { this.invalidateTransition(); return true; }
      if (this.transitionKey !== key || this.options.transition().mode === "off") {
        this.invalidateTransition();
        if (!this.stopRequested) this.lastWebTrackId = "";
        return true;
      }
      // 后端已经接管：点一次网页的下一首，之后每个 tick 只观察它切没切过来。
      // 官网解析/更新 store 可能耗时数秒，这期间撤销过渡就是硬切（旧歌被立刻
      // 掐掉、新歌顶满音量）；网页迟迟不动时也会播完旧歌自然切到同一首，等它就行。
      this.transitionCommit = { candidate, key, alternate: prepared.track.source === "unblock",
        smart: planned.mode === "smart", note: transitionNote(planned) || "普通过渡",
        until: Date.now() + TRANSITION_COMMIT_WINDOW, clicked: false };
      await this.advanceTransitionCommit(generation);
      return true;
    }
    if (!prepared && !this.transitionPreparing && !this.transitionNeedsClear && Date.now() >= this.transitionRetryAt
      && remaining > settings.seconds + 2 && remaining / numberOr(payload.rate, 1) <= (settings.mode === "smart" ? 90 : 45) && payload.playbackStatus === "Playing") {
      const task = this.prepareTransition(candidate, key, settings.seconds, settings.mode, settings.fallback ?? "normal", generation);
      this.transitionPreparing = task;
      void task.finally(() => { if (this.transitionPreparing === task) this.transitionPreparing = null; });
    }
    return false;
  }

  /**
   * 等网页切歌的推进：接管后点一次网页的“下一首”，之后每个 tick 只看快照。
   * 网页切到目标才收尾；始终没切过来也不再撤销混音（撤销=硬切），
   * 放下等待状态，让网页播完旧歌自然追上。
   */
  private async advanceTransitionCommit(generation: number): Promise<boolean> {
    const pending = this.transitionCommit;
    if (!pending) return false;
    const target = String(pending.candidate.song.id);
    let current = await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true }) as TrackState | null;
    if (!this.isCurrent(generation)) return false;
    if (!pending.clicked) {
      pending.clicked = true;
      const committed = await tryEvaluateInPlayer(transitionCommitScript(pending.candidate), { userGesture: true, awaitPromise: true });
      if (!this.isCurrent(generation)) return false;
      if (committed === true) {
        current = await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true }) as TrackState | null;
        if (!this.isCurrent(generation)) return false;
      }
    }
    if (current?.trackId === target) return await this.finishTransitionCommit(pending, current, generation);
    if (Date.now() >= pending.until) {
      // 网页始终没切过去（点击落空或页面卡住）：只放下等待状态，绝不发 cancelFade。
      // 网页一旦播完旧歌就会自然切到同一首，靠时钟保护把进度对齐回来。
      this.transitionCommit = null;
      this.transitionKey = "";
      this.transitionPrepared = null;
      this.transitionNeedsClear = false;
      this.transitionClockTrack = target;
      this.transitionClockUntil = Date.now() + 40000;
    }
    return false;
  }

  /** 网页已经切到混音目标：收尾对账（刷新状态、时钟保护、清等待标记）。 */
  private async finishTransitionCommit(pending: { candidate: TransitionCandidate; key: string; alternate: boolean; smart: boolean; note: string },
    current: TrackState, generation: number): Promise<boolean> {
    if (this.transitionKey !== pending.key || this.options.transition().mode === "off") {
      this.invalidateTransition();
      if (!this.stopRequested) this.lastWebTrackId = "";
      return true;
    }
    // 等网页期间可能已暂停或停止，不能用接管那一刻的 Playing 覆盖新状态。
    const latestResponse = await this.request("/state", generation);
    if (!this.isCurrent(generation)) return true;
    if (!latestResponse.ok) throw new Error(`${this.options.name} state failed: ${latestResponse.status}`);
    const latest = await latestResponse.json() as ExternalAudioPayload;
    if (!this.isCurrent(generation)) return true;
    this.transitionCommit = null;
    this.state = this.normalize(latest, current);
    this.lastWebTrackId = current.trackId;
    this.previousStatus = this.state.playbackStatus;
    this.alternateTrack = pending.alternate;
    this.pendingAutoplay = 0;
    this.status = `${this.options.name} 已连接（${pending.note}中）`;
    this.transitionKey = "";
    this.transitionPrepared = null;
    this.transitionClockTrack = current.trackId;
    this.transitionClockUntil = Date.now() + 40000;
    return true;
  }

  private transitionMetadata(candidate: TransitionCandidate, track: DownloadTrack): Record<string, string> {
    return { trackId: String(candidate.song.id), title: track.name || candidate.song.name,
      artist: track.artist || candidate.song.artist, album: track.album || candidate.song.album || "",
      artUrl: track.cover || candidate.song.cover || "" };
  }

  private async prepareTransition(candidate: TransitionCandidate, key: string, seconds: number, mode: "off" | "normal" | "smart",
    fallback: "normal" | "none" | "force", generation: number): Promise<void> {
    try {
      const track = this.options.resolveNextTrack
        ? await this.options.resolveNextTrack(this.options.quality(), candidate.song, this.requests?.signal)
        : await tryEvaluateInPlayer(downloadScript(this.options.quality(), candidate.song), { awaitPromise: true }) as DownloadTrack;
      if (!this.isCurrent(generation) || this.transitionKey !== key) return;
      if (!track?.url || track.trial) { this.transitionRetryAt = Date.now() + 10000; return; }
      const response = await this.request("/prepare", generation, {
        url: track.url, ...this.transitionMetadata(candidate, track), from: candidate.from, seconds, mode, fallback,
      });
      if (!this.isCurrent(generation) || this.transitionKey !== key) return;
      const result = await response.json() as { prepared?: boolean };
      if (!this.isCurrent(generation) || this.transitionKey !== key) return;
      if (response.ok && result.prepared === true) this.transitionPrepared = { track };
      else this.transitionRetryAt = Date.now() + 10000;
    } catch (error) {
      if (this.isCurrent(generation) && this.transitionKey === key) {
        this.transitionRetryAt = Date.now() + 10000;
        console.warn("[NEMusic] mpv transition preparation", error);
      }
    }
  }

  private async loadFromWeb(web: TrackState, autoplay: boolean, generation: number): Promise<void> {
    this.invalidateTransition();
    this.transitionClockTrack = "";
    const transportEpoch = this.transportEpoch;
    if (this.options.holdWebDuringResolution?.()) {
      await tryEvaluateInPlayer(externalSyncScript(false, true), { userGesture: true });
      if (!this.isCurrent(generation)) return;
    }
    const result = this.options.resolveTrack
      ? await this.options.resolveTrack(this.options.quality(), this.requests?.signal)
      : await tryEvaluateInPlayer(downloadScript(this.options.quality()), { awaitPromise: true });
    if (!this.isCurrent(generation)) return;
    const track = result as DownloadTrack | null;
    if (!track?.url || !/^https?:/.test(track.url)) {
      throw new Error(`网易云没有返回可供 ${this.options.name} 播放的音频地址`);
    }
    if (this.options.resolveTrack) {
      const current = await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true }) as TrackState | null;
      if (!this.isCurrent(generation) || current?.trackId !== web.trackId) return;
    }
    if (transportEpoch !== this.transportEpoch && this.stopRequested) {
      this.lastWebTrackId = web.trackId;
      return;
    }
    this.alternateTrack = track.source === "unblock";
    await tryEvaluateInPlayer(EXTERNAL_MUTE_SCRIPT);
    if (!this.isCurrent(generation)) return;
    const response = await this.request("/load", generation, {
      url: track.url,
      title: track.name || web.title,
      artist: track.artist || web.artist,
      album: track.album || web.album,
      artUrl: track.cover || web.artUrl,
      trackId: web.trackId,
      position: web.position,
      autoplay: transportEpoch === this.transportEpoch ? autoplay : this.playRequested,
      // 外部播放器 的初始音量是 100%：不把网页音量带上，从网页切过来就是一声爆音。
      volume: web.volume,
    });
    if (!this.isCurrent(generation)) return;
    if (!response.ok) {
      let message = `${this.options.name} load failed: ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {}
      throw new Error(message);
    }
    this.lastWebTrackId = web.trackId;
    this.pendingAutoplay = 0;
    this.playRequested = false;
    this.pauseRequested = false;
    this.stopRequested = false;
  }

  private normalize(payload: ExternalAudioPayload, web: TrackState | null): TrackState {
    const status = payload.playbackStatus === "Playing" || payload.playbackStatus === "Paused" || payload.playbackStatus === "Stopped"
      ? payload.playbackStatus
      : "Stopped";
    return {
      ...EMPTY_STATE,
      active: payload.active === true,
      playbackStatus: status,
      title: String(payload.title ?? web?.title ?? ""),
      artist: String(payload.artist ?? web?.artist ?? ""),
      lyrics: "",
      album: String(payload.album ?? web?.album ?? ""),
      artUrl: String(payload.artUrl ?? web?.artUrl ?? ""),
      trackId: String(payload.trackId ?? web?.trackId ?? ""),
      duration: Math.max(0, numberOr(payload.duration, 0)),
      position: Math.max(0, numberOr(payload.position, 0)),
      canSeek: payload.canSeek === true,
      canGoNext: web?.canGoNext === true,
      canGoPrevious: web?.canGoPrevious === true,
      volume: payload.volume === null ? null : Math.max(0, Math.min(1, numberOr(payload.volume, 1))),
      loopStatus: payload.loopStatus === "Track" || payload.loopStatus === "Playlist" ? payload.loopStatus : "None",
      shuffle: payload.shuffle === true,
      rate: Math.max(0.1, Math.min(4, numberOr(payload.rate, 1))),
    };
  }

  private async stop(resume: boolean, restoreWeb: boolean): Promise<void> {
    const endpoint = this.endpoint;
    const token = this.token;
    // resume 由调用方在清标志之前算好：外部播放器 没了页面得自己出声，除非用户本来就是按停/
    // 暂停的——那种情况页面也一直被我们按在暂停上，接回去反而会凭空开始播。
    this.endpoint = null;
    this.token = null;
    this.lastWebTrackId = "";
    this.alternateTrack = false;
    this.invalidateTransition();
    this.transitionNeedsClear = false;
    this.transitionClockTrack = "";
    this.pendingAutoplay = 0;
    this.stopRequested = false;
    this.playRequested = false;
    this.previousStatus = "Stopped";
    this.pauseRequested = false;
    this.state = { ...EMPTY_STATE };
    if (restoreWeb) {
      try {
        await tryEvaluateInPlayer(externalUnmuteScript(resume), { userGesture: true });
      } catch {}
    }
    if (endpoint && token) {
      try {
        await fetch(`${endpoint}/shutdown`, { method: "POST", headers: { "X-NEMusic-Token": token }, keepalive: true });
      } catch {}
    }
  }
}
