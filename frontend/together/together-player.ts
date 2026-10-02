import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

/**
 * 网易云 st/webplayer 自带官方一起听，redux 里有一整套 listenTogether 模块：
 *
 *   async:listenTogether            房间状态、成员、房主 uid
 *   async:listenTogetherPlayList    房间歌单
 *   async:listenTogetherPlayStatus  播放指令同步
 *   async:listenTogetherPlayer      一起听状态下的播放器行为
 *
 * 所以这里不去自己实现房间协议，也不自己轮询网易云接口——页面已经通过 roomInfo.chatRoomId
 * 接了聊天房间的实时通道，还带着会员权限和「该资源是否支持一起听」的校验。自己造一套
 * 只会得到一个更差而且更容易坏的实现。这里只做一件事：通过 CDP 找到 store，然后派发
 * 页面自己的 action。
 *
 * 所有脚本都是一次性求值，参数在生成脚本时插进去，不跨调用保存状态。
 */

/**
 * 页面使用的房间状态，取自 listenTogether 的状态机。alone 表示没在房间里，
 * togetherOwner 是自己开的房，其余是等待/超时/开关房的中间态。
 */
export type TogetherStatus = "alone" | "opening" | "waiting" | "together" | "togetherOwner" | "closing" | "closed" | "timeout" | "";

/** 房间成员。网易云只在成员变动时推 memberEnter/memberClear，所以要自己攒起来。 */
export type TogetherMember = { userId: string; nickname: string; avatarUrl: string };

export type TogetherState = {
  supported: boolean;
  loggedIn: boolean;
  accountId: string;
  status: TogetherStatus;
  inRoom: boolean;
  isHost: boolean;
  roomId: string;
  chatRoomId: string;
  creatorId: string;
  hostNickname: string;
  hostAvatarUrl: string;
  members: TogetherMember[];
  currentSongId: string;
  songIds: string[];
  playing: boolean;
  positionMs: number;
  localOnly: boolean;
  error: string;
};

/**
 * 读房间状态。
 *
 * 队列的真实位置是 state.playingList.curPlayingList，不在 playing 这个 slice 里。
 * togetherPlayList 是页面自己的房间队列，和本地队列分开。
 */
export const TOGETHER_STATE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  // playing 这个名字 PLAYER_ACCESS_SCRIPT 顶层已经占用了，这里只能换个叫法。
  const state = playerStore?.getState() || {};
  const playState = state.playing || {};
  const host = state.host || {};
  const together = state['async:listenTogether'] || {};
  const togetherList = state['async:listenTogetherPlayList'] || {};
  const room = together.roomInfo || {};
  const collect = list => {
    const ids = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const track = entry && typeof entry === 'object' ? (entry.track || entry) : null;
      const id = Number(track?.id ?? track?.resourceId ?? entry?.resourceId);
      if (!Number.isFinite(id) || id <= 0) continue;
      // 存的是字符串，去重也得拿字符串比，否则同一个 id 会重复进队列。
      const key = String(id);
      if (!ids.includes(key)) ids.push(key);
    }
    return ids;
  };
  const members = [];
  for (const member of Array.isArray(together.roomMembers) ? together.roomMembers : []) {
    if (!member || !member.userId) continue;
    members.push({ userId: String(member.userId), nickname: String(member.nickname || ''), avatarUrl: String(member.avatarUrl || '') });
  }
  const status = String(together.status || '');
  const currentId = Number(playState.resourceTrackId) || 0;
  // 房主也在 roomMembers 里，昵称要从那儿找，slice 本身不带。
  const hostUid = String(host.uid || together.hostUid || '');
  const hostMember = members.find(member => member.userId === hostUid);
  return {
    // 未登录时 host 里拿不到 uid，而建房和上报指令都要靠它。
    supported: Boolean(playerStore),
    loggedIn: Boolean(host.uid) && !host.isAnonymous,
    accountId: hostUid,
    status,
    inRoom: status === 'together' || status === 'togetherOwner',
    isHost: status === 'togetherOwner',
    roomId: String(room.roomId || ''),
    chatRoomId: String(room.chatRoomId || ''),
    creatorId: String(room.creatorId || ''),
    hostNickname: hostMember?.nickname || '',
    hostAvatarUrl: hostMember?.avatarUrl || String(host.avatarUrl || ''),
    members,
    currentSongId: currentId > 0 ? String(currentId) : '',
    songIds: collect(togetherList.playingList || togetherList.curPlayingList),
    playing: playState.playingState === 2,
    positionMs: Math.max(0, Math.round((Number(playState.resourcePosition) || 0) * 1000)),
    // 本地文件没法分享给房间里的人，只能各听各的。
    localOnly: playState.trackFileType === 'local' || playState.resourceType === 'localTrack',
  };
})()`;

/**
 * 建房。target 用当前正在播的这首，和页面底部播放条上那个入口传的是同一个东西。
 */
export const TOGETHER_START_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  const state = playerStore?.getState();
  if (!state) return { ok: false, error: '播放器还没准备好' };
  const host = state.host || {};
  if (!host.uid || host.isAnonymous) return { ok: false, error: '请先在网易云播放器里登录' };
  const cur = state.playing?.curPlaying;
  const trackId = Number(state.playing?.resourceTrackId) || Number(cur?.trackId) || 0;
  if (trackId <= 0) return { ok: false, error: '请先播放一首网易云歌曲' };
  if (state.playing?.trackFileType === 'local' || state.playing?.resourceType === 'localTrack') {
    return { ok: false, error: '本地歌曲不支持一起听' };
  }
  const target = cur && typeof cur === 'object'
    ? cur
    : { resourceType: 'track', resourceId: String(trackId), trackId, track: { id: trackId } };
  playerStore.dispatch({ type: 'async:listenTogether/startListenTogether', payload: { target, refer: 'songplay_more' } });
  return { ok: true };
})()`;

/** 退房。message 是网易云给「为什么退」用的文案，缺省就行。 */
export const TOGETHER_LEAVE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const status = String(playerStore.getState()?.['async:listenTogether']?.status || '');
  if (!status || status === 'alone') return { ok: true };
  playerStore.dispatch({ type: 'async:listenTogether/leaveListenTogether', payload: {} });
  return { ok: true };
})()`;

/**
 * 重新拉一次房间状态。页面自己在登录后也会调，但 Steam 这边重启插件、或用户中途登录的
 * 时候补一次更稳妥。
 */
export const TOGETHER_RESTORE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  playerStore.dispatch({ type: 'async:listenTogether/restore' });
  return { ok: true };
})()`;
