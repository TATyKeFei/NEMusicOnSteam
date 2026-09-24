import { PLAYER_ACCESS_SCRIPT, SNAPSHOT_SCRIPT } from "./mpris-player.ts";

export const QUALITY_OPTIONS = [
  { data: 128, label: "标准 · 128 kbps" },
  { data: 192, label: "较高 · 192 kbps" },
  { data: 320, label: "极高 · 320 kbps" },
  { data: 999, label: "无损 · SQ" },
  { data: 1999, label: "高解析度无损 · Hi-Res" },
  { data: 3999, label: "高清臻音" },
  { data: 4999, label: "超清母带" },
  { data: 5999, label: "沉浸环绕声" },
];

export type QualityState = {
  available: boolean;
  preferred: number | null;
  current: number | null;
  playing: boolean;
};

export function qualityLabel(value: number | null): string {
  if (value == null) return "暂无播放中的歌曲";
  if (value === 2999) return "杜比全景声";
  return QUALITY_OPTIONS.find(option => option.data === value)?.label ?? `未知音质（${value}）`;
}

const QUALITY_ACCESS_SCRIPT = `
  ${PLAYER_ACCESS_SCRIPT}
  const readQuality = () => {
    const state = playerStore?.getState();
    const quantity = state?.setting?.quantity;
    const preferred = state?.host?.isAnonymous ? quantity?.listenAnon : quantity?.listenReg;
    const current = state?.playing?.resourceTrackId ? state.playing.resourcePlayingQuality : null;
    return {
      available: Boolean(quantity && state?.host),
      preferred: Number.isFinite(preferred) ? preferred : null,
      current: Number.isFinite(current) ? current : null,
      playing: state?.playing?.playingState === 2,
    };
  };
`;

export const QUALITY_SNAPSHOT_SCRIPT = `(() => {
  ${QUALITY_ACCESS_SCRIPT}
  return readQuality();
})()`;

export function qualityCommandScript(value: number): string {
  return `(async () => {
    ${QUALITY_ACCESS_SCRIPT}
    const value = ${JSON.stringify(value)};
    if (!${JSON.stringify(QUALITY_OPTIONS.map(option => option.data))}.includes(value)) throw new Error('不支持的音质档位');
    if (!readQuality().available) throw new Error('网易云音质设置尚未就绪，请打开播放器稍后重试');
    const anonymous = playerStore.getState().host.isAnonymous;
    if (anonymous && value > 320) throw new Error('请先在网易云播放器中登录，再选择高音质');
    await playerStore.dispatch({
      type: 'setting/updateQuantity',
      payload: { listen: value, [anonymous ? 'listenAnon' : 'listenReg']: value },
    });
    if (readQuality().preferred !== value) throw new Error('网易云未确认音质设置，请重试');
    let message = '已保存，下一首歌曲生效';
    const latest = playerStore.getState();
    const state = latest.playing;
    const host = latest.host;
    const plusOnly = value === 4999 || value === 5999;
    const canUse = value <= 192 || value <= (state?.resourcePrivilege?.maxFreeBr || 192)
      || host.isPlusVip || (host.isVinylVip && !plusOnly)
      || (host.isMusicPackage && latest.configCenter?.['preload#musicPackageCanUseHiresAndLoseless'] && [320, 999, 1999].includes(value));
    if (!canUse) message = '已保存，账号或歌曲可能不支持此档位；下一首以网易云返回的音质为准';
    if (canUse && state?.playingState === 2 && state.resourceTrackId && state.curPlaying && state.resourceType === 'track' && state.trackFileType !== 'local' && !state.isLoadingFirst) {
      const playback = ${SNAPSHOT_SCRIPT};
      if (Number.isFinite(playback.position) && playback.duration > 0) {
        await playerStore.dispatch({
          type: 'playing/switchQuality',
          payload: {
            quality: { quality: value, type: value === 5999 ? 'envSound' : 'soundQuality' },
            current: playback.position,
            triggerScene: 'miniBar',
          },
        });
        message = '已保存并请求切换，请以当前实际音质为准';
      }
    }
    return { state: readQuality(), message };
  })()`;
}
