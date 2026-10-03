import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";
import { TOGETHER_PENDING_SCRIPT } from "./together-button.ts";

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
  /** 最近若干次播放状态变化，用来定位是谁在重播。 */
  probe: string[];
  /** 播放栏按钮攒下的动作（start / leave），由 TogetherBridge 取走执行。 */
  action: string;
  error: string;
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
${PROBE_READ}  // 播放栏那个按钮只能记下「用户想建房 / 退房」，真正执行要过 TogetherBridge
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
    probe: probeEvents,
    action: pendingAction,
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
 * 加入房间时上报的 refer。网页版自带的 accept 调用都是把调用方的 refer 原样透传，没有权威取值；
 * 服务端大概率不校验。真机不对再调这一个常量。
 */
const TOGETHER_JOIN_REFER = "invitation";

/**
 * 加入别人的房间。
 *
 * 网页版其实有一整套加入代码（listenTogether.utils.acceptListenTogether），但**没有任何调用方**
 * ——原生 App 收到邀请才走它，而网页版的 IM 是空壳，收不到邀请，也就永远轮不到。这里把那条流程
 * 按同样的顺序自己复刻一遍（跟 TOGETHER_SYNC_PULL_SCRIPT 一样：自己发 weapi + 派页面自己的
 * redux action），绕开 IM。
 *
 * 顺序和页面里一致：room/check 校验可加入 → play/invitation/accept → 回包 data 就是 roomInfo
 * → resetRoomInfo 写进 store → onUpdate 把状态设成 together。最后补一个 restore，让页面自己的
 * 生命周期（心跳、mini 状态）接管——我们只负责把它送进房间，进去之后靠页面本身维持。
 *
 * inviterId 是房主 uid，接受接口必须带，而网页版没有「roomId → 房主 uid」的接口。传空时会拿
 * room/check 的返回碰运气；仍拿不到就让调用方改用带 uid 的完整链接。
 *
 * refer 见 TOGETHER_JOIN_REFER；weapi 这里同样不需要 csrf，一个普通表单 POST 就够。
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
        return { ok: false, error: '房间检查失败：' + (error instanceof Error ? error.message : String(error)) };
      }
      const roomData = check?.data || {};
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
      return { ok: false, error: '加入请求失败：' + (error instanceof Error ? error.message : String(error)) };
    }
    if (!accept || Number(accept.code) !== 200) {
      return { ok: false, error: String(accept?.message || ('加入失败（' + (accept?.code ?? '无响应') + '）')) };
    }
    const roomInfo = accept.data && typeof accept.data === 'object' ? accept.data : {};
    // 回包偶尔缺字段，用我们已知的补上：resetRoomInfo 的 store 校验要 roomId/chatRoomId/creatorId。
    if (!roomInfo.roomId) roomInfo.roomId = targetRoomId;
    if (!roomInfo.creatorId) roomInfo.creatorId = targetInviterId;
    const creatorId = String(roomInfo.creatorId || '');
    playerStore.dispatch({ type: 'async:listenTogether/resetRoomInfo', payload: { roomInfo } });
    playerStore.dispatch({
      type: 'async:listenTogether/onUpdate',
      payload: { status: creatorId && creatorId === ownUid ? 'togetherOwner' : 'together' },
    });
    // 把生命周期交回页面：setStatus 会在页面内部启动心跳/连接时间统计，我们复刻不了那一层。
    playerStore.dispatch({ type: 'async:listenTogether/restore' });
    return { ok: true, roomId: String(roomInfo.roomId || targetRoomId), inviterId: targetInviterId, via };
  })();
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
 * 拉一次房间指令并自己套用。
 *
 * 为什么需要这个：网页版的 YunxinIM 是空壳——subscribeYunXinIMChatRoomMsg 的方法体是
 * `yield () => () => {}`，loginIM / enterRTC 同样什么都不做，所以 onChatRoomMsg 从来没被注册
 * 过。结果是网页版只能发不能收：play/command/report 是 HTTP，服务端广播出去，手机原生端收
 * 得到；可别人发的指令只走 IM，网页版没有接收通道，于是单向同步。
 *
 * 为什么自己发请求而不用页面那个 syncPlayList effect：它是唯一调 sync/playlist/get 的入口，
 * 但顺带做两件会重播的事。
 *   1. setPlayMode —— 只要房间模式和自己不一致就派 playing/switchPlayingMode，会重新解析
 *      当前曲目（探针实测 mode 从 playRandom 被改成 playCycle）。
 *   2. playTracks —— displayList.result 为空时无条件执行（forceUpdatePlaylist 管不到这条
 *      分支），它会 playing/play {clear:true, playId:房间指令的 targetSongId}。而我们的
 *      队列里往往没有对方的歌，服务端给回来的 displayList.result 就是空的，于是每 1.5 秒
 *      按对方的歌从 0 重播一遍，探针里 pos 恒为 0、id 来回跳就是这么来的。
 * 这两个副作用 dva effect 里的 put 不经过 store.dispatch，拦不住；只能不用它。
 *
 * 顺带说明：页面整个 bundle 里没有 csrf_token / __csrf，这个 weapi 只靠 cookie 加
 * x-music-web-os 头，所以一个普通表单 POST 就够，不用复刻 eapi 那套加密。
 *
 * 播放状态和进度也不继续交给 onRoomMsg：那个 effect 里同一个 targetSongId 被要求成两种类型
 * ——门禁是 `b === d`（要数字，跟 curPlaying.resourceId），updateProgress 是
 * `a.targetSongId === String(u.trackId)`（要字符串），两边不可能同时成立。于是非切歌类指令
 * 要么被门禁悄悄丢掉，要么在门禁通过后走进 playByTrackId，而那个 effect 无条件派发
 * `playing/setPlaying({playingState: Playing})`，于是「别人暂停」会把我们强制续播。
 *
 * 另外要滤掉自己发的指令：我们这边开着上报，服务端记的就是我们的指令，不滤的话每次轮询都会
 * 拿自己的指令回来跟自己打架。
 */
export const TOGETHER_SYNC_PULL_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const together = playerStore.getState()?.['async:listenTogether'] || {};
  const status = String(together.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, applied: false };
  const roomId = String(together.roomInfo?.roomId || '');
  if (!roomId) return { ok: true, applied: false };
  const storeKey = '__NEMusicOnSteamSyncPull';
  const own = globalThis[storeKey] || (globalThis[storeKey] = { last: '', at: 0 });
  const PLAYING = 2;
  const SWITCH = ['GOTO', 'NEXT', 'PREVIOUS'];
  return (async () => {
    let command = null;
    try {
      const response = await fetch('https://interface.music.163.com/api/listen/together/sync/playlist/get', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
        body: 'roomId=' + encodeURIComponent(roomId),
      });
      const json = await response.json();
      command = json?.data?.playCommand || null;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!command) return { ok: true, applied: false, reason: '没拿到指令' };
    const fingerprint = JSON.stringify(command);
    // 同一条指令别每个 tick 都往里灌。5 秒后放行一次，「拖回同一个进度」这类真需要重新
    // 应用的场景才不会被永久吃掉。
    if (fingerprint === own.last && Date.now() - own.at < 5000) {
      return { ok: true, applied: false, reason: '指令没变' };
    }
    own.last = fingerprint;
    own.at = Date.now();
    const state = playerStore.getState() || {};
    const sender = String(command.userId ?? '');
    const hostUid = String(state.host?.uid ?? '');
    if (sender && hostUid && sender === hostUid) return { ok: true, applied: false, reason: '自己发的' };
    const type = String(command.commandType ?? '');
    const playing = state.playing || {};
    const cur = playing.curPlaying || {};
    const target = String(command.targetSongId ?? '');
    if (SWITCH.includes(type)) {
      // 切歌走页面自己的按曲目切换：它在队列里按 id 找，找到就换，不会清空队列。
      // （原来的 onRoomMsg 在这种情况下什么都不做，因为门禁要求指令的歌等于当前在播的歌。）
      playerStore.dispatch({
        type: 'async:listenTogetherPlayList/playByTrackId',
        payload: { id: target, playStatus: PLAYING, commandType: type },
      });
      return { ok: true, applied: true, via: 'playByTrackId', commandType: type };
    }
    const sameSong = !!target && (target === String(cur.trackId ?? '') || target === String(cur.resourceId ?? ''));
    if (!sameSong) return { ok: true, applied: false, reason: '不是同一首歌' };
    if (type === 'PAUSE') {
      if (playing.playingState === PLAYING) playerStore.dispatch({ type: 'playing/pause' });
      return { ok: true, applied: true, via: 'playing/pause', commandType: type };
    }
    if (type === 'PLAY') {
      if (playing.playingState !== PLAYING) playerStore.dispatch({ type: 'playing/resume' });
      return { ok: true, applied: true, via: 'playing/resume', commandType: type };
    }
    if (type === 'PROGRESS') {
      const progress = Number(command.progress);
      if (Number.isInteger(progress) && progress >= 0) {
        playerStore.dispatch({ type: 'playing/setPlayingPosition', payload: { duration: progress / 1000 } });
      }
      return { ok: true, applied: true, via: 'playing/setPlayingPosition', commandType: type };
    }
    return { ok: true, applied: false, reason: '不认识的指令 ' + type };
  })();
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
 */
export const TOGETHER_ADOPT_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const status = String(playerStore.getState()?.['async:listenTogether']?.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, sent: false };
  const cur = playerStore.getState()?.playing?.curPlaying;
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
 * 重新拉一次房间状态。页面自己在登录后也会调，但 Steam 这边重启插件、或用户中途登录的
 * 时候补一次更稳妥。
 */
export const TOGETHER_RESTORE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  playerStore.dispatch({ type: 'async:listenTogether/restore' });
  return { ok: true };
})()`;
