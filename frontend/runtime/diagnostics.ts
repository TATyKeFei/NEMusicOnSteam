import { ffi } from "millennium";
import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { PLAYER_READY_SCRIPT } from "../player/player-recovery-player.ts";
import type { PlayerSnapshot } from "../player/player.ts";
import { playerTraffic } from "../player/player-target.ts";

const checkEnvironment = ffi<[], string>("diagnostics");

export function diagnosticAdvice(environment: string, backend: string, unblock = false): string[] {
  const missing = new Set(environment.split("\n").filter(line => line.endsWith("=missing")).map(line => line.split("=")[0]));
  const distro = /^Distro=([\w-]+)$/m.exec(environment)?.[1] ?? "unknown";
  const family = /arch|manjaro|endeavouros/.test(distro) ? "arch"
    : /ubuntu|debian|linuxmint/.test(distro) ? "debian" : distro === "fedora" ? "fedora"
      : distro.startsWith("opensuse") ? "suse" : "unknown";
  const packages: Record<string, Record<string, string>> = {
    python3: { arch: "python", debian: "python3", fedora: "python3", suse: "python3" },
    PyGObject: { arch: "python-gobject", debian: "python3-gi", fedora: "python3-gobject", suse: "python3-gobject" },
    mpv: { arch: "mpv", debian: "mpv", fedora: "mpv", suse: "mpv" },
    ffmpeg: { arch: "ffmpeg", debian: "ffmpeg", fedora: "ffmpeg", suse: "ffmpeg" },
    Node22: { arch: "nodejs", debian: "", fedora: "nodejs", suse: "nodejs" },
  };
  const advice: string[] = [], install: string[] = [];
  const wanted = ["python3", "PyGObject", ...(backend === "mpv" ? ["mpv", "ffmpeg"] : []), ...(unblock ? ["Node22"] : [])];
  for (const tool of wanted) {
    if (!missing.has(tool)) continue;
    const pkg = packages[tool]?.[family];
    if (pkg) install.push(pkg);
    else advice.push(tool === "Node22" ? "解灰需要 Node.js 22 或更高版本，请安装或升级后重新检测。" : `请通过发行版软件管理器安装 ${tool}，然后重新检测。`);
  }
  const prefix: Record<string, string> = { arch: "sudo pacman -S", debian: "sudo apt install", fedora: "sudo dnf install", suse: "sudo zypper install" };
  if (install.length) advice.unshift(`安装缺失依赖：${prefix[family]} ${[...new Set(install)].join(" ")}；安装后重新连接播放后端。`);
  if (missing.has("sessionBus")) advice.push("未检测到用户会话 D-Bus：请从正常桌面会话启动 Steam，避免使用 sudo 启动。");
  if (backend === "mpd") advice.push("MPD 无法连接时，请确认服务正在运行，并核对地址、端口、密码或 Unix socket。");
  return advice;
}

export function redactDiagnostic(value: string): string {
  return value.replace(/https?:\/\/[^\s）)]+/gi, "[地址已隐藏]")
    .replace(/(?:[A-Za-z]:\\|\/(?:home|tmp|run|mnt|Users|var|etc)\/)[^\r\n]*/gi, "[路径已隐藏]")
    .replace(/\b(?:token|cookie|authorization|password|session|uid)["']?\s*[:=]\s*[^\r\n]*/gi, "[隐私字段已隐藏]")
    .replace(/\bBearer\s+[^\s]+/gi, "[凭据已隐藏]");
}

export async function collectDiagnostics(snapshot: PlayerSnapshot): Promise<string> {
  const lines = [`NEMusicOnSteam 诊断`, `平台：${navigator.platform}`, `播放后端：${snapshot.settings.playbackBackend}`];
  try {
    const environment = await checkEnvironment();
    if (environment.includes("environment=unavailable")) lines.push("依赖检测：后端无法执行检查");
    for (const line of environment.split("\n")) {
      if (/^(python3|mpv|ffmpeg|node|PyGObject|Node22|sessionBus)=(ok|missing)$/.test(line)) {
        const [name, status] = line.split("="); lines.push(`${name}：${status === "ok" ? "可用" : "未检测到"}`);
      } else if (/^(Millennium=[\w. -]+|Distro=[\w-]+)$/.test(line)) lines.push(line);
    }
    if (/Linux/i.test(navigator.platform)) lines.push(...diagnosticAdvice(environment, snapshot.settings.playbackBackend, snapshot.settings.unblockEnabled));
  } catch { lines.push("依赖检测：无法连接插件后端"); }
  try {
    const ready = await tryEvaluateInPlayer(PLAYER_READY_SCRIPT, { awaitPromise: true });
    lines.push(`网页连接：${ready === true ? "正常" : snapshot.hasView ? "页面尚未就绪" : "播放器未打开"}`);
  } catch { lines.push("网页连接：读取失败"); }
  for (const [name, status] of Object.entries({
    播放器: snapshot.status, 系统媒体控制: snapshot.mprisStatus, mpv: snapshot.mpvStatus, MPD: snapshot.mpdStatus,
    解灰: snapshot.unblockStatus, 识曲: snapshot.recognitionStatus, 预载: snapshot.preloadStatus,
  })) lines.push(`${name}：${redactDiagnostic(status)}`);
  if (snapshot.compatibility) {
    lines.push(`网页兼容性：${snapshot.compatibility.status}`);
    for (const [name, available] of Object.entries(snapshot.compatibility.capabilities ?? {})) {
      lines.push(`网页能力 ${name}：${available == null ? "等待初始化" : available ? "可用" : "未适配"}`);
    }
  }
  if (typeof playerTraffic === "function") {
    const traffic = playerTraffic();
    lines.push(`CDP 累计调用：${traffic.evaluations}；状态读取：${traffic.snapshotReads}；共享命中：${traffic.snapshotHits}；页面状态事件：${traffic.stateEvents}`);
  }
  return lines.join("\n");
}
