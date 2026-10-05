import { ffi } from "millennium";
import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { SNAPSHOT_SCRIPT } from "../player/player-access.ts";
import { downloadScript, type DownloadTrack } from "../download/download-player.ts";
import type { PlaybackBackend } from "../settings.ts";
import type { Command } from "./mpris-player.ts";
import type { ExternalPlayback, TrackState } from "./mpris.ts";

const getEndpoint = ffi<[], string>("mpv_endpoint");

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
  retry: "mpv 辅助进程启动失败，正在重试",
  "asset-helper": "插件包缺少 backend/mpv_helper.py",
  "write-helper": "无法写入 mpv 辅助进程脚本",
  "write-token": "无法写入 mpv 辅助进程令牌",
  spawn: "mpv 辅助进程启动后没有监听端口",
};

/**
 * 网易云的音乐是 Howler 用 html5 模式播的，真实的 <audio> 是 Howler 从自己的对象池里
 * 拿的游离节点，从来不进 DOM，所以光扫 document.querySelector('audio, video') 一只
 * 也找不到，网页和 mpv 就会一起出声。这里同时沿 Howler._howls -> _sounds -> _node 走
 * 一遍、装上 HTMLMediaElement.prototype.play 钩子把之后新建的节点挡在出声之前，
 * 并给每个节点挂 volumechange 监听防止 Howler 又把音量调回来。
 * 只静音、绝不 pause：页面一旦被 pause，它的 ended 事件就不会来，歌就不会自己往下走。
 */
const MPV_MUTE_SCRIPT = `(() => {
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
 * 这样页面自己的状态机也一起恢复），让 mpv 后端关闭后网页能接着出声。
 */
function mpvUnmuteScript(resume: boolean): string {
  return `(() => {
    const key = '__NEMusicOnSteamMpvMedia';
    const bridge = globalThis[key];
    if (bridge) bridge.active = false;
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
 * mpv 是唯一的音频出口，页面只是播放列表和状态源：mpv 在播就把页面接回去，
 * mpv 暂停/停止就把页面 pause 掉，否则页面会静音地把整首歌播完并自动切歌，
 * 新歌一进 loadFromWeb 就又把暂停中的 mpv 拉起来。只能经 Howler 的 API 动手，
 * howler 没有给 audio 节点绑 play/pause 事件，直接戳节点页面根本不知道。
 * allowPause 为假表示正处在切歌过渡里，此时页面必须保持播放，不然歌会断。
 */
function mpvSyncScript(playing: boolean, allowPause: boolean): string {
  return `(() => {
    const howler = globalThis.Howler;
    const bridge = globalThis.__NEMusicOnSteamMpvMedia;
    if (!howler || !howler._howls || !bridge) return 0;
    if (!bridge.paused || typeof bridge.paused.clear !== 'function') bridge.paused = new Set();
    const resumable = howl => (howl._sounds || []).some(sound => sound && sound._node && !sound._ended);
    let touched = 0;
    for (const howl of howler._howls) {
      if (!howl || typeof howl.playing !== 'function') continue;
      if (${playing ? "true" : "false"}) {
        if (howl.playing() || !resumable(howl) || typeof howl.play !== 'function') continue;
        howl.play();
        bridge.paused.delete(howl);
        touched++;
      } else if (${allowPause ? "true" : "false"}) {
        if (!howl.playing()) continue;
        howl.pause();
        bridge.paused.add(howl);
        touched++;
      }
    }
    return touched;
  })()`;
}

const MPV_CONTROL_INSTALL_SCRIPT = `(() => {
  const key = '__NEMusicOnSteamMpvControls';
  const existing = globalThis[key];
  const bridge = existing || { actions: [] };
  if (!bridge.installed) {
    bridge.installed = true;
    document.addEventListener('click', event => {
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
    }, true);
  }
  // 音量不走 DOM 监听：滑块是 div[role=slider]，拖动时不派发 input/change；
  // tick 拿快照里的网页音量跟 mpv 对账（网页 store 才是音量的唯一来源）。
  globalThis[key] = bridge;
  return true;
})()`;

const MPV_CONTROL_POLL_SCRIPT = `(() => {
  const bridge = globalThis.__NEMusicOnSteamMpvControls;
  if (!bridge || !Array.isArray(bridge.actions)) return { actions: [] };
  return { actions: bridge.actions.splice(0, bridge.actions.length) };
})()`;

function allowWebActionScript(action: string): string {
  return `(() => { const bridge = globalThis.__NEMusicOnSteamMpvControls; if (bridge) bridge.allowAction = ${JSON.stringify(action)}; return true; })()`;
}

const CLEAR_WEB_ACTION_SCRIPT = `(() => { const bridge = globalThis.__NEMusicOnSteamMpvControls; if (bridge) bridge.allowAction = ''; return true; })()`;

function describeFailure(result: string): string {
  const match = /^!([a-z-]+)(?::(.*))?$/.exec(result);
  const code = match?.[1] ?? "";
  const detail = match?.[2] ?? "";
  if (code === "mkdir") return `mpv 不可用：无法创建运行目录 ${detail}`;
  const reason = FAILURE_REASONS[code];
  if (reason) return `mpv 不可用：${reason}${detail ? `（${detail}）` : ""}`;
  return "mpv 不可用；请检查是否安装了 mpv";
}

type MpvOptions = {
  quality: () => number;
  commandWeb: (command: Command) => Promise<boolean>;
};

type MpvPayload = Partial<TrackState> & { url?: string; autoplay?: boolean; position?: number };

// 切歌（MPRIS 的上一首/下一首、播完自动切歌）到新歌真的喂进 mpv 之间有一段窗口，
// 窗口里 mpv 还是 Stopped、页面也可能正 Paused；这个标记让 loadFromWeb 一定要 autoplay、
// 并让 sync 别把正在切歌的页面按住。用 tick 预算而不是布尔，否则一次没有生效的切歌
// （原地重播、播放列表到底）会让它永久挂着，mpv 暂停之后页面又自己切歌把它带起来。
const PENDING_AUTOPLAY_TICKS = 12;

// mpv 的 volume 是 0..100、网页 store 是 0..1，来回取整会有抖动，差一个百分点才算数。
const VOLUME_EPSILON = 0.01;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class MpvBridge implements ExternalPlayback {
  private timer = 0;
  private busy = false;
  private enabled = false;
  private endpoint: string | null = null;
  private token: string | null = null;
  private state: TrackState = { ...EMPTY_STATE };
  private status = "尚未连接";
  private previousStatus: TrackState["playbackStatus"] = "Stopped";
  /** 用户要求过 stop：粘性标志，挡掉 mpv 掉轨之后的自动重载和自动切歌。 */
  private stopRequested = false;
  /** 用户要求过 play：mpv 手里没歌时用来把它重新拉起来。 */
  private playRequested = false;
  private lastWebTrackId = "";
  private pendingAutoplay = 0;
  private readonly options: MpvOptions;

  constructor(options: MpvOptions) {
    this.options = options;
  }

  start(): void {
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 mpv 后端";
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // 用户按停的意图要活到关后端这一刻：resume 得赶在清标志之前算出来，
      // 否则 stop() 会以为页面该被接回去，凭空把用户停掉的歌放出来。
      const resume = !this.stopRequested && this.state.playbackStatus !== "Paused";
      this.stopRequested = false;
      this.playRequested = false;
      this.pendingAutoplay = 0;
      window.clearInterval(this.timer);
      this.timer = 0;
      void this.stop(resume);
      return;
    }
    this.stopRequested = false;
    this.playRequested = false;
    this.pendingAutoplay = 0;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 mpv 后端";
      return;
    }
    this.timer = window.setInterval((): void => void this.tick(), 500);
    void this.tick();
  }

  getStatus(): string {
    return this.status;
  }

  snapshot(): TrackState {
    return { ...this.state };
  }

  async command(command: Command): Promise<boolean> {
    if (command.action === "next" || command.action === "previous") {
      const autoplay = this.state.playbackStatus === "Playing" || this.pendingAutoplay > 0;
      await tryEvaluateInPlayer(allowWebActionScript(command.action));
      const handled = await this.options.commandWeb(command);
      await tryEvaluateInPlayer(CLEAR_WEB_ACTION_SCRIPT);
      if (handled) {
        if (autoplay) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
        this.stopRequested = false;
      }
      return handled;
    }
    if (!this.endpoint || !this.token) return false;
    if (command.action === "volume") {
      // 网页 store 是音量的唯一来源：媒体键调的是 mpv，得同时写回网页，
      // 否则下个 tick 的对账会把 mpv 又改回网页里的旧音量。
      await this.options.commandWeb(command);
    }
    // mpv 的播放状态是权威，这些标志要在 /command 之前落好：请求失败时下个 tick 还会照着
    // 它们重试，而播放类命令失败的唯一常见原因就是 mpv 手里已经没歌了。
    if (command.action === "stop") {
      this.stopRequested = true;
      this.playRequested = false;
      this.pendingAutoplay = 0;
    } else if (command.action === "pause") {
      this.playRequested = false;
    } else if (command.action === "play") {
      this.stopRequested = false;
      this.playRequested = true;
    } else if (command.action === "playpause") {
      if (this.state.playbackStatus === "Playing") this.playRequested = false;
      else {
        this.stopRequested = false;
        this.playRequested = true;
      }
    }
    const response = await this.request("/command", command);
    const payload = (await response.json()) as { handled?: boolean };
    const handled = response.ok && payload.handled === true;
    if (handled && ["rate", "shuffle", "loop", "seek", "setposition"].includes(command.action)) {
      await this.options.commandWeb(command);
    }
    return handled;
  }

  private async connect(): Promise<boolean> {
    if (this.endpoint && this.token) return true;
    const result = await getEndpoint();
    if (!this.timer) return false;
    const separator = result.lastIndexOf("|");
    if (separator < 0) {
      this.status = describeFailure(result);
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    this.status = "mpv 已连接";
    return true;
  }

  private async request(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: body == null ? "GET" : "POST",
      headers: { "X-NEMusic-Token": this.token!, ...(body == null ? {} : { "Content-Type": "application/json" }) },
      body: body == null ? undefined : JSON.stringify(body),
    });
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      if (this.pendingAutoplay > 0) this.pendingAutoplay--;
      if (!(await this.connect())) return;
      await tryEvaluateInPlayer(MPV_CONTROL_INSTALL_SCRIPT);
      const actions = (await tryEvaluateInPlayer(MPV_CONTROL_POLL_SCRIPT)) as unknown;
      const queued = Array.isArray(actions) ? actions : (actions as { actions?: unknown } | null)?.actions;
      if (Array.isArray(queued)) {
        for (const action of queued) {
          if (action === "next" || action === "previous" || action === "playpause") await this.command({ action });
        }
      }
      // 先静音再读快照：新一首歌的游离 audio 可能这一 tick 才被 Howler 拿出来。
      await tryEvaluateInPlayer(MPV_MUTE_SCRIPT);
      const web = (await tryEvaluateInPlayer(SNAPSHOT_SCRIPT, { awaitPromise: true })) as TrackState | null;
      if (web?.trackId && web.trackId !== this.lastWebTrackId) {
        await this.loadFromWeb(web, this.shouldAutoplay(web));
      }
      const response = await this.request("/state");
      if (!response.ok) throw new Error(`mpv state failed: ${response.status}`);
      const payload = (await response.json()) as MpvPayload;
      const next = this.normalize(payload, web);
      // 网页 store 是音量的唯一来源（网页滑块和媒体键最后都落到它），mpv 只跟着走：
      // 拖滑块时网页那边的 div[role=slider] 不派发事件，只能靠这里的对账把音量送过去。
      if (next.active && web?.volume != null && Math.abs(web.volume - next.volume) > VOLUME_EPSILON) {
        await this.request("/command", { action: "volume", value: web.volume });
        next.volume = web.volume;
      }
      // 播完和掉轨是两回事：播完时 path 还在，掉轨时辅助进程连 path 都没有了。
      // 前者往下一首走，后者把原来那首原样接回来，不然 mpv 辅助进程重启一次就跳歌。
      const ended = next.active && this.previousStatus === "Playing" && next.playbackStatus === "Stopped" && !this.stopRequested;
      const lost = !next.active && !this.stopRequested && Boolean(web?.trackId) && web?.trackId === this.lastWebTrackId
        && (web.playbackStatus === "Playing" || this.playRequested);
      this.state = next;
      this.previousStatus = next.playbackStatus;
      if (ended && next.trackId) {
        if (await this.command({ action: "next" })) this.pendingAutoplay = PENDING_AUTOPLAY_TICKS;
      } else if (lost && web) {
        await this.loadFromWeb(web, this.shouldAutoplay(web));
      }
      if (next.playbackStatus === "Playing") this.playRequested = false;
      this.status = "mpv 已连接";
      // mpv 是唯一的音频出口：它停了页面就必须停，否则页面会静音地把整首歌播完再自动
      // 切歌，新歌又会把暂停中的 mpv 拉起来。切歌过渡期（pendingAutoplay）不许按停。
      await tryEvaluateInPlayer(mpvSyncScript(next.playbackStatus === "Playing", this.pendingAutoplay === 0), { userGesture: true });
    } catch (error) {
      console.warn("[NEMusic] mpv bridge", error);
      this.status = error instanceof Error ? `mpv 连接失败：${error.message}` : "mpv 连接失败";
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
    }
  }

  /** 页面状态自己会撒谎（切歌的瞬间可能还挂着旧的 Paused），mpv 的状态才是准的。 */
  private shouldAutoplay(web: TrackState): boolean {
    return this.pendingAutoplay > 0
      || this.playRequested
      || (web.playbackStatus === "Playing" && this.state.playbackStatus !== "Paused");
  }

  private async loadFromWeb(web: TrackState, autoplay: boolean): Promise<void> {
    const result = await tryEvaluateInPlayer(downloadScript(this.options.quality()), { awaitPromise: true });
    const track = result as DownloadTrack | null;
    if (!track?.url || !/^https?:/.test(track.url)) {
      throw new Error("网易云没有返回可供 mpv 播放的音频地址");
    }
    await tryEvaluateInPlayer(MPV_MUTE_SCRIPT);
    const response = await this.request("/load", {
      url: track.url,
      title: track.name || web.title,
      artist: track.artist || web.artist,
      album: track.album || web.album,
      artUrl: track.cover || web.artUrl,
      trackId: web.trackId,
      position: web.position,
      autoplay,
      // mpv 的初始音量是 100%：不把网页音量带上，从网页切过来就是一声爆音。
      volume: web.volume,
    });
    if (!response.ok) {
      let message = `mpv load failed: ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {}
      throw new Error(message);
    }
    this.lastWebTrackId = web.trackId;
    this.pendingAutoplay = 0;
    this.playRequested = false;
    this.stopRequested = false;
  }

  private normalize(payload: MpvPayload, web: TrackState | null): TrackState {
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
      volume: Math.max(0, Math.min(1, numberOr(payload.volume, 1))),
      loopStatus: payload.loopStatus === "Track" || payload.loopStatus === "Playlist" ? payload.loopStatus : "None",
      shuffle: payload.shuffle === true,
      rate: Math.max(0.1, Math.min(4, numberOr(payload.rate, 1))),
    };
  }

  private async stop(resume: boolean): Promise<void> {
    const endpoint = this.endpoint;
    const token = this.token;
    // resume 由调用方在清标志之前算好：mpv 没了页面得自己出声，除非用户本来就是按停/
    // 暂停的——那种情况页面也一直被我们按在暂停上，接回去反而会凭空开始播。
    this.endpoint = null;
    this.token = null;
    this.lastWebTrackId = "";
    this.pendingAutoplay = 0;
    this.stopRequested = false;
    this.playRequested = false;
    this.previousStatus = "Stopped";
    this.state = { ...EMPTY_STATE };
    try {
      await tryEvaluateInPlayer(mpvUnmuteScript(resume), { userGesture: true });
    } catch {}
    if (endpoint && token) {
      try {
        await fetch(`${endpoint}/shutdown`, { method: "POST", headers: { "X-NEMusic-Token": token } });
      } catch {}
    }
  }
}

export function playbackBackendLabel(value: PlaybackBackend): string {
  return value === "mpv" ? "mpv" : "内嵌网页播放器";
}
