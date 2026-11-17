import { useEffect, useState } from "react";
import { Dropdown, Field, TextField, Toggle } from "millennium";
import type { PlayerController, PlayerSnapshot } from "./player/player.ts";
import type { GameProfile } from "./playback/game-profile.ts";
import { SettingsActions, SettingsButton } from "./settings-controls.tsx";

export function GameProfileSettings({ player, snapshot }: { player: PlayerController; snapshot: PlayerSnapshot }) {
  const profiles = snapshot.settings.gameProfiles;
  const [editing, setEditing] = useState(profiles[0]?.id ?? "");
  const [draft, setDraft] = useState<GameProfile | null>(profiles[0] ? { ...profiles[0] } : null);
  const [message, setMessage] = useState("");
  const saved = profiles.find(profile => profile.id === editing);
  useEffect(() => { setDraft(saved ? { ...saved } : null); }, [saved?.id, saved?.name, saved?.action, saved?.volumePercent, saved?.muteNotifications]);
  const active = snapshot.gameProfile;
  const locked = active.busy || active.activeId === editing;
  const add = () => {
    const profile: GameProfile = { id: `game-${Date.now()}`, name: "新游戏配置", action: "lower", volumePercent: 40, muteNotifications: true };
    player.updateSettings({ gameProfiles: [...profiles, profile] }); setEditing(profile.id); setDraft(profile);
  };
  return <>
    <Field label="当前游戏配置" description={`${active.status}。手动选择配置，退出时恢复原状态；手动改过的音量会保留。`} bottomSeparator="standard">
      <Dropdown selectedOption={active.activeId} disabled={active.busy || !snapshot.hasView}
        rgOptions={[{ data: "", label: "关闭 / 恢复" }, ...profiles.map(profile => ({ data: profile.id, label: profile.name }))]}
        onChange={option => player.selectGameProfile(String(option.data))} />
    </Field>
    <Field label="编辑配置" description="可以为不同游戏保存配置；保存后从上方切换。正在使用的配置请先关闭再编辑。" childrenLayout="below" bottomSeparator="standard">
      <SettingsActions>
        <Dropdown selectedOption={editing} rgOptions={profiles.map(profile => ({ data: profile.id, label: profile.name }))}
          onChange={option => { setEditing(String(option.data)); setMessage(""); }} />
        <SettingsButton disabled={profiles.length >= 30 || active.busy} onClick={add}>添加配置</SettingsButton>
      </SettingsActions>
    </Field>
    {draft && <>
      <Field label="配置名称" bottomSeparator="standard"><TextField disabled={locked} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="播放动作" bottomSeparator="standard">
        <Dropdown disabled={locked} selectedOption={draft.action} rgOptions={[{ data: "pause", label: "暂停音乐" }, { data: "lower", label: "降低音量" }, { data: "none", label: "保持播放" }]}
          onChange={option => setDraft({ ...draft, action: option.data as GameProfile["action"] })} />
      </Field>
      {draft.action === "lower" && <Field label="保留原音量的比例" bottomSeparator="standard">
        <Dropdown disabled={locked} selectedOption={draft.volumePercent} rgOptions={[0, 10, 20, 30, 40, 50, 60, 75, 100].map(data => ({ data, label: `${data}%` }))}
          onChange={option => setDraft({ ...draft, volumePercent: Number(option.data) })} />
      </Field>}
      <Field label="关闭切歌通知" bottomSeparator="standard"><Toggle disabled={locked} value={draft.muteNotifications} onChange={muteNotifications => setDraft({ ...draft, muteNotifications })} /></Field>
      <SettingsActions>
        <SettingsButton disabled={locked || !draft.name.trim()} onClick={() => { player.updateSettings({ gameProfiles: profiles.map(profile => profile.id === draft.id ? draft : profile) }); setMessage("配置已保存"); }}>保存配置</SettingsButton>
        <SettingsButton disabled={locked} onClick={() => { const remaining = profiles.filter(profile => profile.id !== editing); player.updateSettings({ gameProfiles: remaining }); setEditing(remaining[0]?.id ?? ""); setDraft(remaining[0] ?? null); }}>删除配置</SettingsButton>
      </SettingsActions>
    </>}
    {message && <p role="status">{message}</p>}
  </>;
}
