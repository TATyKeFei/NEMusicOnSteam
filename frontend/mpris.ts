import { ChromeDevToolsProtocol, ffi } from "millennium";
import { isPlayerDocument } from "./constants.ts";

type TrackState = {
  active: boolean;
  playbackStatus: "Playing" | "Paused" | "Stopped";
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  trackId: string;
  duration: number;
  position: number;
  canSeek: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
};

type Command = { action: string; value?: number };

const getEndpoint = ffi<[], string>("mpris_endpoint");
const EMPTY_STATE: TrackState = {
  active: false,
  playbackStatus: "Stopped",
  title: "",
  artist: "",
  album: "",
  artUrl: "",
  trackId: "",
  duration: 0,
  position: 0,
  canSeek: false,
  canGoNext: false,
  canGoPrevious: false,
};

const SNAPSHOT_SCRIPT = `(() => {
  const media = document.querySelector('audio, video');
  const metadata = navigator.mediaSession?.metadata;
  const title = metadata?.title || document.querySelector('[class*="song-name"], [class*="songName"], [class*="SongName"]')?.textContent?.trim() || '';
  const artist = metadata?.artist || document.querySelector('[class*="artist-name"], [class*="artistName"]')?.textContent?.trim() || '';
  const album = metadata?.album || '';
  const artUrl = metadata?.artwork?.at(-1)?.src || '';
  const duration = Number.isFinite(media?.duration) ? media.duration : 0;
  const position = Number.isFinite(media?.currentTime) ? media.currentTime : 0;
  const controls = Array.from(document.querySelectorAll('button, [role="button"], [class*="next"], [class*="prev"]')).map(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.className].filter(value => typeof value === 'string').join(' ').toLowerCase());
  return { active: true, playbackStatus: media ? (media.paused ? 'Paused' : 'Playing') : navigator.mediaSession?.playbackState === 'playing' ? 'Playing' : 'Stopped', title, artist, album, artUrl, trackId: [title, artist, album].join('|'), duration, position, canSeek: !!media && Number.isFinite(media.duration) && media.duration > 0, canGoNext: controls.some(label => /下一首|下一曲|next/.test(label)), canGoPrevious: controls.some(label => /上一首|上一曲|prev/.test(label)) };
})()`;

function commandScript(command: Command): string {
  return `(() => {
    const command = ${JSON.stringify(command)};
    const media = document.querySelector('audio, video');
    const button = (words) => Array.from(document.querySelectorAll('button, [role="button"], [class*="next"], [class*="prev"]')).find(element => {
      const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.className].filter(value => typeof value === 'string').join(' ').toLowerCase();
      return words.some(word => label.includes(word));
    });
    const click = words => { const element = button(words); if (element) element.click(); return !!element; };
    switch (command.action) {
      case 'play': if (media) { media.play(); return true; } return click(['播放', 'play']);
      case 'pause': if (media) { media.pause(); return true; } return click(['暂停', 'pause']);
      case 'playpause': if (media) { if (media.paused) media.play(); else media.pause(); return true; } return click(['播放', '暂停', 'play', 'pause']);
      case 'stop': if (media) { media.pause(); media.currentTime = 0; return true; } return false;
      case 'next': return click(['下一首', '下一曲', 'next']);
      case 'previous': return click(['上一首', '上一曲', 'previous', 'prev']);
      case 'seek': if (media && Number.isFinite(media.duration)) { media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + command.value / 1000000)); return true; } return false;
      case 'setposition': if (media && Number.isFinite(media.duration)) { media.currentTime = Math.max(0, Math.min(media.duration, command.value / 1000000)); return true; } return false;
    }
    return false;
  })()`;
}

export class MprisBridge {
  private timer = 0;
  private busy = false;
  private enabled = false;
  private endpoint: string | null = null;
  private token: string | null = null;
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private state: TrackState = EMPTY_STATE;
  private status = "尚未连接";

  constructor(private readonly open: () => void, private readonly close: () => void) {}

  start(): void {
    if (this.timer) return;
    if (!/Linux/i.test(navigator.platform)) {
      this.status = "仅 Linux 支持 MPRIS";
      return;
    }
    this.timer = window.setInterval(() => void this.tick(), 1200);
    void this.tick();
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    this.timer = 0;
    const endpoint = this.endpoint;
    const token = this.token;
    this.endpoint = null;
    this.token = null;
    await this.detach();
    if (endpoint && token) {
      try {
        await fetch(`${endpoint}/shutdown`, { method: "POST", headers: { "X-NEMusic-Token": token } });
      } catch {}
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getStatus(): string {
    return this.status;
  }

  private async connect(): Promise<boolean> {
    if (this.endpoint && this.token) return true;
    const result = await getEndpoint();
    const separator = result.lastIndexOf("|");
    if (separator < 0) {
      this.status = "MPRIS 不可用；请检查 Python 3、PyGObject 和用户会话 D-Bus";
      return false;
    }
    this.endpoint = result.slice(0, separator);
    this.token = result.slice(separator + 1);
    return true;
  }

  private async request(path: string, body?: TrackState): Promise<Response> {
    return fetch(`${this.endpoint}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "X-NEMusic-Token": this.token!, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async attach(): Promise<void> {
    if (!this.enabled) {
      await this.detach();
      return;
    }
    const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
    const target = targets.targetInfos.find((item) => isPlayerDocument(item.url));
    if (target?.targetId === this.targetId) return;
    await this.detach();
    if (!target) return;
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    this.targetId = target.targetId;
    this.sessionId = attached.sessionId;
  }

  private async detach(): Promise<void> {
    const sessionId = this.sessionId;
    this.targetId = null;
    this.sessionId = null;
    if (sessionId) {
      try {
        await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId });
      } catch {}
    }
  }

  private async evaluate(expression: string, userGesture = false): Promise<unknown> {
    if (!this.sessionId) return null;
    const result = await ChromeDevToolsProtocol.send("Runtime.evaluate", { expression, returnByValue: true, userGesture }, this.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      if (!(await this.connect())) return;
      await this.attach();
      this.state = this.sessionId ? (await this.evaluate(SNAPSHOT_SCRIPT)) as TrackState : EMPTY_STATE;
      const update = await this.request("/state", this.state);
      if (!update.ok) throw new Error(`MPRIS state update failed: ${update.status}`);
      const commands = await this.request("/commands");
      if (!commands.ok) throw new Error(`MPRIS command poll failed: ${commands.status}`);
      this.status = "MPRIS 已连接";
      for (const command of (await commands.json()) as Command[]) {
        if (command.action === "open") this.open();
        else if (command.action === "close") this.close();
        else if (this.sessionId) {
          await this.evaluate(commandScript(command), true);
        }
      }
    } catch (error) {
      console.warn("[NEMusic] MPRIS bridge", error);
      this.status = "MPRIS 连接失败；请检查 Steam 控制台和辅助进程日志";
      await this.detach();
      this.endpoint = null;
      this.token = null;
    } finally {
      this.busy = false;
    }
  }
}
