import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";
import { TOGETHER_PENDING_SCRIPT } from "./together-button.ts";
import { ROOM_HOST_HELPER } from "./together-role.ts";
import { ROOM_QUEUE_HELPER } from "./queue.ts";
import { REMEMBERED_ROOM, ROOM_EXIT_HELPER, ROOM_STATUS_HELPER, SAVE_DIAGNOSTICS_HELPER } from "./room-scripts.ts";
export { TOGETHER_SYNC_ARM_SCRIPT, TOGETHER_SYNC_PULL_SCRIPT } from "./sync-player.ts";

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
 * 脚本通过 CDP 求值，房间信息、同步基准和待确认的本地操作保存在页面上。
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
  /** 最近若干次播放状态变化，用来定位是谁在重播。 */
  probe: string[];
  /** 播放栏按钮攒下的动作（start / leave），由 TogetherBridge 取走执行。 */
  action: string;
  /** 上次加入房间时 room/check 和 play/invitation/accept 的实际回包形状，
   *  脱敏后的摘要，用来验证「creatorId 在哪」和「refer 是否被校验」。 */
  diagnostic: string;
};

/**
 * 装一个探子，记录播放相关状态的每一次变化。
 *
 * 为什么需要：一起听的接收链路是网页版没有的（YunxinIM 是空壳），我们只能自己轮询 HTTP 再自己
 * 套用指令。到底是哪一步在反复重播，光看代码看不出来——dva effect 里的 put 又不经过
 * store.dispatch，连拦都拦不住。订阅 store 记录签名变化是唯一能把「谁在动」摆到台面上的办法，
 * position 一栏能直接看出进度是不是被反复拉回同一个点。
 *
 * 只记签名变化，不记每次 setState，队列里最多留 120 条。
 */
export const TOGETHER_PROBE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const key = '__NEMusicOnSteamProbe';
  const existing = globalThis[key];
  if (existing && existing.store === playerStore) return { ok: true, installed: false, events: existing.events.length };
  const probe = globalThis[key] = { store: playerStore, events: [], last: null };
  const stamp = () => {
    const p = playerStore.getState()?.playing || {};
    const cur = p.curPlaying || {};
    return [
      p.playingMode || '',
      p.playingState,
      p.resourceTrackId ?? cur.resourceId ?? cur.id ?? '',
      Math.round(Number(p.resourcePosition) * 1000) || 0,
    ].join('|');
  };
  probe.last = stamp();
  playerStore.subscribe(() => {
    const now = stamp();
    if (now === probe.last) return;
    const [mode, state, id, pos] = now.split('|');
    probe.events.push(\`\${mode} st=\${state} id=\${id} pos=\${pos}\`);
    if (probe.events.length > 120) probe.events.splice(0, probe.events.length - 120);
    probe.last = now;
  });
  return { ok: true, installed: true, events: probe.events.length };
})()`;

/** 从 TOGETHER_STATE_SCRIPT 里顺带取，不用再多一次 CDP 往返。 */
const PROBE_READ = `  const probeEvents = Array.isArray(globalThis.__NEMusicOnSteamProbe?.events)
    ? globalThis.__NEMusicOnSteamProbe.events.slice(-24)
    : [];`;

/**
 * 上次 join 脚本留下的诊断。只放响应形状，不含 token/session/uid 等隐私字段。
 * 在 TOGETHER_STATE_SCRIPT 里读回来，设置页能看到。
 */
const READ_DIAGNOSTICS = `  const diagKey = '__NEMusicOnSteamDiagnostics';
  const diagnostics = globalThis[diagKey] || null;
  // 读走即清空，免得一直显示上一次的历史数据。
  if (globalThis[diagKey]) globalThis[diagKey] = null;`;

/**
 * 读房间状态。
 *
 * 队列的真实位置是 state.playingList.curPlayingList，不在 playing 这个 slice 里。
 * togetherPlayList 是页面自己的房间队列，和本地队列分开。
 */
export const TOGETHER_STATE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_HOST_HELPER}
${ROOM_EXIT_HELPER}
  if (playerStore && roomExited()) normalizeRoomExit();
  const exited = roomExited();
${REMEMBERED_ROOM}
  // playing 这个名字 PLAYER_ACCESS_SCRIPT 顶层已经占用了，这里只能换个叫法。
  const state = playerStore?.getState() || {};
  const playState = state.playing || {};
  const host = state.host || {};
  const together = state['async:listenTogether'] || {};
  const togetherList = state['async:listenTogetherPlayList'] || {};
  const room = together.roomInfo || {};
${ROOM_QUEUE_HELPER}
  const members = [];
${PROBE_READ}${READ_DIAGNOSTICS}  // 播放栏那个按钮只能记下「用户想建房 / 退房」，真正执行要过 TogetherBridge
  // （身份补丁必须在建房前打好），所以在这里把动作捎带回去，取走即清空。
  const pendingAction = (() => {
    try {
      // TOGETHER_PENDING_SCRIPT 本身就是立即执行完的值，直接当表达式用；再套一层调用
      // 就变成拿返回的字符串当函数调，抛错被这里吞成空串，按钮会静默失灵。
      return ${TOGETHER_PENDING_SCRIPT};
    } catch (error) {
      return '';
    }
  })();
  for (const member of !exited && Array.isArray(together.roomMembers) ? together.roomMembers : []) {
    if (!member || !member.userId) continue;
    members.push({ userId: String(member.userId), nickname: String(member.nickname || ''), avatarUrl: String(member.avatarUrl || '') });
  }
  const status = exited ? 'alone' : String(together.status || '');
  const currentId = Number(playState.resourceTrackId) || 0;
  // 房主也在 roomMembers 里，昵称要从那儿找，slice 本身不带。
  const hostUid = String(host.uid || together.hostUid || '');
  const creatorId = exited ? '' : String(room.creatorId || remembered?.creatorId || '');
  const hostMember = members.find(member => member.userId === hostUid);
  return {
    // 未登录时 host 里拿不到 uid，而建房和上报指令都要靠它。
    supported: Boolean(playerStore),
    loggedIn: Boolean(host.uid) && !host.isAnonymous,
    accountId: hostUid,
    status,
    inRoom: status === 'together' || status === 'togetherOwner',
    isHost: !exited && (status === 'together' || status === 'togetherOwner')
      && isRoomHost(together, String(host.uid || ''), String(room.roomId || remembered?.roomId || '')),
    // 页面那份 roomInfo 会被冲掉，房间号退回我们自己存的那份，见 ROOM_STATUS_HELPER 的 rebindRoom。
    roomId: exited ? '' : String(room.roomId || remembered?.roomId || ''),
    chatRoomId: exited ? '' : String(room.chatRoomId || remembered?.chatRoomId || ''),
    creatorId,
    hostNickname: hostMember?.nickname || '',
    hostAvatarUrl: hostMember?.avatarUrl || String(host.avatarUrl || ''),
    members,
    currentSongId: currentId > 0 ? String(currentId) : '',
    songIds: exited ? [] : roomQueueOf(togetherList),
    playing: playState.playingState === 2,
    positionMs: Math.max(0, Math.round((Number(playState.resourcePosition) || 0) * 1000)),
    // 本地文件没法分享给房间里的人，只能各听各的。
    localOnly: playState.trackFileType === 'local' || playState.resourceType === 'localTrack',
    probe: probeEvents,
    action: pendingAction,
    // diagnostic 是脱敏摘要（字符串），空就表示最近没加入过房间。
    diagnostic: diagnostics ? JSON.stringify(diagnostics) : '',
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
  globalThis.__NEMusicOnSteamRoomExit = null;
  globalThis.__NEMusicOnSteamRoom = null;
  globalThis.__NEMusicOnSteamSyncPull = null;
  const captureCreatedRoom = () => {
    if (globalThis.__NEMusicOnSteamRoomExit?.store === playerStore) return;
    const fresh = playerStore.getState() || {};
    const together = fresh['async:listenTogether'] || {};
    const info = together.roomInfo && typeof together.roomInfo === 'object' ? together.roomInfo : {};
    const status = String(together.status || '');
    const roomId = String(info.roomId || together.roomId || '');
    const previous = globalThis.__NEMusicOnSteamRoom;
    if (!previous?.createdByUs || (previous.roomId && previous.roomId !== roomId)) return;
    if (!roomId || ['alone', 'closing', 'closed', 'timeout'].includes(status)) return;
    globalThis.__NEMusicOnSteamRoom = {
      roomId,
      creatorId: String(info.creatorId || fresh.host?.uid || host.uid || ''),
      ownerUid: String(fresh.host?.uid || host.uid),
      chatRoomId: String(info.chatRoomId || ''),
      roomInfo: info,
      createdByUs: true,
      pending: false,
      expiresAt: 0,
    };
  };
  globalThis.__NEMusicOnSteamRoom = {
    roomId: '',
    creatorId: String(host.uid),
    ownerUid: String(host.uid),
    chatRoomId: '',
    roomInfo: null,
    createdByUs: true,
    pending: true,
    expiresAt: Date.now() + 30000,
  };
  if (typeof playerStore.subscribe === 'function' && !playerStore.__NEMusicOnSteamCreatedRoomObserver) {
    playerStore.__NEMusicOnSteamCreatedRoomObserver = playerStore.subscribe(captureCreatedRoom) || true;
  }
  playerStore.dispatch({ type: 'async:listenTogether/startListenTogether', payload: { target, refer: 'songplay_more' } });
  captureCreatedRoom();
  return { ok: true };
})()`;

/**
 * 加入房间时上报的 refer。第三方实现（QListenTogether / NeteaseCloudMusicApi）都用
 * `inbox_invite`，这里跟着走；服务端大概率不校验，但没理由自己编一个。
 */
const TOGETHER_JOIN_REFER = "inbox_invite";

/**
 * 加入别人的房间。
 *
 * 网页版其实有一整套加入代码（listenTogether.utils.acceptListenTogether），但**没有任何调用方**
 * ——原生 App 收到邀请才走它，而网页版的 IM 是空壳，收不到邀请，也就永远轮不到。这里把那条流程
 * 按同样的顺序自己复刻一遍（跟 TOGETHER_SYNC_PULL_SCRIPT 一样：自己发明文表单 + 派页面自己的
 * redux action），绕开 IM。
 *
 * 顺序和页面里一致：room/check 校验可加入 → play/invitation/accept → 回包 data 就是 roomInfo
 * → resetRoomInfo 写进 store → onUpdate 把状态设成 together。最后补一个 restore，让页面自己的
 * 生命周期（心跳、mini 状态）接管——我们只负责把它送进房间，进去之后靠页面本身维持。
 *
 * **accept 之后必须拿 status/get 对账。** accept 回 200 不等于服务端真的登记了这次加入：本地
 * status 是我们自己派 onUpdate 写进去的，写多写少它都显示「在房间里」。真机实测就是这里骗人的
 * 人——本地显示进了房间、成员列表里只有一个没有头像的假人（那其实是我们自己，服务端只给了
 * 一个 uid），对方手机上根本没出现有人加入，后面所有同步自然全对不上。对账不通过就如实报失败，
 * 别再假装进房成功。
 *
 * inviterId 是房主 uid，接受接口必须带，而网页版没有「roomId → 房主 uid」的接口。传空时会拿
 * room/check 的返回碰运气；仍拿不到就让调用方改用带 uid 的完整链接。
 *
 * 这些接口都不用加密：实测明文表单里 roomId 为空会回 400 参数错误、有值会回业务码，说明服务端
 * 直接读表单字段；cookie 由浏览器自己带，csrf 也不需要。
 */
export const TOGETHER_JOIN_SCRIPT = (roomId: string, inviterId: string): string => `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const joinState = playerStore.getState() || {};
  const joinHost = joinState.host || {};
  if (!joinHost.uid || joinHost.isAnonymous) return { ok: false, error: '请先在网易云播放器里登录' };
  const joinStatus = String(joinState['async:listenTogether']?.status || '');
  if (joinStatus === 'together' || joinStatus === 'togetherOwner') {
    return { ok: false, error: '已经在房间里了，请先退出当前房间' };
  }
  const ownUid = String(joinHost.uid || '');
  const targetRoomId = ${JSON.stringify(roomId)};
  let targetInviterId = ${JSON.stringify(inviterId)};
  // 存诊断用，见 READ_DIAGNOSTICS / SAVE_DIAGNOSTICS_HELPER。
  let diagCheck = null;
  let diagAccept = null;
  let diagStatus = null;
${ROOM_STATUS_HELPER}
${SAVE_DIAGNOSTICS_HELPER}
  const postForm = async (path, body) => {
    const response = await fetch('https://interface.music.163.com' + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
      body,
    });
    return response.json();
  };
  return (async () => {
    if (!targetRoomId) return { ok: false, error: '房间码不能为空' };
    let via = 'code';
    if (!targetInviterId) {
      let check;
      try {
        check = await postForm('/api/listen/together/room/check', 'roomId=' + encodeURIComponent(targetRoomId));
      } catch (error) {
        return { ok: false, error: '房间检查失败：' + (error instanceof Error ? error.message : String(error)), retryable: true };
      }
      const roomData = check?.data || {};
      diagCheck = roomData;
      if (roomData.joinable === false) {
        return { ok: false, error: String(roomData.copywriting || '房间不可加入') };
      }
      targetInviterId = String(roomData.creatorId || roomData.roomInfo?.creatorId || '');
      via = 'check';
      if (!targetInviterId) return { ok: false, error: '房间码里没有房主，请用完整的邀请链接' };
    }
    let accept;
    try {
      accept = await postForm('/api/listen/together/play/invitation/accept',
        'refer=' + encodeURIComponent(${JSON.stringify(TOGETHER_JOIN_REFER)})
        + '&roomId=' + encodeURIComponent(targetRoomId)
        + '&inviterId=' + encodeURIComponent(targetInviterId));
    } catch (error) {
      return { ok: false, error: '加入请求失败：' + (error instanceof Error ? error.message : String(error)), retryable: true };
    }
    diagAccept = accept?.data ?? null;
    if (!accept || Number(accept.code) !== 200) {
      // 5xx 和 429 是可以重试的，4xx 是参数/权限问题，重试也没用。
      const code = Number(accept?.code ?? 0);
      const retryable = code >= 500 || code === 429;
      return { ok: false, error: String(accept?.message || ('加入失败（' + (accept?.code ?? '无响应') + '）')), retryable };
    }
    // 对账：服务端到底认不认这次加入。roomInfo 只用来填 store，认不认看 status/get。
    let server = { inRoom: false, roomId: '', creatorId: '', members: [] };
    try {
      const statusJson = await fetchRoomStatus(targetRoomId);
      diagStatus = statusJson?.data ?? null;
      server = parseRoomStatus(statusJson);
    } catch (error) {
      // 对账请求本身失败不当成加入失败：接受已经回 200 了，只是没法确认。
      server = { inRoom: false, roomId: '', creatorId: '', members: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (!server.inRoom) {
      saveDiagnostics(diagCheck, diagAccept, diagStatus, ${JSON.stringify(TOGETHER_JOIN_REFER)});
      return {
        ok: false,
        error: server.error
          ? '加入后无法向网易云确认房间状态：' + server.error
          : '网易云没有登记这次加入（房间号可能已失效，或对方已经退出房间）',
        retryable: false,
      };
    }
    const roomInfo = accept.data && typeof accept.data === 'object' ? accept.data : {};
    // 回包偶尔缺字段，用 status/get 和我们已知的补上：resetRoomInfo 的 store 校验要
    // roomId/chatRoomId/creatorId，缺任何一个页面后面的生命周期都会当成没房间。
    if (!roomInfo.roomId) roomInfo.roomId = server.roomId || targetRoomId;
    if (!roomInfo.creatorId) roomInfo.creatorId = server.creatorId || targetInviterId;
    if (!roomInfo.chatRoomId) roomInfo.chatRoomId = server.chatRoomId || '';
    const creatorId = String(roomInfo.creatorId || '');
    // 先存一份：页面 store 里的 roomInfo 会被 restore 之后的流程冲掉（真机上加入后房间号就读不到了）。
    rememberRoom(roomInfo);
    playerStore.dispatch({ type: 'async:listenTogether/resetRoomInfo', payload: { roomInfo } });
    playerStore.dispatch({
      type: 'async:listenTogether/onUpdate',
      payload: { status: creatorId && creatorId === ownUid ? 'togetherOwner' : 'together' },
    });
    // 把生命周期交回页面：setStatus 会在页面内部启动心跳/连接时间统计，我们复刻不了那一层。
    playerStore.dispatch({ type: 'async:listenTogether/restore' });
    saveDiagnostics(diagCheck, diagAccept, diagStatus, ${JSON.stringify(TOGETHER_JOIN_REFER)});
    return {
      ok: true,
      roomId: String(roomInfo.roomId || targetRoomId),
      inviterId: targetInviterId,
      via,
      serverInRoom: true,
      // 服务端名单通常只有 uid（头像昵称要另外查），设置页照实显示，别编。
      serverMembers: server.members.length,
    };
  })();
})()`;

/**
 * 退房。message 是网易云给「为什么退」用的文案，缺省就行。
 *
 * silent 必须带上：页面默认分支会先弹一个「结束将回到正常听歌模式 / 结束并查看记录」的
 * 确认框，只有点「结束」才真的走 leaveIM + leaveRTC + leaveListeningRoom。我们这边是插件
 * 自己的按钮，弹在播放器窗口里用户未必看得见，卡住就会表现为「点了退出没反应」。
 * 页面留的 silent 分支就是干这个的，直接调 v() 收尾。
 *
 * 另外补一次 /api/listen/together/end 的 POST：页面自己的 leaveListeningRoom 里确实有 end
 * 调用，但它拿的是 saga 里 try 块的 roomInfo，catch/wrap 里 rec 已经没了就走不到。
 * 直接再发一次确保服务端及时释房，不靠超时。
 */
export const TOGETHER_LEAVE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_EXIT_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const roomId = exitTogetherRoom();
  if (roomId) {
    void fetch('https://interface.music.163.com/api/listen/together/end', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
      body: 'roomId=' + encodeURIComponent(roomId),
    }).catch(() => {});
  }
  return { ok: true };
})()`;

export const TOGETHER_CLEAR_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_EXIT_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  exitTogetherRoom();
  return { ok: true };
})()`;

/**
 * 有人进来了，让对方 adopt 房主正在播的歌。
 *
 * 为什么需要：正常客户端是靠 USER_JOIN_IN 房间消息触发的——房主收到后重新 reportPlayList，
 * 新加入的人下一轮 syncPlayList 就会把房间队列当成自己的队列播。USER_JOIN_IN 走 IM，而网页版
 * 的 IM 是空壳，所以房主永远不知道谁进来了，对方就一直播着自己那首，等切一次歌才对上。
 *
 * 这里没有等 IM，而是在检测到成员数变化（TOGETHER_STATE_SCRIPT 已经把 roomMembers 读出来了）
 * 之后主动做房主该做的那三件事，和 startModulePlaying 的房主分支一致：
 *   backupPlayList → reportPlayList → reportRequest(PROGRESS, force)
 *
 * 最后那句 force 很关键：只有 force 能绕过 isCanReport 那道门（见 TOGETHER_SYNC_ARM_SCRIPT），
 * 把房间的 playCommand 立刻指到房主当前这首，对方拉到的 targetSongId 才是房主在听的那首。
 *
 * 只有房主能做这三件事。backupPlayList 是拿**自己的本地队列**去覆盖房间队列，成员做一遍就把
 * 房主的歌单顶掉了；成员要做的是反过来跟着房主（见 TOGETHER_SYNC_PULL_SCRIPT）。
 */
export const TOGETHER_ADOPT_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_HOST_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const state = playerStore.getState() || {};
  const together = state['async:listenTogether'] || {};
  const status = String(together.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, sent: false };
  const roomId = String(together.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
  if (!isRoomHost(together, String(state.host?.uid || ''), roomId)) {
    return { ok: true, sent: false, reason: '只有房主能定房间队列' };
  }
  const cur = state.playing?.curPlaying;
  const songId = String(cur?.trackId ?? cur?.resourceId ?? '');
  if (!songId) return { ok: true, sent: false, reason: '房主自己还没在播' };
  playerStore.dispatch({ type: 'async:listenTogetherPlayList/backupPlayList', payload: { type: 'init' } });
  playerStore.dispatch({ type: 'async:listenTogetherPlayList/reportPlayList', payload: {} });
  playerStore.dispatch({
    type: 'async:listenTogetherPlayStatus/reportRequest',
    payload: { command: 'PROGRESS', reason: 'force' },
  });
  return { ok: true, sent: true, songId };
})()`;

/**
 * 通知服务端「这里有状态变化，推给房间里的其他客户端」。
 *
 * 为什么需要这个：网页版的播放指令（play/command/report）是 HTTP，服务端收得到也记得住，
 * 但**不会主动推 IM 给手机原生端**——通知这件事走的是 IM，而网页版 IM 是空壳，于是手机那
 * 边（房主或成员）收不到我们的变化，只能等它自己下一轮 poll。sync/notice 就是那个「告诉
 * 服务端该推了」的 HTTP 触发点。
 *
 * 参数没有权威来源（和 room/check 一样属于「未验证」接口），先用 roomId 最小可用；服务端
 * 要是嫌不够，会把报文塞进 error 带回来，设置页能看到。测量用：成功/失败都往回带，不静默。
 */
export const TOGETHER_SYNC_NOTICE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const together = playerStore.getState()?.['async:listenTogether'] || {};
  const status = String(together.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, sent: false };
  const roomId = String(together.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
  if (!roomId) return { ok: true, sent: false };
  return (async () => {
    try {
      const response = await fetch('https://interface.music.163.com/api/listen/together/sync/notice', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
        body: 'roomId=' + encodeURIComponent(roomId),
      });
      const json = await response.json();
      if (!json || Number(json.code) !== 200) {
        return { ok: true, sent: false, error: String(json?.message || ('code ' + (json?.code ?? '无响应'))) };
      }
      return { ok: true, sent: true };
    } catch (error) {
      return { ok: true, sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();
})()`;

/**
 * 重新拉一次房间状态。页面自己在登录后也会调，但 Steam 这边重启插件、或用户中途登录的
 * 时候补一次更稳妥。
 */
export const TOGETHER_RESTORE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_EXIT_HELPER}
${ROOM_STATUS_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  if (roomExited()) {
    normalizeRoomExit();
    return { ok: true, restored: false, reason: '已经退出房间' };
  }
  const saved = rememberedRoom();
  const status = String(playerStore.getState()?.['async:listenTogether']?.status || '');
  if (saved?.roomId && status !== 'together' && status !== 'togetherOwner') {
    return (async () => {
      try {
        const server = parseRoomStatus(await fetchRoomStatus(saved.roomId));
        if (roomExited() || saved !== rememberedRoom()) return { ok: true, restored: false };
        if (server.code !== 200) return { ok: true, restored: false, reason: '房间状态未确认' };
        if (!server.inRoom) {
          exitTogetherRoom();
          return { ok: true, restored: false, reason: '房间已结束' };
        }
        playerStore.dispatch({ type: 'async:listenTogether/restore' });
        return { ok: true, restored: true };
      } catch (error) {
        return { ok: true, restored: false, reason: '房间状态未确认' };
      }
    })();
  }
  playerStore.dispatch({ type: 'async:listenTogether/restore' });
  return { ok: true };
})()`;
