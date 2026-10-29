import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { downloadScript, type DownloadTrack, type DownloadSong } from "../download/download-player.ts";
import { CROSSFADE_QUEUE_SCRIPT, crossfadeAdoptScript, crossfadeClockScript, type CrossfadeCandidate } from "./crossfade-player.ts";
import type { CrossfadeMode, TransitionMode } from "../settings.ts";
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
  "asset-pcm-mixer": "插件包缺少歌曲衔接模块",
  "write-pcm-mixer": "无法写入歌曲衔接模块",
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

function restorePcmClockScript(playing: boolean): string {
  return `
    const pcmUi = globalThis.__NEMusicOnSteamPcmUi;
    delete globalThis.__NEMusicOnSteamPcmUi;
    const pcmPlaying = pcmUi?.store?.getState()?.playing;
    if (pcmUi?.store === globalThis.__NEMusicOnSteamPlayerStore && pcmUi?.trackId
      && String(pcmPlaying?.resourceTrackId || '') === pcmUi.trackId && Number.isFinite(pcmUi.position)) {
      const position = Math.max(0, pcmUi.position - (Number(pcmPlaying.freeTrialInfo?.start) || 0));
      const howls = globalThis.Howler?._howls || [];
      for (const howl of bridge?.paused || []) {
        if (!howls.includes(howl) || typeof howl?.seek !== 'function' || howl.playing?.()) continue;
        if (!(howl._sounds || []).some(sound => sound?._node && !sound._ended)) continue;
        howl.seek(position);
      }
      if (${playing ? "false" : "true"}) pcmUi.store.dispatch({ type: 'playing/onUpdate', payload: { playingState: 1 } });
    }
  `;
}

/**
 * 放开静音；resume 为真时把被我们 pause 掉的页面声音接回去（经 Howler API，
 * 这样页面自己的状态机也一起恢复），让 外部播放器 后端关闭后网页能接着出声。
 */
function externalUnmuteScript(resume: boolean): string {
  return `(() => {
    const key = '__NEMusicOnSteamMpvMedia';
    const bridge = globalThis[key];
    ${restorePcmClockScript(resume)}
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
    ${holdWeb ? "" : restorePcmClockScript(playing)}
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
  crossfade?: () => CrossfadeMode;
  transitionMode?: () => TransitionMode;
  crossfadeSeconds?: () => number;
  preloadNext?: () => boolean;
  resolveNextTrack?: (quality: number, song: DownloadSong, signal?: AbortSignal) => Promise<DownloadTrack>;
};

type ExternalAudioPayload = Partial<TrackState> & {
  pcm?: boolean;
  streamId?: string;
  handoffId?: string;
  handoffFrom?: string;
  queuedTrackId?: string;
  error?: string;
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
  private preloadEpoch = 0;
  private preloadKey = "";
  private preloadDirty = false;
  private preloadRequest: AbortController | null = null;
  private prepareRevision = 0;
  private queuedAlternate = false;
  private handoff: { from: string; to: string } | null = null;
  private lastHandoffId = "";
  private ignoreHandoffs = false;
  private webClockPosition: number | null = null;
  private webClockTarget: number | null = null;
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
      this.clearPreload();
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
    if (command.action === "next" || command.action === "previous") {
      const autoplay = this.state.playbackStatus === "Playing" || this.pendingAutoplay > 0;
      this.handoff = null;
      this.ignoreHandoffs = true;
      this.clearPreload();
      if (this.usesPcm() && this.endpoint) {
        await this.request("/command", generation, { action: "pause" });
        if (!this.isCurrent(generation)) return false;
      }
      await tryEvaluateInPlayer(allowWebActionScript(command.action));
      if (!this.isCurrent(generation)) return false;
      const handled = await this.options.commandWeb(command);
      if (!this.isCurrent(generation)) return false;
      await tryEvaluateInPlayer(CLEAR_WEB_ACTION_SCRIPT);
      if (!this.isCurrent(generation)) return false;
      if (handled) {
        if (autoplay) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
        this.stopRequested = false;
      } else {
        this.ignoreHandoffs = false;
        if (autoplay && this.usesPcm() && this.endpoint) {
          await this.request("/command", generation, { action: "play" });
        }
      }
      return handled;
    }
    if (!this.endpoint || !this.token) return false;
    if (["seek", "setposition", "stop", "loop", "shuffle"].includes(command.action)) {
      this.clearPreload();
      this.webClockPosition = null;
      this.webClockTarget = null;
    }
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
      let earlyPayload: ExternalAudioPayload | null = null;
      if (this.usesPcm()) {
        const response = await this.request("/state", generation);
        if (!this.isCurrent(generation)) return;
        if (response.ok) earlyPayload = await response.json() as ExternalAudioPayload;
        if (!this.isCurrent(generation)) return;
        if (!this.ignoreHandoffs && earlyPayload?.handoffId && earlyPayload.handoffId !== this.lastHandoffId) {
          this.lastHandoffId = earlyPayload.handoffId;
          if (earlyPayload.handoffFrom === this.lastWebTrackId || earlyPayload.trackId === web?.trackId) {
            this.handoff = { from: earlyPayload.handoffFrom || "", to: String(earlyPayload.trackId || "") };
            this.clearPreload();
            this.alternateTrack = this.queuedAlternate;
            this.webClockPosition = null;
            this.webClockTarget = null;
            if (web?.trackId === this.handoff.from) {
              const adopted = await tryEvaluateInPlayer(crossfadeAdoptScript(this.handoff.from, this.handoff.to));
              if (!this.isCurrent(generation)) return;
              if (!adopted) {
                await this.loadFromWeb({ ...web, position: 0 }, this.shouldAutoplay(web), generation);
                return;
              }
            }
          }
        }
      }
      if (this.handoff && web?.trackId === this.handoff.to) {
        this.lastWebTrackId = web.trackId;
        this.handoff = null;
      } else if (this.handoff && web?.trackId && web.trackId !== this.handoff.from) {
        this.handoff = null;
      }
      if (!this.handoff && web?.trackId && web.trackId !== this.lastWebTrackId) {
        if (web.trackId === this.state.trackId) {
          this.lastWebTrackId = web.trackId;
        } else {
          await this.loadFromWeb(web, this.shouldAutoplay(web), generation);
          if (!this.isCurrent(generation)) return;
          earlyPayload = null;
        }
      }
      const response = earlyPayload ? null : await this.request("/state", generation);
      if (!this.isCurrent(generation)) return;
      if (response && !response.ok) {
        const failure = await response.json() as { error?: string };
        throw new Error(failure.error || `${this.options.name} state failed: ${response.status}`);
      }
      const payload = earlyPayload ?? (await response!.json()) as ExternalAudioPayload;
      if (!this.isCurrent(generation)) return;
      const next = this.normalize(payload, web);
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
      if (!payload.pcm && !this.alternateTrack && next.active && web?.canSeek && web.trackId && web.trackId === next.trackId
        && next.playbackStatus === "Playing" && web.playbackStatus === "Playing"
        && web.position > 0 && Math.abs(web.position - next.position) > SEEK_EPSILON) {
        await this.request("/command", generation, { action: "setposition", value: Math.round(web.position * 1_000_000) });
        if (!this.isCurrent(generation)) return;
        next.position = web.position;
      }
      if (payload.pcm && web?.trackId === next.trackId && web.canSeek && !this.handoff) {
        const moved = this.webClockPosition !== null && Math.abs(web.position - this.webClockPosition) > SEEK_EPSILON;
        const acknowledged = this.webClockTarget !== null && Math.abs(web.position - this.webClockTarget) <= SEEK_EPSILON;
        if (moved && !acknowledged) {
          this.clearPreload();
          await this.request("/command", generation, { action: "setposition", value: Math.round(web.position * 1_000_000) });
          if (!this.isCurrent(generation)) return;
          next.position = web.position;
        }
        this.webClockPosition = web.position;
      }
      // 播完和掉轨是两回事：播完时 path 还在，掉轨时辅助进程连 path 都没有了。
      // 前者往下一首走，后者把原来那首原样接回来，不然 外部播放器 辅助进程重启一次就跳歌。
      const ended = next.active && this.previousStatus === "Playing" && next.playbackStatus === "Stopped" && !this.stopRequested && !this.handoff;
      const alternatePlaying = this.alternateTrack && this.state.playbackStatus === "Playing";
      const lost = !next.active && !this.stopRequested && Boolean(web?.trackId) && web?.trackId === this.lastWebTrackId
        && (web.playbackStatus === "Playing" || this.playRequested || alternatePlaying);
      this.state = next;
      this.previousStatus = next.playbackStatus;
      if (payload.pcm && !this.handoff && !this.stopRequested) {
        await this.updatePreload(next, generation, payload.streamId || "");
        if (!this.isCurrent(generation)) return;
      }
      if (ended && next.trackId) {
        const handled = await this.command({ action: "next" });
        if (!this.isCurrent(generation)) return;
        if (handled) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
      } else if (lost && web) {
        await this.loadFromWeb(web, this.shouldAutoplay(web) || alternatePlaying, generation);
        if (!this.isCurrent(generation)) return;
      }
      if (next.playbackStatus === "Playing") this.playRequested = false;
      this.status = payload.error ? `${this.options.name}：${payload.error}`
        : this.handoff ? `${this.options.name} 已衔接，等待网页切歌` : `${this.options.name} 已连接`;
      // 外部播放器 是唯一的音频出口：它停了页面就必须停，否则页面会静音地把整首歌播完再自动
      // 切歌，新歌又会把暂停中的 外部播放器 拉起来。切歌过渡期（pendingAutoplay）不许按停。
      await tryEvaluateInPlayer(externalSyncScript(next.playbackStatus === "Playing", this.pendingAutoplay === 0,
        this.alternateTrack || payload.pcm === true), { userGesture: true });
      if (!this.isCurrent(generation)) return;
      if (payload.pcm && web?.trackId === next.trackId && !this.handoff) {
        const updated = await tryEvaluateInPlayer(crossfadeClockScript(next.trackId, next.position,
          next.playbackStatus === "Playing"), { awaitPromise: true });
        if (!this.isCurrent(generation)) return;
        if (updated === true) this.webClockTarget = next.position;
      }
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

  private usesPcm(): boolean {
    return Boolean(this.options.preloadNext?.() || (this.options.crossfade?.() && this.options.crossfade() !== "off"));
  }

  private async loadFromWeb(web: TrackState, autoplay: boolean, generation: number): Promise<void> {
    this.clearPreload();
    this.handoff = null;
    this.webClockPosition = null;
    this.webClockTarget = null;
    const transportEpoch = this.transportEpoch;
    let crossfade: CrossfadeMode = this.options.transitionMode?.() === "none" ? "off" : this.options.crossfade?.() ?? "off";
    let preloadNext = this.options.preloadNext?.() === true;
    if (crossfade !== "off" || preloadNext) {
      const queue = await tryEvaluateInPlayer(CROSSFADE_QUEUE_SCRIPT) as CrossfadeCandidate | null;
      if (!this.isCurrent(generation)) return;
      if (!queue?.eligible || web.loopStatus === "Track" || web.shuffle) { crossfade = "off"; preloadNext = false; }
    }
    if (this.options.holdWebDuringResolution?.() || crossfade !== "off" || preloadNext) {
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
      duration: web.duration,
      loopStatus: web.loopStatus,
      crossfade: track.trial ? "off" : crossfade,
      transitionMode: crossfade === "off" ? "none" : this.options.transitionMode?.() ?? "auto",
      crossfadeSeconds: this.options.crossfadeSeconds?.(),
      preloadNext: !track.trial && preloadNext,
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
    this.ignoreHandoffs = false;
  }

  private clearPreload(): void {
    this.preloadEpoch++;
    this.preloadRequest?.abort();
    this.preloadRequest = null;
    this.preloadKey = "";
    this.preloadDirty = true;
  }

  private async updatePreload(state: TrackState, generation: number, streamId: string): Promise<void> {
    const candidate = await tryEvaluateInPlayer(CROSSFADE_QUEUE_SCRIPT) as CrossfadeCandidate | null;
    if (!this.isCurrent(generation)) return;
    if (candidate && !candidate.eligible) {
      const web = await tryEvaluateInPlayer(SNAPSHOT_SCRIPT) as TrackState | null;
      if (this.isCurrent(generation) && web?.trackId === state.trackId) {
        await this.loadFromWeb({ ...web, position: state.position }, state.playbackStatus === "Playing", generation);
      }
      return;
    }
    const ahead = Math.max(45, (this.options.crossfadeSeconds?.() ?? 0) * state.rate + 10);
    const song = candidate?.eligible && candidate.from === state.trackId && state.duration > 0
      && state.duration - state.position <= ahead && !state.shuffle && state.loopStatus !== "Track" ? candidate.song : null;
    const key = song ? `${streamId}:${state.trackId}:${song.id}` : "";
    if (key === this.preloadKey && !this.preloadDirty) return;
    this.clearPreload();
    this.preloadKey = key;
    const epoch = this.preloadEpoch;
    const revision = ++this.prepareRevision;
    const cancelled = await this.request("/prepare", generation, { fromTrackId: state.trackId, revision, streamId });
    if (!this.isCurrent(generation) || epoch !== this.preloadEpoch) return;
    if (!cancelled.ok) throw new Error("无法更新歌曲衔接队列");
    const result = await cancelled.json() as { accepted?: boolean; streamId?: string };
    if (!this.isCurrent(generation) || epoch !== this.preloadEpoch) return;
    if (!result.accepted) return;
    streamId = result.streamId || streamId;
    this.preloadKey = song ? `${streamId}:${state.trackId}:${song.id}` : "";
    this.preloadDirty = false;
    if (!song || !this.options.resolveNextTrack || this.stopRequested) return;
    const controller = new AbortController();
    this.preloadRequest = controller;
    void (async () => {
      const track = await this.options.resolveNextTrack!(this.options.quality(), song, controller.signal);
      if (!this.isCurrent(generation) || epoch !== this.preloadEpoch || controller.signal.aborted) return;
      const current = await tryEvaluateInPlayer(CROSSFADE_QUEUE_SCRIPT) as CrossfadeCandidate | null;
      if (!this.isCurrent(generation) || epoch !== this.preloadEpoch || !current?.eligible
        || current.from !== state.trackId || current.song?.id !== song.id || track.trial) return;
      const response = await this.request("/prepare", generation, {
        fromTrackId: state.trackId, revision: ++this.prepareRevision, streamId,
        trackId: String(song.id), url: track.url, title: track.name || song.name,
        artist: track.artist || song.artist, album: track.album || song.album, artUrl: track.cover || song.cover,
        duration: song.duration, crossfade: this.options.crossfade?.(),
        transitionMode: this.options.transitionMode?.() ?? "auto",
        crossfadeSeconds: this.options.crossfadeSeconds?.(),
        preloadNext: this.options.preloadNext?.() === true,
      });
      if (!this.isCurrent(generation) || epoch !== this.preloadEpoch) return;
      if (!response.ok) throw new Error("下一首预加载失败");
      this.queuedAlternate = track.source === "unblock";
    })().catch(error => {
      if (this.isCurrent(generation) && epoch === this.preloadEpoch && !controller.signal.aborted) {
        console.warn("[NEMusic] crossfade preload", error);
      }
    });
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
    this.clearPreload();
    this.handoff = null;
    this.lastHandoffId = "";
    this.ignoreHandoffs = false;
    this.webClockPosition = null;
    this.webClockTarget = null;
    this.alternateTrack = false;
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
