import { DialogButton, Dropdown, Field, TextField, Toggle } from "millennium";
import { useEffect, useState } from "react";
import type { PlayerController, PlayerSnapshot } from "./player/player.ts";
import { QUALITY_OPTIONS, qualityLabel } from "./quality/quality-player.ts";
import { IDENTITY_LABELS, IDENTITY_VARIANTS, type IdentityVariant } from "./together/identity-player.ts";
import { sanitizeMpdSettings, type NotificationMode, type PlaybackBackend, type TransitionMode } from "./settings.ts";
import { sanitizeUnblockSources } from "./unblock/sources.ts";

const NOTIFICATION_OPTIONS = [
  { data: "system", label: "系统通知" },
  { data: "steam", label: "Steam 弹窗" },
  { data: "none", label: "无" },
];

const PLAYBACK_BACKEND_OPTIONS: { data: PlaybackBackend; label: string }[] = [
  { data: "web", label: "内嵌网页播放器" },
  { data: "mpv", label: "mpv（外部音频）" },
  { data: "mpd", label: "MPD（本机 / 远程）" },
];

const TRANSITION_MODE_OPTIONS: { data: TransitionMode; label: string }[] = [
  { data: "off", label: "关闭" },
  { data: "normal", label: "普通（淡入淡出）" },
  { data: "smart", label: "智能（节拍混音）" },
];

const UI_SCALE_OPTIONS = [
  { data: 0.8, label: "80%" },
  { data: 0.9, label: "90%" },
  { data: 1, label: "100%（默认）" },
  { data: 1.1, label: "110%" },
  { data: 1.25, label: "125%" },
  { data: 1.5, label: "150%" },
];

// snapshot() 每次调用都会返回全新的对象，所以无条件喂给 setState 会让整个面板每秒重渲染
// 好几次，哪怕什么都没变。
function sameSnapshot(a: PlayerSnapshot, b: PlayerSnapshot): boolean {
  return a.mode === b.mode
    && a.status === b.status
    && a.hasView === b.hasView
    && a.throttlingSupported === b.throttlingSupported
    && a.mprisStatus === b.mprisStatus
    && a.mprisCanReconnect === b.mprisCanReconnect
    && a.mpvStatus === b.mpvStatus
    && a.mpdStatus === b.mpdStatus
    && a.unblockStatus === b.unblockStatus
    && a.recognitionStatus === b.recognitionStatus
    && a.settingsEntry === b.settingsEntry
    && JSON.stringify(a.quality) === JSON.stringify(b.quality)
    && JSON.stringify(a.together) === JSON.stringify(b.together)
    && JSON.stringify(a.download) === JSON.stringify(b.download)
    && JSON.stringify(a.settings) === JSON.stringify(b.settings);
}

const SETTINGS_ENTRY_TEXT: Record<PlayerSnapshot["settingsEntry"], string> = {
  native: "设置入口：原生补丁生效",
  injected: "设置入口：兼容注入（补丁没匹配上）",
  waiting: "设置入口：还没打开过设置页，无法判断",
};

/**
 * 显示页面**实际**在上报的身份（回读值），不是我们「打算」写的值——补丁没生效的时候
 * 只有回读能看出来。
 */
function identityText(identity: PlayerSnapshot["together"]["identity"]): string {
  if (!identity.ok) return identity.note || "还没读到页面身份";
  const who = `APP_CONF 上报 os=${identity.os} / appver=${identity.appver} / osver=${identity.osver}`;
  // weapi 不看 APP_CONF，只看 cookie；一起听的接口全是 weapi，所以真正决定对方能不能进来
  // 的是这一行。同名用 | 拼开说明 cookie 重了，那本身就是个问题。
  const keys = Object.keys(identity.cookie).sort();
  const wire = keys.length
    ? keys.map(key => `${key}=${identity.cookie[key]}`).join(" / ")
    : "没读到 cookie（页面还没写，或者被 HttpOnly 挡住了）";
  const warn = "只影响一起听建房时报出去的客户端版本，不影响播放和下载；但这确实是假报身份，有账号风控风险";
  return `${who}；实际发出去的 cookie：${wire}。${warn}`;
}

export function SettingsContent({ player }: { player: PlayerController }) {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => player.snapshot());
  const [directory, setDirectory] = useState(() => snapshot.settings.downloadDirectory);
  const [nameTemplate, setNameTemplate] = useState(() => snapshot.settings.downloadNameTemplate);
  const [unblockSources, setUnblockSources] = useState(() => snapshot.settings.unblockSources.join(", "));
  const [mpd, setMpd] = useState(() => ({ ...snapshot.settings.mpd, port: String(snapshot.settings.mpd.port) }));

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = player.snapshot();
      setSnapshot(current => (sameSnapshot(current, next) ? current : next));
    }, 400);
    return () => window.clearInterval(timer);
  }, [player]);

  const commitDirectory = () => {
    const trimmed = directory.trim();
    if (trimmed === snapshot.settings.downloadDirectory) return;
    setSnapshot(player.updateSettings({ downloadDirectory: trimmed }));
    setDirectory(trimmed);
  };

  const commitNameTemplate = () => {
    const trimmed = nameTemplate.trim();
    if (trimmed === snapshot.settings.downloadNameTemplate) return;
    setSnapshot(player.updateSettings({ downloadNameTemplate: trimmed }));
    setNameTemplate(trimmed);
  };

  const settings = snapshot.settings;
  const commitMpd = () => {
    const next = sanitizeMpdSettings({ ...mpd, port: Number(mpd.port) });
    setMpd({ ...next, port: String(next.port) });
    setSnapshot(player.updateSettings({ mpd: next }));
  };
  const commitUnblockSources = () => {
    const sources = sanitizeUnblockSources(unblockSources.split(/[,，\s]+/).filter(Boolean));
    setUnblockSources(sources.join(", "));
    if (sources.join(",") !== settings.unblockSources.join(",")) setSnapshot(player.updateSettings({ unblockSources: sources }));
  };
  const quality = snapshot.quality;
  const together = snapshot.together;
  const qualityOptions = QUALITY_OPTIONS.some(option => option.data === quality.preferred) || quality.preferred == null
    ? QUALITY_OPTIONS
    : [...QUALITY_OPTIONS, { data: quality.preferred, label: qualityLabel(quality.preferred) }];
  const throttling =
    snapshot.throttlingSupported == null
      ? "还没探测"
      : snapshot.throttlingSupported
        ? "这版 Steam 有这个接口"
        : "这版 Steam 没有这个接口";
  // MPRIS 以及基于它的快捷键命令只在 Linux 上存在。

  return (
    <div
      className="nemusic-settings-content"
      style={{ flex: "1 1 0", height: "100%", minHeight: 0, overflowX: "hidden", overflowY: "auto", scrollbarGutter: "stable", paddingRight: 12, boxSizing: "border-box" }}
    >
      <Field
        label="播放后端"
        description={settings.playbackBackend === "mpv"
          ? `使用 mpv 输出音频，网易云网页仍用于登录、选歌和一起听。${snapshot.mpvStatus}`
          : settings.playbackBackend === "mpd"
            ? `由 MPD 所在设备输出音频，网易云网页用于登录和选歌。不支持倍速。${snapshot.mpdStatus}`
            : "使用网易云网页内嵌播放器；外部播放可选已安装的 mpv 或已运行的 MPD。"}
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={PLAYBACK_BACKEND_OPTIONS}
          selectedOption={settings.playbackBackend}
          onChange={option => setSnapshot(player.updateSettings({ playbackBackend: option.data }))}
        />
      </Field>
      {settings.playbackBackend === "mpv" && <>
        <Field label="歌曲过渡模式" description={settings.mpvTransitionMode === "smart"
          ? "分析鼓点与节奏，对齐拍点并保留音高调整速度，自动选择 8–30 秒混音；需要 ffmpeg，不适合混音时回退普通模式。支持顺序播放和列表循环。"
          : "普通模式提前准备下一首并淡入淡出，安装 ffmpeg 后按首尾音量调整衔接。一起听、单曲循环、随机和 FM 模式下停用过渡。"} bottomSeparator="standard">
          <Dropdown rgOptions={TRANSITION_MODE_OPTIONS} selectedOption={settings.mpvTransitionMode}
            onChange={option => setSnapshot(player.updateSettings({ mpvTransitionMode: option.data }))} />
        </Field>
        {settings.mpvTransitionMode !== "off" && <Field label={settings.mpvTransitionMode === "smart" ? "普通模式回退时长" : "最长过渡时间"} description="普通淡入淡出的最长时长；智能混音的时长由节拍自动决定。" bottomSeparator="standard">
          <Dropdown rgOptions={[1, 2, 3, 4, 6, 8, 10, 12].map(data => ({ data, label: `${data} 秒` }))}
            selectedOption={settings.mpvTransitionSeconds}
            onChange={option => setSnapshot(player.updateSettings({ mpvTransitionSeconds: option.data }))} />
        </Field>}
      </>}
      {settings.playbackBackend === "mpd" && <>
        <Field label="MPD 地址" description="本机默认为 127.0.0.1；也可填写局域网 / 远程主机名或 IPv6 地址。" bottomSeparator="standard">
          <TextField value={mpd.host} onChange={event => setMpd({ ...mpd, host: event.target.value })} />
        </Field>
        <Field label="MPD 端口" bottomSeparator="standard">
          <TextField mustBeNumeric value={mpd.port} onChange={event => setMpd({ ...mpd, port: event.target.value })} />
        </Field>
        <Field label="MPD Unix socket" description="可选，本机 socket 的绝对路径，支持 ~/。填写后优先使用 socket，忽略地址和端口。" bottomSeparator="standard">
          <TextField value={mpd.socket} onChange={event => setMpd({ ...mpd, socket: event.target.value })} />
        </Field>
        <Field label="MPD 密码" description="可选；保存在本机插件设置中。" bottomSeparator="standard">
          <TextField bIsPassword value={mpd.password} onChange={event => setMpd({ ...mpd, password: event.target.value })} />
        </Field>
        <Field label="MPD 连接" description="先启动 MPD 并启用 HTTP/HTTPS 输入和音频输出。远程设备需要能直接访问歌曲地址。插件只清理自己添加的歌曲，不清空原队列。" bottomSeparator="standard">
          <DialogButton onClick={commitMpd}>保存并连接</DialogButton>
          <DialogButton onClick={() => player.reconnectMpd()}>重新连接</DialogButton>
        </Field>
      </>}
      <Field
        label="UnblockNeteaseMusic（实验性）"
        description="仅 Linux：网页点击灰歌、外部播放和下载在官方无地址或仅有试听时尝试其他音源。需要 Node.js 22+。"
        bottomSeparator="standard"
      >
        <Toggle value={settings.unblockEnabled} onChange={unblockEnabled => setSnapshot(player.updateSettings({ unblockEnabled }))} />
      </Field>
      {settings.unblockEnabled && <>
        <Field
          label="解灰音源顺序"
          description="按填写顺序匹配，用逗号分隔。可选 kuwo（酷我）、kugou（酷狗）、bodian（波点）、bilibili（音频）、bilivideo（视频）。按回车或移开焦点保存；实际版本和音质取决于音源。"
          bottomSeparator="standard"
        >
          <TextField
            value={unblockSources}
            onChange={event => setUnblockSources(event.target.value)}
            onBlur={commitUnblockSources}
            onKeyDown={event => { if (event.key === "Enter") commitUnblockSources(); }}
          />
        </Field>
        <Field label="解灰服务" description={snapshot.unblockStatus} bottomSeparator="standard">
          <DialogButton onClick={() => player.checkUnblock()}>检测连接</DialogButton>
        </Field>
      </>}
      <Field
        label="网易云界面缩放"
        description="只缩放内嵌的网易云页面，修改后立即生效"
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={UI_SCALE_OPTIONS}
          selectedOption={settings.uiScale}
          onChange={option => setSnapshot(player.updateSettings({ uiScale: Number(option.data) }))}
        />
      </Field>
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
            setSnapshot(player.updateSettings({ downloadQuality: option.data }));
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
        label="下载命名模板"
        description={`保存文件的名字，可用 {title} {artist} {album}。改完按回车或点到别处保存`}
        bottomSeparator="standard"
      >
        <TextField
          value={nameTemplate}
          onChange={event => setNameTemplate(event.target.value)}
          onBlur={commitNameTemplate}
          onKeyDown={event => {
            if (event.key === "Enter") commitNameTemplate();
          }}
        />
      </Field>
      <Field label="启动时打开" description="Steam 主窗口出现后自动展开播放器。" bottomSeparator="standard">
        <Toggle
          value={settings.openOnStart}
          onChange={(openOnStart) => setSnapshot(player.updateSettings({ openOnStart }))}
        />
      </Field>
      <Field
        label="收起后继续播放"
        description="收起时藏在右下角留 4 像素的可见画面，避免页面被当成隐藏。关掉的话就真隐藏，切歌可能停。"
        bottomSeparator="standard"
      >
        <Toggle
          value={settings.keepAliveWhenCollapsed}
          onChange={(keepAliveWhenCollapsed) => setSnapshot(player.updateSettings({ keepAliveWhenCollapsed }))}
        />
      </Field>
      <Field
        label="最小化后继续跑页面"
        description={`反复调用 Steam 语音通话用的 SetBackgroundThrottlingDisabled。${throttling}。窗口整个最小化之后仍不保证切歌，这是 CEF 的限制`}
        bottomSeparator="standard"
      >
        <Toggle
          value={settings.disableBackgroundThrottling}
          onChange={(disableBackgroundThrottling) => setSnapshot(player.updateSettings({ disableBackgroundThrottling }))}
        />
      </Field>
      <Field
        label="通知方式"
        description="切歌、下载完成或失败时统一使用此提醒方式。系统通知走桌面通知（Linux 需要 Python 辅助进程），Steam 弹窗用右下角的 Steam 通知样式，无则不提醒"
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={NOTIFICATION_OPTIONS}
          selectedOption={settings.notificationMode}
          onChange={option => {
            setSnapshot(player.updateSettings({ notificationMode: option.data as NotificationMode }));
          }}
        />
      </Field>
      <Field
        label="诊断"
        description={`${SETTINGS_ENTRY_TEXT[snapshot.settingsEntry]}。Steam 更新后如果显示兼容注入，说明官方补丁没匹配上，可以去 Github 反馈`}
        bottomSeparator="standard"
      />
      <Field label="系统媒体控制" description={snapshot.mprisStatus}>
        {snapshot.mprisCanReconnect && (
          <DialogButton onClick={() => {
            player.reconnectMpris();
            setSnapshot(player.snapshot());
          }}>
            重连
          </DialogButton>
        )}
      </Field>
      <Field
        label="一起听身份"
        description={identityText(together.identity)}
        bottomSeparator="standard"
      >
        <Dropdown
          rgOptions={IDENTITY_VARIANTS.map(variant => ({ data: variant, label: IDENTITY_LABELS[variant] }))}
          selectedOption={together.identityVariant}
          strDefaultLabel="等待播放器"
          disabled={!together.supported}
          onChange={option => {
            player.setTogetherIdentityVariant(option.data as IdentityVariant);
            setSnapshot(player.snapshot());
          }}
        />
      </Field>
    </div>
  );
}

