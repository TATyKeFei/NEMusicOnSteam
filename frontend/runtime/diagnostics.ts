import { ffi } from "millennium";
import { tryEvaluateInPlayer } from "../player/player-target.ts";
import { PLAYER_READY_SCRIPT } from "../player/player-recovery-player.ts";
import type { PlayerSnapshot } from "../player/player.ts";

const checkEnvironment = ffi<[], string>("diagnostics");

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
      } else if (/^Millennium=[\w. -]+$/.test(line)) lines.push(line);
    }
  } catch { lines.push("依赖检测：无法连接插件后端"); }
  try {
    const ready = await tryEvaluateInPlayer(PLAYER_READY_SCRIPT, { awaitPromise: true });
    lines.push(`网页连接：${ready === true ? "正常" : snapshot.hasView ? "页面尚未就绪" : "播放器未打开"}`);
  } catch { lines.push("网页连接：读取失败"); }
  for (const [name, status] of Object.entries({
    播放器: snapshot.status, 系统媒体控制: snapshot.mprisStatus, mpv: snapshot.mpvStatus, MPD: snapshot.mpdStatus,
    解灰: snapshot.unblockStatus, 识曲: snapshot.recognitionStatus, 预载: snapshot.preloadStatus,
  })) lines.push(`${name}：${redactDiagnostic(status)}`);
  return lines.join("\n");
}
