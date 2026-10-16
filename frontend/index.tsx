import { definePlugin, ffi } from "millennium";
import type { ReactElement } from "react";
import { getPlayer, shutdownPlayer } from "./player/player.ts";
import { registerSteamShutdown } from "./player/steam-shutdown.ts";
import { SteamSettingsEntry } from "./widget/steam-settings.ts";
import { SettingsContent } from "./settings-content.tsx";
import { SETTINGS_ICON } from "./widget/settings-icon.ts";

const steamSettings = new SteamSettingsEntry(() => renderSettings());
const shutdownBackend = ffi<[], string>("shutdown_backend");
let runtimeStopped = false;

export function renderSettings(): ReactElement {
  return <SettingsContent player={getPlayer(steamSettings)} />;
}

export function renderSettingsIcon(): ReactElement {
  return <span style={{ display: "inline-flex", width: 20, height: 20 }} dangerouslySetInnerHTML={{ __html: SETTINGS_ICON }} />;
}

/** @ffi */
export function openPlayer(): string {
  return getPlayer().open();
}

/** @ffi */
export function togglePlayer(): string {
  return getPlayer().toggleFromNav();
}

/** @ffi */
export function collapsePlayer(): string {
  return getPlayer().collapse();
}

/** @ffi */
export function reloadPlayer(): string {
  return getPlayer().reload();
}

/** @ffi */
export function closePlayer(): string {
  return getPlayer().close();
}

/** @ffi */
export function shutdown(): string {
  if (runtimeStopped) return "ok";
  runtimeStopped = true;
  steamSettings.stop();
  shutdownPlayer();
  return "ok";
}

export default definePlugin(() => {
  runtimeStopped = false;
  // 正常退出 Steam 时，插件管理器不一定有机会执行 onDismount；pagehide/beforeunload
  // 是 WebKit 销毁前最后能可靠收到的信号。先把 BrowserView 销毁，避免它继续持有主窗口。
  const onPageExit = () => { shutdown(); };
  const unregisterShutdown = registerSteamShutdown(() => {
    shutdown();
    void shutdownBackend().catch(() => {});
  });
  window.addEventListener("pagehide", onPageExit);
  window.addEventListener("beforeunload", onPageExit);
  getPlayer(steamSettings).boot();
  steamSettings.start();
  return {
    title: "网易云音乐",
    icon: renderSettingsIcon(),
    content: renderSettings(),
    onDismount: () => {
      unregisterShutdown();
      window.removeEventListener("pagehide", onPageExit);
      window.removeEventListener("beforeunload", onPageExit);
      shutdown();
    },
  };
});
