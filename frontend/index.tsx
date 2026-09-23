import { definePlugin, DialogButton, Field, Toggle } from "millennium";
import { useEffect, useState } from "react";
import { getPlayer, shutdownPlayer, type PlayerSnapshot } from "./player.ts";

function NoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9 18.5a2.5 2.5 0 1 1-2-2.45V6.2l10-2v9.85a2.5 2.5 0 1 1-2-2.45V7.1l-6 1.2v10.2Z"
      />
    </svg>
  );
}

function SettingsContent() {
  const player = getPlayer();
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => player.snapshot());

  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(player.snapshot()), 400);
    return () => window.clearInterval(timer);
  }, [player]);

  const settings = snapshot.settings;
  const throttling =
    snapshot.throttlingSupported == null
      ? "还没探测"
      : snapshot.throttlingSupported
        ? "这版 Steam 有这个接口"
        : "这版 Steam 没有这个接口";

  return (
    <>
      <Field
        label="播放器"
        description={`${snapshot.status}。点击顶部其他栏目即可返回 Steam 页面。`}
        bottomSeparator="standard"
      >
        <DialogButton onClick={() => player.open()}>{snapshot.mode === "closed" ? "打开" : "展开"}</DialogButton>
      </Field>
      <Field label="收起" description="播放器还在，只是让出画面。" bottomSeparator="none">
        <DialogButton onClick={() => player.collapse()} disabled={snapshot.mode === "closed"}>
          收起
        </DialogButton>
      </Field>
      <Field label="关闭" description="关掉内嵌页，后台播放也会停。" bottomSeparator="thick">
        <DialogButton onClick={() => player.close()} disabled={!snapshot.hasView && snapshot.mode === "closed"}>
          关闭
        </DialogButton>
      </Field>
      <Field label="启动时打开" description="Steam 主窗口出现后自动展开播放器。" bottomSeparator="standard">
        <Toggle value={settings.openOnStart} onChange={(openOnStart) => player.updateSettings({ openOnStart })} />
      </Field>
      <Field
        label="收起后继续播放"
        description="收起时在右下角留 4 像素的可见画面，避免页面被当成隐藏。关掉的话就真隐藏，切歌可能停。"
        bottomSeparator="standard"
      >
        <Toggle
          value={settings.keepAliveWhenCollapsed}
          onChange={(keepAliveWhenCollapsed) => player.updateSettings({ keepAliveWhenCollapsed })}
        />
      </Field>
      <Field
        label="最小化后继续跑页面"
        description={`反复调用 Steam 语音通话用的 SetBackgroundThrottlingDisabled。${throttling}。窗口整个最小化之后仍不保证切歌，这是 CEF 的限制。`}
        bottomSeparator="none"
      >
        <Toggle
          value={settings.disableBackgroundThrottling}
          onChange={(disableBackgroundThrottling) => player.updateSettings({ disableBackgroundThrottling })}
        />
      </Field>
    </>
  );
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
  shutdownPlayer();
  return "ok";
}

export default definePlugin(() => {
  getPlayer().boot();
  return {
    title: "网易云音乐",
    icon: <NoteIcon />,
    content: <SettingsContent />,
  };
});
