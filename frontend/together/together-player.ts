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

/**
 * 退房。message 是网易云给「为什么退」用的文案，缺省就行。
 *
 * silent 必须带上：页面默认分支会先弹一个「结束将回到正常听歌模式 / 结束并查看记录」的
 * 确认框，只有点「结束」才真的走 leaveIM + leaveRTC + leaveListeningRoom。我们这边是插件
 * 自己的按钮，弹在播放器窗口里用户未必看得见，卡住就会表现为「点了退出没反应」。
 * 页面留的 silent 分支就是干这个的，直接调 v() 收尾。
 */
export const TOGETHER_LEAVE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const status = String(playerStore.getState()?.['async:listenTogether']?.status || '');
  if (!status || status === 'alone') return { ok: true };
  playerStore.dispatch({ type: 'async:listenTogether/leaveListenTogether', payload: { silent: true } });
  return { ok: true };
})()`;

/**
 * 打开播放指令上报（async:listenTogetherPlayStatus.isCanReport）。
 *
 * 页面把 isCanReport 默认设成 false，唯一的开关在 listenTogetherPlayList/playTracks 里：
 * 播房间队列时先关掉、真正切完歌再打开。而房主建房走的是 startModulePlaying 的房主分支
 * （backupPlayList + reportPlayList + reportRequest("force")），整条路根本不经过 playTracks，
 * 于是 isCanReport 一直是 false。后果是 reportRequest 开头那道判断只放行 reason === "force"
 * 的调用——房主除了一开始那一次和每 20 秒一次的心跳 PROGRESS，播放/暂停/切歌全被
 * 「command notReport」日志吞掉，房间里另一个人收到的指令里 targetSongId 又对不上自己正在
 * 播的那首，只能各听各的。
 *
 * 进房之后补一次 true，就是把设计上本来就该打开的那个开关打开。已经开了就不重复派发，
 * 免得每 1.5 秒往页面日志里刷一行 setCanReport。
 */
export const TOGETHER_SYNC_ARM_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const state = playerStore.getState() || {};
  const status = String(state['async:listenTogether']?.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, armed: false };
  if (state['async:listenTogetherPlayStatus']?.isCanReport === true) return { ok: true, armed: false };
  playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: true } });
  return { ok: true, armed: true };
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
