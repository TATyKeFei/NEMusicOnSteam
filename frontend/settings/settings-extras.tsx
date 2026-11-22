import { Dropdown, Field, Toggle } from "millennium";
import { useState } from "react";
import { SettingsActions, SettingsButton } from "./settings-controls.tsx";
import type { PlayerController, PlayerSnapshot } from "../player/player.ts";
import type { LoudnessMode } from "./settings.ts";
import { CAPABILITY_LABELS, type PlayerCapabilities } from "../player/capabilities.ts";

type Props = { player: PlayerController; snapshot: PlayerSnapshot };
const TASK_STATES = { queued: "排队中", resolving: "解析中", downloading: "下载中", completed: "已完成", failed: "失败", cancelled: "已取消", skipped: "已跳过" };

export function AudioSettings({ player, snapshot }: Props) {
  const settings = snapshot.settings;
  const devices = [{ data: "auto", label: "系统默认输出" }, ...snapshot.audioDevices.filter(device => device.name !== "auto").map(device => ({ data: device.name, label: device.description }))];
  if (!devices.some(item => item.data === settings.audioOutputDevice)) devices.push({ data: settings.audioOutputDevice, label: "所选设备已断开（使用系统默认）" });
  return <>
    <Field label="响度均衡" description="ReplayGain 使用歌曲自带的音量标签；动态均衡适合没有标签或音量差较大的音源。" bottomSeparator="standard">
      <Dropdown selectedOption={settings.mpvLoudness} rgOptions={[{ data: "off", label: "关闭" }, { data: "replaygain", label: "ReplayGain" }, { data: "dynamic", label: "动态响度均衡" }]}
        onChange={option => player.updateSettings({ mpvLoudness: option.data as LoudnessMode })} />
    </Field>
    <Field label="音频输出设备" description="设备断开时使用系统默认输出；重新连接后恢复所选设备。" bottomSeparator="standard">
      <Dropdown selectedOption={settings.audioOutputDevice} rgOptions={devices} onChange={option => player.updateSettings({ audioOutputDevice: option.data })} />
    </Field>
  </>;
}

export function SleepSettings({ player, snapshot }: Props) {
  const [choice, setChoice] = useState<number | "track">(30);
  return <>
    <Field label="定时停止播放" description={`${snapshot.sleep.status}${snapshot.sleep.mode === "countdown" ? `，剩余 ${Math.ceil(snapshot.sleep.remaining / 60)} 分钟` : ""}`} childrenLayout="below" bottomSeparator="standard">
      <SettingsActions>
        <div style={{ width: 180, maxWidth: "100%", flex: "0 1 180px" }}>
          <Dropdown selectedOption={choice} rgOptions={[...([15, 30, 60, 90, 120].map(data => ({ data, label: `${data} 分钟后` }))), { data: "track", label: "播完当前歌曲" }]}
            onChange={option => setChoice(option.data as number | "track")} />
        </div>
        <SettingsButton disabled={!snapshot.hasView} onClick={() => player.startSleepTimer(choice)}>开始</SettingsButton>
        <SettingsButton disabled={snapshot.sleep.mode === "off"} onClick={() => player.cancelSleepTimer()}>取消定时</SettingsButton>
      </SettingsActions>
    </Field>
    <Field label="停止前淡出" description="停止或取消后恢复原音量。播完当前歌曲模式会暂停歌曲过渡和下一首预载。" bottomSeparator="standard">
      <Dropdown selectedOption={snapshot.settings.sleepFadeSeconds} rgOptions={[0, 5, 10, 20, 30].map(data => ({ data, label: data ? `${data} 秒` : "不淡出" }))}
        onChange={option => player.updateSettings({ sleepFadeSeconds: option.data })} />
    </Field>
  </>;
}

export function DownloadTasks({ player, snapshot }: Props) {
  const tasks = snapshot.download.tasks;
  const failed = tasks.filter(task => task.state === "failed");
  return <>
    <Field label="跳过重复下载" description="检查任务队列和当前下载目录中的歌曲记录；相同歌曲、音质已下载时跳过。" bottomSeparator="standard">
      <Toggle value={snapshot.settings.skipDuplicateDownloads} onChange={skipDuplicateDownloads => player.updateSettings({ skipDuplicateDownloads })} />
    </Field>
    <Field label="下载任务" description={`${snapshot.download.status}；失败 ${failed.length} 首，排队 ${tasks.filter(task => task.state === "queued").length} 首。${snapshot.download.progress ? `已下载 ${Math.round(snapshot.download.progress.received / 1024)} / ${Math.round(snapshot.download.progress.total / 1024)} KB` : ""}`} childrenLayout="below" bottomSeparator="standard">
      <SettingsActions>
        <SettingsButton onClick={() => player.pauseDownloads(!snapshot.download.paused)}>{snapshot.download.paused ? "继续队列" : "暂停队列"}</SettingsButton>
        <SettingsButton disabled={!snapshot.download.available || snapshot.download.paused} onClick={() => player.downloadCurrentSong()}>下载当前歌曲</SettingsButton>
        <SettingsButton disabled={!snapshot.download.available || snapshot.download.busy || snapshot.compatibility.capabilities?.queue === false} onClick={() => player.downloadPlayingList()}>下载播放列表</SettingsButton>
        <SettingsButton disabled={!snapshot.download.available || !failed.length} onClick={() => player.retryFailedDownloads()}>重试失败</SettingsButton>
        <SettingsButton onClick={() => player.clearFinishedDownloads()}>清理已结束</SettingsButton>
      </SettingsActions>
    </Field>
    {snapshot.download.paused && <p>队列已暂停；正在下载的歌曲会继续完成。未完成任务会保存，重启后打开播放器继续。</p>}
    {snapshot.download.persistenceError && <p role="alert">下载任务保存失败，请检查 Steam 浏览器存储空间。</p>}
    {snapshot.download.progress && <p>{Math.round(snapshot.download.speed / 1024)} KB/s{snapshot.download.remaining != null ? `，预计剩余 ${Math.ceil(snapshot.download.remaining)} 秒` : ""}</p>}
    <div aria-label="下载任务列表" style={{ maxHeight: 320, overflowY: "auto" }}>
      {tasks.slice(-100).map(task => <Field key={task.id} label={`${task.artist ? `${task.artist} — ` : ""}${task.title}`}
        description={`${TASK_STATES[task.state]}${task.error ? `：${task.error}` : ""}${task.path ? `；${task.path}` : ""}`} verticalAlignment="center" bottomSeparator="standard">
        {["queued", "resolving", "downloading"].includes(task.state) && <SettingsButton onClick={() => player.cancelDownload(task.id)}>取消</SettingsButton>}
        {["failed", "cancelled"].includes(task.state) && <SettingsButton disabled={!snapshot.download.available} onClick={() => player.retryDownload(task.id)}>重试</SettingsButton>}
      </Field>)}
    </div>
    {failed.length > 0 && <p>失败歌曲：{failed.map(task => task.title).join("、")}</p>}
  </>;
}

export function Diagnostics({ player, snapshot }: Props) {
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopyStatus("已复制"); }
    catch { setCopyStatus("请选中下方报告手动复制"); }
  };
  return <>
    <Field label="网页兼容性" description={snapshot.compatibility.status} childrenLayout="below" bottomSeparator="standard">
      <SettingsActions>
        <SettingsButton disabled={!snapshot.hasView} onClick={() => { void player.checkCompatibility(true); }}>重新检测兼容性</SettingsButton>
        <SettingsButton onClick={() => player.repairPlayback()}>重连播放后端</SettingsButton>
        <SettingsButton disabled={!snapshot.hasView} onClick={() => player.reload()}>重新加载网页</SettingsButton>
      </SettingsActions>
    </Field>
    {snapshot.compatibility.capabilities && <p>{(Object.entries(snapshot.compatibility.capabilities) as [keyof PlayerCapabilities, boolean | null][])
      .map(([name, available]) => `${CAPABILITY_LABELS[name]}：${available == null ? "等待初始化" : available ? "可用" : "未适配"}`).join("；")}</p>}
    <Field label="一键诊断" description="检查播放依赖、网页连接与各功能状态。报告不包含登录态、账号或音频地址。" inlineWrap="shift-children-below" verticalAlignment="center" bottomSeparator="standard">
      <SettingsActions>
        <SettingsButton disabled={busy} onClick={() => { setBusy(true); setCopyStatus(""); void player.diagnose().then(setReport).catch(() => setReport("诊断失败，请稍后重试")).finally(() => setBusy(false)); }}>{busy ? "检查中…" : "运行诊断"}</SettingsButton>
        <SettingsButton disabled={!report} onClick={() => { void copy(); }}>复制报告</SettingsButton>
      </SettingsActions>
    </Field>
    {copyStatus && <p role="status" style={{ margin: "0 0 8px", fontSize: 13, color: "#8f98a0" }}>{copyStatus}</p>}
    {report && <textarea aria-label="诊断报告" readOnly value={report} style={{ width: "100%", height: 240, boxSizing: "border-box", background: "#171d25", color: "inherit", padding: 10 }} />}
  </>;
}
