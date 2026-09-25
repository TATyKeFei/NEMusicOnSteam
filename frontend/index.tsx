import { definePlugin, DialogButton, Dropdown, Field, TextField, Toggle } from "millennium";
import { useEffect, useState, type ReactElement } from "react";
import { getPlayer, shutdownPlayer, type PlayerSnapshot } from "./player.ts";
import { QUALITY_OPTIONS, qualityLabel } from "./quality-player.ts";
import { SteamSettingsEntry } from "./steam-settings.ts";

const steamSettings = new SteamSettingsEntry(() => <SettingsContent />);

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
  const [directory, setDirectory] = useState(() => snapshot.settings.downloadDirectory);

  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(player.snapshot()), 400);
    return () => window.clearInterval(timer);
  }, [player]);

  const commitDirectory = () => {
    const trimmed = directory.trim();
    if (trimmed === player.snapshot().settings.downloadDirectory) return;
    player.updateSettings({ downloadDirectory: trimmed });
    setDirectory(trimmed);
    setSnapshot(player.snapshot());
  };

  const settings = snapshot.settings;
  const quality = snapshot.quality;
  const download = snapshot.download;
  const qualityOptions = QUALITY_OPTIONS.some(option => option.data === quality.preferred) || quality.preferred == null
    ? QUALITY_OPTIONS
    : [...QUALITY_OPTIONS, { data: quality.preferred, label: qualityLabel(quality.preferred) }];
  const throttling =
    snapshot.throttlingSupported == null
      ? "还没探测"
      : snapshot.throttlingSupported
        ? "这版 Steam 有这个接口"
        : "这版 Steam 没有这个接口";

  return (
    <>
      <Field
        label="播放音质"
        description="播放歌曲时切换音质会短暂暂停重新加载并保留播放进度；可能需要下一首才生效"
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={qualityOptions}
          selectedOption={quality.preferred}
          strDefaultLabel="等待播放器"
          disabled={!quality.available || quality.updating}
          onChange={option => {
            player.setQuality(option.data);
            setSnapshot(player.snapshot());
          }}
        />
      </Field>
      <Field
        label="当前实际音质"
        description={`${qualityLabel(quality.current)}。${quality.status}。如果没有变化可能是没有vip或当前歌曲不支持所选音质`}
        bottomSeparator="standard"
      />
      <Field
        label="下载音质"
        description="下载当前歌曲时用的音质，和上面的播放音质互不影响。账号没vip或歌曲没版权时可能拿不到所选档位"
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={QUALITY_OPTIONS}
          selectedOption={settings.downloadQuality}
          strDefaultLabel="等待播放器"
          onChange={option => {
            player.updateSettings({ downloadQuality: option.data });
            setSnapshot(player.snapshot());
          }}
        />
      </Field>
      <Field
        label="下载目录"
        description="留空则存到 ~/Music/网易云音乐，可以填 ~ 开头的路径。改完按回车或点到别处保存"
        bottomSeparator="standard"
      >
        <TextField
          value={directory}
          onChange={event => setDirectory(event.target.value)}
          onBlur={commitDirectory}
          onKeyDown={event => {
            if (event.key === "Enter") commitDirectory();
          }}
        />
      </Field>
      <Field
        label="下载当前歌曲"
        description={`${download.status}。只下载正在播放的这一首`}
        bottomSeparator="thick"
      >
        <DialogButton onClick={() => player.downloadCurrentSong()} disabled={!download.available || download.busy}>
          {download.busy ? "下载中" : "下载"}
        </DialogButton>
      </Field>
      <Field
        label="播放器"
        description={`${snapshot.status}。点击顶部其他栏目即可返回 Steam 页面`}
        bottomSeparator="standard"
      >
        <DialogButton onClick={() => player.open()}>{snapshot.mode === "closed" ? "打开" : "展开"}</DialogButton>
      </Field>
      <Field label="收起" description="播放器还在，只是让出画面" bottomSeparator="none">
        <DialogButton onClick={() => player.collapse()} disabled={snapshot.mode === "closed"}>
          收起
        </DialogButton>
      </Field>
      <Field label="关闭" description="关掉内嵌页，后台播放也会停" bottomSeparator="thick">
        <DialogButton onClick={() => player.close()} disabled={!snapshot.hasView && snapshot.mode === "closed"}>
          关闭
        </DialogButton>
      </Field>
      <Field label="启动时打开" description="Steam 主窗口出现后自动展开播放器。" bottomSeparator="standard">
        <Toggle value={settings.openOnStart} onChange={(openOnStart) => player.updateSettings({ openOnStart })} />
      </Field>
      <Field
        label="收起后继续播放"
        description="收起时藏在右下角留 4 像素的可见画面，避免页面被当成隐藏。关掉的话就真隐藏，切歌可能停。"
        bottomSeparator="standard"
      >
        <Toggle
          value={settings.keepAliveWhenCollapsed}
          onChange={(keepAliveWhenCollapsed) => player.updateSettings({ keepAliveWhenCollapsed })}
        />
      </Field>
      <Field
        label="最小化后继续跑页面"
        description={`反复调用 Steam 语音通话用的 SetBackgroundThrottlingDisabled。${throttling}。窗口整个最小化之后仍不保证切歌，这是 CEF 的限制`}
        bottomSeparator="none"
      >
        <Toggle
          value={settings.disableBackgroundThrottling}
          onChange={(disableBackgroundThrottling) => player.updateSettings({ disableBackgroundThrottling })}
        />
      </Field>
      <Field label="系统媒体控制" description={snapshot.mprisStatus} bottomSeparator="none" />
    </>
  );
}

export function renderSettings(): ReactElement {
  return <SettingsContent />;
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
  steamSettings.stop();
  shutdownPlayer();
  return "ok";
}

export default definePlugin(() => {
  getPlayer().boot();
  steamSettings.start();
  return {
    title: "网易云音乐",
    icon: <NoteIcon />,
    content: <SettingsContent />,
    onDismount: () => shutdown(),
  };
});
