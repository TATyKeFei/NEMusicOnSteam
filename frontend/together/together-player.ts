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
 * 脚本通过 CDP 求值，房间信息、同步基准和待确认的本地操作保存在页面上。
 */

/**
 * 页面使用的房间状态，取自 listenTogether 的状态机。alone 表示没在房间里，
 * togetherOwner 是自己开的房，其余是等待/超时/开关房的中间态。
 */
export type TogetherStatus = "alone" | "opening" | "waiting" | "together" | "togetherOwner" | "closing" | "closed" | "timeout" | "";

/** 房间成员。网易云只在成员变动时推 memberEnter/memberClear，所以要自己攒起来。 */
export type TogetherMember = { userId: string; nickname: string; avatarUrl: string };

/**
 * 服务端自己的房间状态（/api/listen/together/status/get）。
 *
 * 为什么非看它不可：页面 store 里的 `status: together` 是**我们自己**派 onUpdate 写进去的，
 * accept 到底有没有被服务端登记，页面不知道。实测就是这里骗人的——本地显示进了房间、成员列表里
 * 只有一个没有头像的假人（那是我们自己，服务端只给了个 uid），而对方手机上根本没出现有人加入。
 * 服务端的 inRoom 和 roomUsers 才是这件事的真话。
 */
export type RoomStatus = {
  inRoom: boolean;
  roomId: string;
  creatorId: string;
  members: TogetherMember[];
};

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
 * 读一次服务端自己的房间状态。这段是纯 fetch + 解析，join 脚本和拉取脚本共用。
 *
 * 明文表单 POST 就够：实测 `roomId=` 空值会回 400 参数错误、`roomId=<真实房间>` 会回业务码，
 * 说明服务端确实在读这个表单字段，不吃 eapi 加密那一套（一起听这几条接口都是这样，
 * cookie 由浏览器自己带）。
 *
 * 回包形状按 data.roomInfo / data.room / data 顶层三种认，成员列表在 roomUsers / userList /
 * members / 顶层 roomUsers 几个位置都翻一遍——服务端换字段名不止一次。
 */
/**
 * 读我们自己存的那份房间信息。页面 store 里那份会被冲掉，房间号只能从这里兜底，
 * 见 ROOM_STATUS_HELPER 里的 rememberRoom / rebindRoom。
 */
const REMEMBERED_ROOM = `  const remembered = globalThis.__NEMusicOnSteamRoom || null;`;

const ROOM_EXIT_HELPER = `  const roomExited = () => globalThis.__NEMusicOnSteamRoomExit?.store === playerStore;
  const normalizeRoomExit = () => {
    const exit = globalThis.__NEMusicOnSteamRoomExit;
    if (!exit || exit.store !== playerStore || exit.clearing) return;
    exit.clearing = true;
    try {
      const exitState = playerStore.getState() || {};
      const exitRoom = exitState['async:listenTogether'] || {};
      const status = String(exitRoom.status || '');
      if ((status && status !== 'alone') || Object.keys(exitRoom.roomInfo || {}).length
        || exitRoom.roomMembers?.length || exitRoom.otherMember) {
        playerStore.dispatch({
          type: 'async:listenTogether/onUpdate',
          payload: { status: 'alone', roomInfo: null, roomMembers: [], otherMember: null },
        });
      }
      if (playerStore.getState()?.['async:listenTogetherPlayStatus']?.isCanReport) {
        playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } });
      }
    } finally { exit.clearing = false; }
  };
  const exitTogetherRoom = () => {
    const exitRoom = playerStore.getState()?.['async:listenTogether'] || {};
    const roomId = String(exitRoom.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
    const status = String(exitRoom.status || '');
    globalThis.__NEMusicOnSteamRoomExit = { store: playerStore, roomId, clearing: false };
    globalThis.__NEMusicOnSteamRoom = null;
    globalThis.__NEMusicOnSteamSyncPull = null;
    if (typeof playerStore.subscribe === 'function' && !playerStore.__NEMusicOnSteamExitObserver) {
      playerStore.__NEMusicOnSteamExitObserver = playerStore.subscribe(normalizeRoomExit) || true;
    }
    try {
      if (roomId || (status && status !== 'alone')) {
        playerStore.dispatch({ type: 'async:listenTogether/leaveListenTogether', payload: { silent: true } });
      }
    } finally { normalizeRoomExit(); }
    return roomId;
  };`;

/**
 * 补房间成员的昵称和头像。
 *
 * 服务端的 roomUsers 只给 uid，昵称和头像要去用户资料接口取（/api/v1/user/detail/<uid>，不用登录）。
 * 没有这一步设置页就只能显示一串 uid，也就是真机上「对方头像显示不出来」的原因。
 * 结果按 uid 缓存在页面上，一个房间最多补五次，之后再也不发请求。
 */
const PROFILE_HELPER = `  const fetchProfiles = async uids => {
    const found = {};
    for (const uid of uids) {
      try {
        const response = await fetch('https://interface.music.163.com/api/v1/user/detail/' + encodeURIComponent(uid), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
          body: '',
        });
        const json = await response.json();
        const profile = json?.profile;
        if (Number(json?.code) === 200 && profile && profile.nickname) {
          found[uid] = { nickname: String(profile.nickname), avatarUrl: String(profile.avatarUrl || '') };
        }
      } catch (error) {
        // 补不到就留着空昵称，不能因为一个头像把整个同步打断。
      }
    }
    return found;
  };
  const fillProfiles = async (members, background = false) => {
    const cache = globalThis.__NEMusicOnSteamProfiles || (globalThis.__NEMusicOnSteamProfiles = {});
    const pending = globalThis.__NEMusicOnSteamProfilesPending || (globalThis.__NEMusicOnSteamProfilesPending = {});
    const attempts = globalThis.__NEMusicOnSteamProfileAttempts || (globalThis.__NEMusicOnSteamProfileAttempts = {});
    const own = String(playerStore.getState()?.host?.uid ?? '');
    const wanted = members
      .filter(member => !member.nickname && member.userId !== own && !cache[member.userId]
        && !pending[member.userId] && (!attempts[member.userId] || Date.now() - attempts[member.userId] >= 30000))
      .map(member => member.userId)
      .slice(0, 5);
    const fill = () => {
      for (const member of members) {
        const hit = cache[member.userId];
        if (!hit) continue;
        member.nickname = member.nickname || hit.nickname;
        member.avatarUrl = member.avatarUrl || hit.avatarUrl;
      }
    };
    if (wanted.length) {
      const request = fetchProfiles(wanted).then(found => { Object.assign(cache, found); fill(); })
        .finally(() => { for (const uid of wanted) delete pending[uid]; });
      for (const uid of wanted) {
        pending[uid] = request;
        attempts[uid] = Date.now();
      }
    }
    if (!background) await Promise.all(members.map(member => pending[member.userId]).filter(Boolean));
    fill();
    return members;
  };`;

const ROOM_STATUS_HELPER = `  /**
   * 只看字段名和类型，不带值——昵称、头像、别人的 uid 都不能从这儿漏出去。
   * 一起听的回包形状换过好几次字段名，形状本身就是要留在设置页上的东西。
   */
  const shapeOf = obj => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (Array.isArray(value)) out[key] = 'array:' + value.length;
      else if (value && typeof value === 'object') out[key] = 'object:' + Object.keys(value).length;
      else out[key] = typeof value;
    }
    return out;
  };
  const fetchRoomStatus = async roomId => {
    const response = await fetch('https://interface.music.163.com/api/listen/together/status/get', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
      body: 'roomId=' + encodeURIComponent(String(roomId || '')),
    });
    return await response.json();
  };
  const parseRoomStatus = json => {
    const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : {};
    const room = data.roomInfo && typeof data.roomInfo === 'object' ? data.roomInfo
      : (data.room && typeof data.room === 'object' ? data.room : data);
    const raw = Array.isArray(room.roomUsers) ? room.roomUsers
      : (Array.isArray(room.userList) ? room.userList
        : (Array.isArray(room.members) ? room.members
          : (Array.isArray(data.roomUsers) ? data.roomUsers : [])));
    const members = [];
    for (const user of raw) {
      const userId = String(user?.userId ?? user?.id ?? '');
      if (!userId) continue;
      members.push({
        userId,
        nickname: String(user?.nickname ?? user?.name ?? ''),
        avatarUrl: String(user?.avatarUrl ?? user?.avatar ?? ''),
      });
    }
    const roomId = String(room.roomId ?? '');
    // 老一点的回包没有 inRoom 字段，有房间号就算在房间里。
    const inRoom = data.inRoom === true || data.inRoom === 'true' || (data.inRoom == null && !!roomId);
    return {
      code: Number(json?.code ?? 0),
      inRoom,
      roomId,
      // 页面 setRoomInfo 的入库校验要 roomId/chatRoomId/creatorId 三个齐了才写 store，
      // accept 的回包偶尔缺 chatRoomId，于是 roomInfo 一直补不回去（真机上「房间信息丢了」
      // 很可能就是这一项缺着）。服务端 status/get 的 roomInfo 里有，拿回来补上。
      chatRoomId: String(room.chatRoomId ?? ''),
      creatorId: String(room.creatorId ?? ''),
      members,
      shape: shapeOf(data),
      roomShape: shapeOf(room),
    };
  };
  /**
   * 我们自己留一份房间信息。页面 store 里的 roomInfo 会丢——真机上就是这样：加入后 status 还是
   * together（我们自己派 onUpdate 写的），roomInfo 却成了空的，于是房间号读不出来、拉取循环整个
   * 不跑。房间号和身份认定不能只靠页面那份。
   */
  const rememberRoom = roomInfo => {
    globalThis.__NEMusicOnSteamRoomExit = null;
    globalThis.__NEMusicOnSteamRoom = {
      roomId: String(roomInfo?.roomId ?? ''),
      creatorId: String(roomInfo?.creatorId ?? ''),
      ownerUid: String(roomInfo?.creatorId ?? ''),
      chatRoomId: String(roomInfo?.chatRoomId ?? ''),
      roomInfo,
      createdByUs: false,
    };
  };
  const rememberedRoom = () => globalThis.__NEMusicOnSteamRoom || null;
  /** 页面那份丢了就按我们留的再写回去；顺手把 status 摆回together，页面自己的心跳等生命周期靠它。 */
  const rebindRoom = (roomId, chatRoomId) => {
    if (globalThis.__NEMusicOnSteamRoomExit?.store === playerStore) return false;
    const saved = rememberedRoom();
    if (!saved?.roomId) return false;
    // 补 chatRoomId：setRoomInfo 缺它就直接不写 store，补几次都是白补（见 parseRoomStatus）。
    if (chatRoomId && saved.roomInfo && !saved.roomInfo.chatRoomId) saved.roomInfo.chatRoomId = chatRoomId;
    const current = String(playerStore.getState()?.['async:listenTogether']?.roomInfo?.roomId ?? '');
    if (current === saved.roomId) return false;
    playerStore.dispatch({ type: 'async:listenTogether/resetRoomInfo', payload: { roomInfo: saved.roomInfo } });
    return true;
  };`;

/**
 * 存诊断的 helper。join 脚本内部用，不导出——这些字段只在加入过程中有意义。
 *
 * 记录：
 *   roomCheck：room/check 的实际回包 data 字段（看 creatorId 到底在不在）
 *   invitationAccept：accept 的实际回包 data 字段（看 roomInfo 形状和额外字段）
 *   statusGet：加入之后 status/get 的回包（看服务端到底认不认这次加入）
 *   refer：本次 accept 使用的 refer 值
 */
const SAVE_DIAGNOSTICS_HELPER = `  const saveDiagnostics = (checkData, acceptData, statusData, refer) => {
    // 只记录「字段名 + 值类型」，绝不把真实值带回来（昵称/头像/其它人 uid 都是隐私）。
    // 递归一层：roomInfo 是个对象，「creatorId 到底在不在顶层」正需要往下看一层。
    const describe = (obj, depth) => {
      if (!obj || typeof obj !== 'object') return typeof obj;
      const out = {};
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (depth <= 0) {
          if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
          else if (value === null) out[key] = null;
          else if (typeof value === 'string') out[key] = '<string>';
          else if (Array.isArray(value)) out[key] = '<array:' + value.length + '>';
          else if (typeof value === 'object') out[key] = '<object:' + Object.keys(value).length + '>';
          else out[key] = '<' + typeof value + '>';
        } else {
          out[key] = value && typeof value === 'object' ? { '…': describe(value, depth - 1) } : '<' + typeof value + '>';
        }
      }
      return out;
    };
    const diag = {
      at: Date.now(),
      roomCheck: describe(checkData, 1),
      invitationAccept: describe(acceptData, 1),
      statusGet: describe(statusData, 1),
      refer,
    };
    globalThis.__NEMusicOnSteamDiagnostics = diag;
  };`;

/**
 * 读房间状态。
 *
 * 队列的真实位置是 state.playingList.curPlayingList，不在 playing 这个 slice 里。
 * togetherPlayList 是页面自己的房间队列，和本地队列分开。
 */
export const TOGETHER_STATE_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
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
  /**
   * 一份歌单列表 → 字符串 id 列表。两种摆法都认：纯数字（页面的房间歌单就是 displayTrackIds 这种
   * 纯 id 数组，真机实测）和 track 对象（服务端那种）。存的是字符串，去重也得拿字符串比。
   */
  const collect = list => {
    const ids = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const track = entry && typeof entry === 'object' ? (entry.track || entry.songInfo || entry) : null;
      const id = Number(
        track?.id ?? track?.resourceId ?? track?.songId
        ?? (typeof entry === 'object' ? null : entry),
      );
      if (!Number.isFinite(id) || id <= 0) continue;
      const key = String(id);
      if (!ids.includes(key)) ids.push(key);
    }
    return ids;
  };
  /** 房间队列在 slice 里好几个字段名都可能摆着，哪个有内容用哪个，见 pull 脚本里的同名函数。 */
  const roomQueueOf = slice => {
    const list = slice || {};
    for (const name of [
      'displayTrackIds', 'playingList', 'curPlayingList', 'list', 'queue', 'roomPlayingList', 'tracks',
      'randomTrackIds', 'displayList', 'randomList',
    ]) {
      const ids = collect(list[name]);
      if (ids.length) return ids;
    }
    return [];
  };
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
  const rememberedOwnRoom = !exited && remembered?.createdByUs === true
    && (!remembered?.roomId || !room.roomId || String(remembered.roomId) === String(room.roomId));
  const creatorId = exited ? '' : String(room.creatorId || remembered?.creatorId || '');
  const hostMember = members.find(member => member.userId === hostUid);
  return {
    // 未登录时 host 里拿不到 uid，而建房和上报指令都要靠它。
    supported: Boolean(playerStore),
    loggedIn: Boolean(host.uid) && !host.isAnonymous,
    accountId: hostUid,
    status,
    inRoom: status === 'together' || status === 'togetherOwner',
    isHost: status === 'togetherOwner' || rememberedOwnRoom
      || (!!creatorId && !!hostUid && creatorId === hostUid),
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
    if (!roomId || ['alone', 'closing', 'closed', 'timeout'].includes(status)) return;
    globalThis.__NEMusicOnSteamRoom = {
      roomId,
      creatorId: String(info.creatorId || fresh.host?.uid || host.uid || ''),
      ownerUid: String(host.uid),
      chatRoomId: String(info.chatRoomId || ''),
      roomInfo: info,
      createdByUs: true,
      pending: false,
      expiresAt: 0,
    };
    if (previous?.roomId === roomId) return;
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
 * 调整播放指令上报开关（async:listenTogetherPlayStatus.isCanReport）：房主打开，成员关掉。
 *
 * 页面把 isCanReport 默认设成 false，唯一的开关在 listenTogetherPlayList/playTracks 里：
 * 播房间队列时先关掉、真正切完歌再打开。而房主建房走的是 startModulePlaying 的房主分支
 * （backupPlayList + reportPlayList + reportRequest("force")），整条路根本不经过 playTracks，
 * 于是 isCanReport 一直是 false。后果是 reportRequest 开头那道判断只放行 reason === "force"
 * 的调用——房主除了一开始那一次和每 20 秒一次的心跳 PROGRESS，播放/暂停/切歌全被
 * 「command notReport」日志吞掉，房间里另一个人收到的指令里 targetSongId 又对不上自己正在
 * 播的那首，只能各听各的。
 *
 * 成员那边反过来要显式关掉。一起听里套用指令这条路是单向的：成员一开着上报，页面每次
 * 套用房主的歌（playTracks/pause/resume）都会触发 handlePlayingChange，把「刚收到的指令」
 * 当本地改动再发一遍，服务端的 playCommand 被回声顶掉，两边互相把进度按回 0。
 *
 * 关掉不等于单向同步就到此为止：成员在网页上自己切歌/暂停/续播，由 TOGETHER_SYNC_PULL_SCRIPT
 * 安装的 store 订阅立即认出，再用 reason:'force' 走 reportRequest 补报（force 是这道门唯一放行的
 * 理由）——套用不回声、本地改动不丢，两边各走各的门。playTracks 收尾会把开关拨回 true
 * （页面自己的行为），所以 dispatch 钩子和 store 订阅会立刻关回来，ARM 仍然兜底对齐。
 *
 * 已经是对的值就不重复派发，免得每 1.5 秒往页面日志里刷一行 setCanReport。
 */
export const TOGETHER_SYNC_ARM_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  if (globalThis.__NEMusicOnSteamRoomExit?.store === playerStore) return { ok: true, armed: false };
  const state = playerStore.getState() || {};
  const status = String(state['async:listenTogether']?.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, armed: false };
  const wanted = status === 'togetherOwner';
  if (state['async:listenTogetherPlayStatus']?.isCanReport === wanted) return { ok: true, armed: false };
  playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: wanted } });
  return { ok: true, armed: true, canReport: wanted };
})()`;

/**
 * 拉一次房间快照（歌单 + 最后一条播放指令），把房间队列对齐过来，再把指令套用到本地播放器。
 *
 * 为什么需要这个：网页版的 YunxinIM 是空壳——subscribeYunXinIMChatRoomMsg 的方法体是
 * `yield () => () => {}`，loginIM / enterRTC 同样什么都不做，所以 onChatRoomMsg 从来没被注册
 * 过。结果是网页版只能发不能收：play/command/report 是 HTTP，服务端广播出去，手机原生端收
 * 得到；可别人发的指令只走 IM，网页版没有接收通道，于是单向同步。
 *
 * 为什么自己发请求而不用页面那个 syncPlayList effect：它是唯一调 sync/playlist/get 的入口，
 * 但顺带做两件会重播的事，我们只借它「把房间队列写进 store」这一件。
 *   1. setPlayMode —— 只要房间模式和自己不一致就派 playing/switchPlayingMode，会重新解析
 *      当前曲目（探针实测 mode 从 playRandom 被改成 playCycle）。这个躲不掉，采用队列就得
 *      付这一次代价。
 *   2. playTracks —— **displayList.result 为空时无条件执行**（forceUpdatePlaylist 管不到这条
 *      分支），它会 playing/play {clear:true, playId:房间指令的 targetSongId}。房间队列空着
 *      的时候每 1.5 秒按对方的歌从 0 重播一遍，探针里 pos 恒为 0、id 来回跳就是这么来的。
 *      所以 forceUpdatePlaylist 只在「服务端真的回了一份队列」时才派，空队列一律不派。
 * 这两个副作用在 dva effect 里是 put，不经过 store.dispatch，拦不住；只能控制什么时候派它。
 *
 * 加入房间的人各听各的，根子在这里：房主侧是靠 startModulePlaying 的房主分支（backupPlayList
 * + reportPlayList + reportRequest("force")）把自己那首和整份队列写上服务端的，之后每次切歌
 * 发 GOTO/NEXT/PREV。而成员这一侧原来只做两件事：
 *   · 收到 GOTO/NEXT/PREV 才切歌。可房主的心跳和开局那一条都是 **PROGRESS**（PROGRESS 的语义
 *     就是「我在听这首、听到这个进度」），成员这边因为「不是同一首歌」把指令丢掉，于是从头到尾
 *     没有一条能让成员换歌——各自听各自那首，一直听到底。
 *   · 队列整个没往房间里搬过。playByTrackId 是在房间队列里按 id 找歌的，成员队列是空的，
 *     就算真收到 GOTO 也找不到歌。
 * 现在这一版把两件事都补上：房间队列用 syncPlayList 采用过来（限速、同一份只问一次），
 * 「房主在听的歌不是我这首」一律当成切歌处理（不限指令类型），切完再对进度和播放状态。
 *
 * 播放状态和进度不交给 onRoomMsg：那个 effect 里同一个 targetSongId 被要求成两种类型——门禁是
 * `b === d`（要数字，跟 curPlaying.resourceId），updateProgress 是
 * `a.targetSongId === String(u.trackId)`（要字符串），两边不可能同时成立。于是非切歌类指令
 * 要么被门禁悄悄丢掉，要么在门禁通过后走进 playByTrackId，而那个 effect 无条件派发
 * `playing/setPlaying({playingState: Playing})`，于是「别人暂停」会把我们强制续播。
 *
 * 另外要滤掉自己发的指令：房主开着上报（见 TOGETHER_SYNC_ARM_SCRIPT），服务端记的就是房主
 * 自己的指令；成员本地切歌时我们会用 reason:'force' 补一条上去，落地之后服务端记的也变成
 * 自己，不滤的话每次轮询都会拿自己的指令回来跟自己打架。
 *
 * 反过来，本地自己动了播放（网页上手动切歌、暂停、继续、拖进度条）也由这个脚本负责送出去：
 * 页面自己的上报路（handlePlayingChange → reportRequest）被 isCanReport 关死了，开关不能随便
 * 打开（成员一开，套用指令就会把「刚收到的指令」当本地改动发回去，回声互相顶），所以由这里
 * 通过 store 订阅立即认出「这是用户自己动的」，轮询比对仍然兜底，再用 reason:'force' 走页面那套
 * assembleRequestParam / cmdFilter / HTTP 补报——切歌/暂停/续播见「双向同步的上半段」，
 * 拖进度条见下面 dispatch 钩子那段（页面自己那条拖动上报没带 ids，被 cmdFilter 拦死）。
 *
 * 每个 tick 先问一次 status/get：服务端说我们不在房间里，就不要再拿指令了。本地 status 是我们
 * 自己写进去的，假房间（accept 没被服务端登记）会一直假装在房间里，不拦住的话它只会一直报
 * 「不是同一首歌」。
 */
export const TOGETHER_SYNC_PULL_SCRIPT = `(() => {
  ${PLAYER_ACCESS_SCRIPT}
${ROOM_STATUS_HELPER}
${PROFILE_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  if (globalThis.__NEMusicOnSteamRoomExit?.store === playerStore) return { ok: true, applied: false, reason: '已经退出房间' };
  const together = playerStore.getState()?.['async:listenTogether'] || {};
  const status = String(together.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, applied: false };
  // 房间号先从页面 store 里读，读不到就用我们自己存的那份。真机上页面那份会被冲掉，而这里
  // 一旦拿不到房间号就直接返回，整个同步就静默停掉了——所以不能只信页面。
  const roomId = String(together.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
  if (!roomId) return { ok: true, applied: false, reason: '没有房间号' };
  const isHost = status === 'togetherOwner';
  const storeKey = '__NEMusicOnSteamSyncPull';
  let own = globalThis[storeKey];
  if (!own || own.version !== 2 || own.store !== playerStore || own.roomId !== roomId) {
    own = globalThis[storeKey] = {
      version: 2,
      store: playerStore, roomId, last: '', at: 0, queue: '', queueAt: 0, membersAt: 0,
      busy: false, revision: 0, pending: null, serverSeq: 0, handled: false,
      remoteDepth: 0, remote: null, intent: null, knownSongs: {},
    };
  }
  if (own.busy) return { ok: true, applied: false, reason: '上一轮同步尚未结束' };
  const activeRoom = () => {
    const fresh = playerStore.getState()?.['async:listenTogether'] || {};
    return globalThis[storeKey] === own
      && ['together', 'togetherOwner'].includes(String(fresh.status || ''))
      && String(fresh.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '') === roomId;
  };
  const cancelled = () => ({ ok: true, applied: false, reason: '房间已变更，忽略旧快照' });
  const REPORT_RETRY = 1000;
  const REPORT_WAIT = 10000;
  own.dispatchRemote = action => {
    own.remoteDepth += 1;
    try { return playerStore.dispatch(action); }
    finally { own.remoteDepth -= 1; }
  };
  own.reportLocal = payload => {
    if (!activeRoom()) return;
    own.revision += 1;
    own.pending = {
      payload, at: Date.now(), reportAt: Date.now(), seen: own.lastRemote || '', sequence: own.serverSeq,
      positions: Number.isFinite(payload.position) ? [payload.position] : [],
    };
    own.intent = {
      target: payload.ids[1], position: payload.position ?? (Number(playerStore.getState()?.playing?.resourcePosition) || 0),
      playStatus: payload.playStatus, at: Date.now(), remoteTarget: own.lastRemoteTarget || '', guardUntil: 0,
    };
    playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/reportRequest', payload });
  };
  /**
   * 拖进度条的上报钩子（双向同步里「进度」那一半）。
   *
   * 页面自己有一条拖动上报路 onManualSeekEnd → reportRequest{PROGRESS}，但它没传 ids，
   * assembleRequestParam 把 targetSongId 拼成 "null"，cmdFilter 的队列门直接把它拦掉——
   * 连房主的拖动都报不出去。isCanReport 那道门（成员还关着）只是第二道。
   *
   * 所以在 dispatch 上装一个钩子：认 'playing/setPlayingPosition'（网页拖动结束就是派这个，
   * 页面日志里叫 dragEnd, setPosition），只要不是我们自己套用进度时打过标记的那一下，就
   * 补一条带 ids 的 PROGRESS 上报。标记记在 store 对象上，和 applyPosition 共用——
   * 我们套用房间进度那一下会被认出来跳过，不产生回声。
   * 装一次就够（钩子自己有旗标），且只在房间里装：房主也受益（页面自己那条被 cmdFilter 拦着）。
   */
  const seekMark = playerStore.__NEMusicOnSteamSeekMark || (playerStore.__NEMusicOnSteamSeekMark = { action: null });
  if (playerStore.dispatch.__NEMusicOnSteamSyncHookVersion !== 2) {
    const original = playerStore.dispatch.bind(playerStore);
    const hooked = action => {
      if (action?.type === 'async:listenTogetherPlayStatus/setCanReport'
        && action.payload?.isCanReport && playerStore.getState()?.['async:listenTogether']?.status === 'together') {
        return original({ ...action, payload: { ...action.payload, isCanReport: false } });
      }
      if (action && action.type === 'playing/setPlayingPosition') {
        const duration = Number(action.payload?.duration);
        const ours = action === seekMark.action;
        if (ours) {
          seekMark.action = null;
        } else if (Number.isFinite(duration) && duration >= 0) {
          const fresh = playerStore.getState() || {};
          const playingState = fresh.playing || {};
          const cur = playingState.curPlaying || {};
          const id = String(cur.trackId ?? cur.resourceId ?? '');
          const sync = globalThis[storeKey];
          const room = fresh['async:listenTogether'] || {};
          const activeId = String(room.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
          const staleRemote = sync?.remote && Date.now() < sync.remote.until && sync.remote.revision < sync.revision
            && id === sync.remote.target && id !== sync.intent?.target;
          if (id && ['together', 'togetherOwner'].includes(String(room.status || ''))
            && sync?.store === playerStore && sync.roomId === activeId && !sync.remoteDepth && !staleRemote) {
            sync.reportLocal({ command: 'PROGRESS', position: duration, reason: 'force', ids: [id, id], playStatus: playingState.playingState });
          }
        }
      }
      if (action?.type === 'playing/setPlayingPosition') {
        seekMark.action = action;
        try { return original(action); }
        finally { seekMark.action = null; }
      }
      return original(action);
    };
    hooked.__NEMusicOnSteamSeekHooked = true;
    hooked.__NEMusicOnSteamSyncHookVersion = 2;
    playerStore.dispatch = hooked;
  }
  const PLAYING = 2;
  // 服务端的枚举是 PREV，页面里出现过 PREVIOUS，两个都认。
  const SWITCH = ['GOTO', 'NEXT', 'PREV', 'PREVIOUS'];
  /** 两次队列对齐之间至少隔这么久，免得页面自己那套 effect 被我们打成风暴。 */
  const QUEUE_GAP = 3000;
  /** syncPlayList 是异步 effect，要等它把队列落库，最多等 1.2 秒。 */
  const QUEUE_WAIT = 12;
  /** playTracks 要联网把房间歌单的 id 解析成 track，最多等这么久，换好就立即结束。 */
  const TRACK_WAIT = 1500;
  /** 其余几档只是派个 action，短暂等页面把歌换上，换好就立即结束。 */
  const SWITCH_WAIT = 400;
  const queueSlice = () => playerStore.getState()?.['async:listenTogetherPlayList'] || {};
  /**
   * 页面 store 里的房间队列。
   *
   * 关键是这个 slice 把房间歌单存成**纯 id 数组** displayTrackIds（真机实测 12 首），而不是
   * track 对象；curPlayingList 那一路是空的。之前只按对象解析 id，数组里的数字全被判成非法值
   * 丢掉，于是设置页一直报「本地 0 首」、playByTrackId 也永远按 id 找不到歌。
   *
   * 字段名照样探一串（网易云在这个 slice 上换过名字），认不出来时把整个 slice 的形状报回设置页，
   * 下次照着真实字段名补就行，不用再猜。
   */
  const localQueue = () => {
    const list = queueSlice();
    const raw = [
      'displayTrackIds', 'playingList', 'curPlayingList', 'list', 'queue', 'roomPlayingList', 'tracks',
      'randomTrackIds', 'displayList', 'randomList',
    ].map(name => list[name]).find(value => Array.isArray(value) && value.length > 0) || [];
    return songIds(raw);
  };
  /**
   * 一份歌单列表 → 字符串 id 列表。三种摆法都认：纯数字、纯数字字符串、track 对象
   * （对象还可能裹一层 track / songInfo / song）。服务端和页面两边各用一种摆法，混着来就一起认。
   */
  const songIds = raw => {
    const ids = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      const track = entry && typeof entry === 'object' ? (entry.track || entry.songInfo || entry.song || entry) : null;
      const id = Number(
        track?.id ?? track?.trackId ?? track?.resourceId ?? track?.songId
        ?? (typeof entry === 'object' ? null : entry),
      );
      if (!Number.isFinite(id) || id <= 0) continue;
      const key = String(id);
      if (!ids.includes(key)) ids.push(key);
    }
    return ids;
  };
  /** 服务端给回来的队列：displayList/randomList.result，可能裹一层 result。 */
  const remoteQueue = playlist => {
    if (!playlist || typeof playlist !== 'object') return [];
    const mode = String(playlist.playMode || '').toUpperCase();
    // playMode 决定取哪一份：随机播放用 randomList，顺序播放用 displayList。哪个是数组就用哪个。
    const picked = /RANDOM|SHUFFLE/.test(mode) ? playlist.randomList : playlist.displayList;
    const fallback = playlist.displayList ?? playlist.randomList;
    const raw = Array.isArray(picked) ? picked
      : (Array.isArray(picked?.result) ? picked.result
        : (Array.isArray(fallback?.result) ? fallback.result : (Array.isArray(fallback) ? fallback : [])));
    return songIds(raw);
  };
  /**
   * 页面 playTracks 吃的那一份：syncPlayList 内部传的永远是 displayList.result（不分播放模式），
   * 所以追房主的歌也照这个来；displayList 空了才退到 randomList。id 必须是字符串——
   * getCommonPrivilege 拿 e.split('_') 解析，传数字进去 effect 直接炸。
   */
  const displayQueue = playlist => {
    if (!playlist || typeof playlist !== 'object') return [];
    const raw = Array.isArray(playlist.displayList) ? playlist.displayList
      : (Array.isArray(playlist.displayList?.result) ? playlist.displayList.result
        : (Array.isArray(playlist.randomList?.result) ? playlist.randomList.result
          : (Array.isArray(playlist.randomList) ? playlist.randomList : [])));
    return songIds(raw);
  };
  /** 当前在播的歌。resourceId 和 trackId 都是字符串化的 id，任一能用就行。 */
  const currentSong = () => {
    const cur = playerStore.getState()?.playing?.curPlaying || {};
    return String(cur.trackId ?? cur.resourceId ?? '');
  };
  if (!own.lastSong) {
    own.lastSong = currentSong();
    own.lastState = playerStore.getState()?.playing?.playingState === PLAYING ? 'playing' : 'paused';
  }
  own.knownSongs[own.lastSong] = true;
  own.finishRepair = () => {
    const intent = own.intent;
    if (!intent || currentSong() !== intent.target) return;
    own.repairing = null;
    const position = Math.max(0, intent.position + (intent.playStatus === PLAYING ? (Date.now() - intent.at) / 1000 : 0));
    const action = { type: 'playing/setPlayingPosition', payload: { duration: position } };
    seekMark.action = action;
    own.dispatchRemote(action);
    const playing = playerStore.getState()?.playing || {};
    if ((playing.playingState === PLAYING) !== (intent.playStatus === PLAYING)) {
      own.dispatchRemote({ type: intent.playStatus === PLAYING ? 'playing/resume' : 'playing/pause' });
    }
  };
  const observe = () => {
    if (!activeRoom()) return;
    const fresh = playerStore.getState() || {};
    const playing = fresh.playing || {};
    const song = currentSong();
    if (!song) return;
    const lastSong = own.lastSong;
    const lastState = own.lastState;
    const playState = playing.playingState === PLAYING ? 'playing' : 'paused';
    own.knownSongs[song] = true;
    own.lastSong = song;
    own.lastState = playState;
    if (own.remoteDepth || fresh['async:listenTogether']?.status !== 'together') return;
    if (own.repairing?.target === song && Date.now() < own.repairing.until) {
      own.finishRepair();
      return;
    }
    const remote = own.remote;
    if (remote && Date.now() < remote.until && song === remote.target) {
      const intent = own.intent;
      if (remote.revision < own.revision && intent && song !== intent.target
        && (!own.repairing || Date.now() >= own.repairing.until)) {
        own.repairing = { target: intent.target, until: Date.now() + 3000 };
        own.dispatchRemote({
          type: 'async:listenTogetherPlayList/playByTrackId',
          payload: { id: intent.target, playStatus: intent.playStatus, commandType: 'GOTO' },
        });
        own.finishRepair();
      }
      return;
    }
    if (song !== lastSong && lastSong && localQueue().includes(song)) {
      own.reportLocal({ command: 'GOTO', reason: 'force', ids: [lastSong, song], position: 0, playStatus: playing.playingState });
    } else if (song === lastSong && lastState && playState !== lastState
      && (!remote || remote.target !== song || Date.now() >= remote.until)) {
      own.reportLocal({ command: playState === 'paused' ? 'PAUSE' : 'PLAY', reason: 'force', ids: [song, song], playStatus: playing.playingState });
    }
  };
  own.observe = () => {
    try { observe(); }
    finally {
      const fresh = playerStore.getState() || {};
      if (activeRoom() && !own.closingReport && fresh['async:listenTogether']?.status === 'together'
        && fresh['async:listenTogetherPlayStatus']?.isCanReport) {
        own.closingReport = true;
        try { own.dispatchRemote({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } }); }
        finally { own.closingReport = false; }
      }
    }
  };
  if (typeof playerStore.subscribe === 'function' && !playerStore.__NEMusicOnSteamSyncObserver) {
    playerStore.__NEMusicOnSteamSyncObserver = playerStore.subscribe(() => {
      const sync = globalThis[storeKey];
      if (sync?.store === playerStore) sync.observe?.();
    }) || true;
  }
  own.busy = true;
  return (async () => {
    // 先问服务端自己我们在不在房间里。页面 store 里的 status 是我们上次派 onUpdate 写进去的，
    // 服务端要是没登记这次加入，它照样显示「在房间里」——这种假房间怎么同步都没用。
    let server = { inRoom: false, roomId: '', creatorId: '', chatRoomId: '', members: [] };
    try {
      server = parseRoomStatus(await fetchRoomStatus(roomId));
      if (server.code !== 200) server.failed = true;
    } catch (error) {
      // 问不到就当没查到，不因此中断同步：这一轮只是少一份旁证。
      server = { inRoom: false, roomId: '', creatorId: '', chatRoomId: '', members: [], failed: true };
    }
    if (!activeRoom()) return cancelled();
    // 顺手把丢掉的 roomInfo 写回去（带上服务端的 chatRoomId 兜底）：页面自己的心跳、队列、
    // mini 状态都靠它，缺了手机那边也会觉得我们掉线。
    const rebound = server.inRoom && !server.failed ? rebindRoom(roomId, server.chatRoomId || '') : false;
    if (server.inRoom) await fillProfiles(server.members, true);
    if (!activeRoom()) return cancelled();
    if (!server.inRoom || server.failed) {
      return {
        ok: true,
        applied: false,
        reason: server.failed ? '问不到服务端房间状态' : '服务端说我们不在这个房间里',
        serverInRoom: false,
        serverChecked: !server.failed,
        serverMembers: server.members.length,
        serverUsers: server.members.slice(0, 20),
        serverRoomId: server.roomId,
        serverShape: server.shape || {},
        serverRoomShape: server.roomShape || {},
        queue: 0,
        local: 0,
        target: '',
        follow: currentSong(),
        aligned: false,
      };
    }
    /**
     * 把「对方是谁」补回页面。playTracks 的第一步 getCommonPrivilege 拿 otherMember 才肯去拉
     * 房间歌单的播放权限，otherMember 是空的话它直接返回 undefined，playTracks 只会走到
     * 「暂停 + 进度归零 + 弹提示」那条分支——歌永远换不上，进度永远是 0（真机探针就是这个样子）。
     *
     * 官方那条路是 roomInfo.roomUsers → setRoomInfo → memberEnter → otherSideChange；我们加入
     * 时的 roomInfo 常常没带 roomUsers，页面自己的 restore 又不一定跑得到，所以用服务端 status/get
     * 的名单补一次。roomMembers 已经有人就只补一个 otherSideChange（memberEnter 会重新查一遍资料）。
     */
    let otherSide = 'missing';
    const pageTogether = playerStore.getState()?.['async:listenTogether'] || {};
    if (pageTogether.otherMember) otherSide = 'page';
    else if (server.members.length && Date.now() - (own.membersAt || 0) >= 5000) {
      own.membersAt = Date.now();
      const roomMembers = Array.isArray(pageTogether.roomMembers) ? pageTogether.roomMembers : [];
      if (roomMembers.length) {
        playerStore.dispatch({ type: 'async:listenTogether/otherSideChange', payload: { force: true } });
      } else {
        playerStore.dispatch({
          type: 'async:listenTogether/memberEnter',
          payload: { users: server.members.map(member => ({ userId: String(member.userId), nickname: member.nickname, avatarUrl: member.avatarUrl })) },
        });
      }
      otherSide = 'sent';
    }
    let json = null;
    try {
      const response = await fetch('https://interface.music.163.com/api/listen/together/sync/playlist/get', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-music-web-os': 'web3' },
        body: 'roomId=' + encodeURIComponent(roomId),
      });
      json = await response.json();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!activeRoom()) return cancelled();
    await fillProfiles(server.members, true);
    const data = json?.data && typeof json.data === 'object' ? json.data : {};
    const command = data.playCommand || null;
    const songs = remoteQueue(data.playlist);
    /** playTracks 和诊断都围绕房主这首；先算出来，scene() 也要用。 */
    const target = String(command?.targetSongId ?? '');
    /**
     * 本地在播什么先读出来，同时把上一轮的读数（own.lastSong/lastState）留作比对基准，
     * 读完立刻把基准更新成这一轮的。双向同步的上半段全靠这对读数认「本地自己动了」
     * （见下面的上报段）；基准记在追歌/套用**之前**，套用改的是这一轮之后的事，下一轮
     * 开头读到的自然是套用完的样子。真正套用成功的那几条路（settle）会再补记一次。
     */
    const state = playerStore.getState() || {};
    const playing = state.playing || {};
    const cur = playing.curPlaying || {};
    const current = String(cur.trackId ?? cur.resourceId ?? '');
    const paused = playing.playingState !== PLAYING;
    const prevSong = String(own.lastSong || '');
    const prevState = String(own.lastState || '');
    own.lastSong = current;
    own.lastState = paused ? 'paused' : 'playing';
    /**
     * 成员的上报窗口每一 tick 开头都关上。playTracks 收尾 1 秒后会把 isCanReport 拨回 true
     * （页面自己的行为，settle 关得再勤也晚它一步，之后 '指令没变' 的返回又会跳过 settle），
     * 窗口开着，页面套用指令触发的 handlePlayingChange 就会把回声发回房间——手机端会因此
     * 被顶回旧指令（切歌同步看起来「手机没跟上 web」多半就是它）。房主不开这个头：页面对
     * 房主本来就要开着（见 ARM 注释）。
     */
    if (!isHost && state['async:listenTogetherPlayStatus']?.isCanReport) {
      playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } });
    }
    let aligned = false;
    /** 回给设置页的现场信息：服务端房间状态、房间队列几首、房主在听什么、我们在听什么。 */
    const scene = () => {
      const fresh = playerStore.getState() || {};
      const list = fresh['async:listenTogetherPlayList'] || {};
      return {
        rebound,
        serverInRoom: server.inRoom,
        serverMembers: server.members.length,
        serverShape: server.shape || {},
        serverRoomShape: server.roomShape || {},
        // 服务端给的是权威名单。昵称头像常常是空的（那边只查得到 uid），照实带回去，空就是空。
        serverUsers: server.members.slice(0, 20),
        serverRoomId: server.roomId,
        queue: songs.length,
        local: localQueue().length,
        queueShape: shapeOf(queueSlice()),
        localShape: shapeOf(fresh.playingList || {}),
        target,
        // 房主这首到底进没进本地队列。reason 全靠它分叉，见切歌失败那几行。
        localHas: target ? localQueue().includes(target) : false,
        follow: currentSong(),
        aligned,
        // 页面认不认识对方（otherMember）。认不得时权限列表必然是空的，playTracks 只会暂停。
        otherSide,
        privileges: Array.isArray(list.commonPrivilegeList) ? list.commonPrivilegeList.length : 0,
      };
    };
    const seen = command ? JSON.stringify(command) : '';
    const sender = String(command?.userId ?? '');
    const hostUid = String(state.host?.uid ?? '');
    const sequence = Number(command?.serverSeq) || 0;
    const outOfOrder = sequence > 0 && sequence < own.serverSeq;
    if (!outOfOrder) {
      own.lastRemote = seen;
      own.lastRemoteTarget = target;
      if (sequence > 0) own.serverSeq = sequence;
    }
    /**
     * 双向同步的上半段：本地（网页上）自己动了播放——切歌、暂停、续播——就上报给房间。
     *
     * 为什么不由页面自己报：页面那条路 handlePlayingChange → reportRequest 要 isCanReport
     * 为 true 才放行，而这个开关被刻意拨在 false（见 TOGETHER_SYNC_ARM_SCRIPT）——因为页面
     * 套用我们拉来的指令时也走同一条上报路，开着它会把「刚收到的指令」原样发回去，服务端的
     * playCommand 被回声顶掉，进度互相按回 0。所以套用一律关着（不回声），用户自己动的那一下
     * 由这里用 reason:'force' 补票——force 是 reportRequest 里唯一能绕过 isCanReport 的理由，
     * 其余照走页面自己的 assembleRequestParam / cmdFilter / HTTP 全套（cmdFilter 会把「歌不
     * 在房间队列里」的上报挡掉，和官方一个待遇）。
     *
     * 比对基准是本轮开头记的 own.lastSong/lastState：
     *   · 歌变了、且变到的不是服务端那首 → 本地切歌（或房间队列自己走到下一首）→ 报 GOTO，
     *     position 传 0 和官方 handlePlayingChange 报切歌一致；
     *   · 播放状态变了、且和服务端指令说的不一致（只在同一首上才算数）→ 本地暂停/续播 →
     *     报 PAUSE/PLAY。状态和服务端一致说明刚是我们自己套用完的，不算本地改动。
     * 房主不走这条：页面对房主本来就是开着上报的，handlePlayingChange 自己会报。
     */
    if (!isHost && prevSong) {
      const serverPaused = /PAUSE/i.test(String(command?.playStatus || ''));
      const pendingTarget = own.pending?.payload?.ids?.[1] || '';
      const expectedPaused = own.pending ? own.pending.payload.playStatus !== PLAYING : serverPaused;
      if (current && current !== prevSong && (current !== target || (pendingTarget && current !== pendingTarget))) {
        if (localQueue().includes(current)) {
          own.reportLocal({ command: 'GOTO', reason: 'force', ids: [prevSong, current], position: 0, playStatus: playing.playingState });
          return { ...scene(), ok: true, applied: false, reported: 'GOTO', reason: '本地切了歌，已上报给房间' };
        }
        return { ...scene(), ok: true, applied: false, reason: '本地这首歌不在房间队列里，上报不了' };
      }
      if (current && prevState && (current === target || current === pendingTarget)
        && paused !== (prevState === 'paused') && paused !== expectedPaused) {
        const reported = paused ? 'PAUSE' : 'PLAY';
        own.reportLocal({ command: reported, reason: 'force', ids: [current, current], playStatus: playing.playingState });
        return { ...scene(), ok: true, applied: false, reported, reason: paused ? '本地暂停了，已上报给房间' : '本地继续播了，已上报给房间' };
      }
    }
    if (own.pending) {
      const pending = own.pending;
      const payload = pending.payload;
      const acknowledged = !outOfOrder && sender && sender === hostUid && target === payload.ids[1]
        && (pending.sequence > 0 ? sequence > pending.sequence : seen !== pending.seen)
        && (payload.command === 'GOTO'
          || (payload.command === 'PROGRESS' && pending.positions.some(position => Math.abs(Number(command?.progress) - position * 1000) < 1500))
          || (['PAUSE', 'PLAY'].includes(payload.command)
            && /PAUSE/i.test(String(command?.playStatus || '')) === (payload.command === 'PAUSE')));
      if (acknowledged || Date.now() - pending.at >= REPORT_WAIT) {
        if (acknowledged && own.intent) own.intent.guardUntil = Date.now() + 1500;
        own.pending = null;
      } else {
        if (Date.now() - pending.reportAt >= REPORT_RETRY) {
          pending.reportAt = Date.now();
          const fresh = playerStore.getState()?.playing || {};
          const matching = currentSong() === payload.ids[1];
          const position = matching ? Math.max(0, Number(fresh.resourcePosition) || 0)
            : Math.max(0, own.intent.position + (own.intent.playStatus === PLAYING ? (Date.now() - own.intent.at) / 1000 : 0));
          const retry = ['GOTO', 'PROGRESS'].includes(payload.command)
            ? { ...payload, command: 'PROGRESS', ids: [payload.ids[1], payload.ids[1]], position, playStatus: matching ? fresh.playingState : own.intent.playStatus }
            : payload;
          if (Number.isFinite(retry.position)) pending.positions.push(retry.position);
          playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/reportRequest', payload: retry });
        }
        return { ...scene(), ok: true, applied: false, reason: '本地操作等待房间确认，忽略旧快照' };
      }
    }
    if (outOfOrder) return { ...scene(), ok: true, applied: false, reason: '指令序号过旧' };
    const intent = own.intent;
    const heartbeat = String(command?.commandType || '').toUpperCase() === 'PROGRESS';
    const expectedPosition = intent ? intent.position + (intent.playStatus === PLAYING ? (Date.now() - intent.at) / 1000 : 0) : 0;
    const staleHeartbeat = intent && Date.now() < intent.guardUntil && heartbeat && sender !== hostUid
      && (target !== intent.target ? target === intent.remoteTarget : Math.abs(Number(command?.progress) / 1000 - expectedPosition) > 3);
    if (staleHeartbeat || (seen && seen === own.ignoredHeartbeat)) {
      own.ignoredHeartbeat = seen;
      return { ...scene(), ok: true, applied: false, reason: '手机仍在回传操作前的状态，忽略旧心跳' };
    }
    const fingerprint = songs.join(',');
    if (songs.length && fingerprint !== own.queue && Date.now() - own.queueAt >= QUEUE_GAP) {
      own.queue = fingerprint;
      own.queueAt = Date.now();
      aligned = true;
      if (target) own.remote = { target, revision: own.revision, until: Date.now() + 5000 };
      own.dispatchRemote({
        type: 'async:listenTogetherPlayList/syncPlayList',
        payload: { roomId, forceUpdatePlaylist: true, enableDispatchQueueChange: true, isIgnorePlayCommand: false },
      });
    }
    if (!command) return { ...scene(), ok: true, applied: false, reason: '没拿到指令' };
    /**
     * 成功套用的同一条指令不再重复灌。新的同进度拖动由 serverSeq 区分，旧进度不会每五秒回拉。
     *
     * 但上次**没套上**（比如队列里还没有那首歌）就得早点再来：等太久才重试一次，用户听着就是
     * 一直各听各的，每 1.5 秒重试一次才像在干活。own.applied 记的就是上一次到底成没成。
     */
    if (seen === own.last && (own.handled || Date.now() - own.at < 1500)) {
      return { ...scene(), ok: true, applied: false, reason: '指令没变' };
    }
    own.last = seen;
    own.at = Date.now();
    own.handled = false;
    /**
     * 记下这一轮到底有没有真的改动播放，出去之前统一写回 own.applied。
     *
     * 顺手把本地读数基准同步成「套用后」的样子：下一轮开头记的是上一轮结尾的现场，刚套用完
     * 的暂停/切歌必须算进来，否则用户在套用之后的下一次操作会被旧基准漏判。
     * isCanReport 也在成员端顺手关掉——playTracks 的收尾会把它拨回 true（页面自己的行为，
     * 见 ARM 注释），那扇窗开着，页面下一次本地状态变化就会把回声发出去。
     */
    const settle = (result, handled = Boolean(result?.applied)) => {
      own.applied = Boolean(result?.applied);
      own.handled = handled;
      own.lastSong = currentSong();
      own.lastState = playerStore.getState()?.playing?.playingState === PLAYING ? 'playing' : 'paused';
      const ps = playerStore.getState()?.['async:listenTogetherPlayStatus'] || {};
      if (!isHost && ps.isCanReport) {
        playerStore.dispatch({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } });
      }
      return result;
    };
    const repairOwnCommand = sender === hostUid && target && target !== currentSong() && own.intent?.target === target;
    if (sender && hostUid && sender === hostUid && !repairOwnCommand) {
      return settle({ ...scene(), ok: true, applied: false, reason: '自己发的' }, true);
    }
    const type = String(command.commandType ?? '');
    const applyPosition = () => {
      const progress = Number(command.progress);
      if (!Number.isInteger(progress) || progress < 0) return false;
      // 先打标记再派发：dispatch 钩子认出这是套用房间进度，不拿它当用户的拖动上报。
      const action = { type: 'playing/setPlayingPosition', payload: { duration: progress / 1000 } };
      seekMark.action = action;
      own.dispatchRemote(action);
      return true;
    };
    const applyStatus = () => {
      const stopped = /PAUSE/i.test(String(command.playStatus || ''));
      const now = playerStore.getState()?.playing || {};
      if (stopped) {
        if (now.playingState !== PLAYING) return '';
        own.dispatchRemote({ type: 'playing/pause' });
        return 'pause';
      }
      if (now.playingState === PLAYING) return '';
      own.dispatchRemote({ type: 'playing/resume' });
      return 'resume';
    };
    // 成员：房主在听的歌不是我这首，就追过去。不限指令类型——房主的心跳是 PROGRESS，只认
    // GOTO/NEXT/PREV 的话成员永远不会换歌（这就是各听各的最后一环）。
    if (!isHost && target && target !== current) {
      const revision = own.revision;
      own.remote = { target, revision, until: Date.now() + 5000 };
      const canContinue = () => activeRoom() && own.revision === revision
        && ['', current, target].includes(currentSong());
      const interrupted = () => ({ ...scene(), ok: true, applied: false, reason: '本地播放已变化，忽略旧快照' });
      const waitForSong = async timeout => {
        for (let elapsed = 0; elapsed < timeout && currentSong() !== target && canContinue(); elapsed += 50) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return canContinue();
      };
      const playIds = displayQueue(data.playlist);
      // 队列里没有这首歌就先等刚才那次 syncPlayList 落库，否则 playByTrackId 按 id 找不到歌。
      for (let i = 0; !playIds.length && i < QUEUE_WAIT && !localQueue().includes(target); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!canContinue()) return interrupted();
      }
      if (!canContinue()) return interrupted();
      const steps = [];
      if (own.knownSongs[target] || songIds(playerStore.getState()?.playingList?.curPlayingList).includes(target)) {
        own.dispatchRemote({
          type: 'async:listenTogetherPlayList/playByTrackId',
          payload: { id: target, playStatus: PLAYING, commandType: SWITCH.includes(type) ? type : 'GOTO' },
        });
        steps.push('playByTrackId');
        if (!await waitForSong(250)) return interrupted();
      }
      /**
       * 第一档：让页面自己播房间队列。
       *
       * 房间歌单在 store 里存成 displayTrackIds 这种纯 id 数组，而 curPlayingList（track 对象）
       * 一直是空的——得有人把 id 解析成 track，页面里干这件事的就是 playTracks，官方客户端加入
       * 房间后真正开始播房间队列走的也是同一个 action。
       *
       * payload 必须是页面 effect 的原样形状：{displayTrackIds, options:{playId, play}}——
       * syncPlayList 内部派的就是这一份。effect 开头就按 e.displayTrackIds.map 去联网取歌、
       * 再拿 options.playId 去权限列表里找那首，最后派 playing/play {tracks, options}。
       * 早先传 {clear, playId}，第一步 g.map 就 TypeError，这一档从来没生效过——四档全靠
       * 后面的退档硬顶，探针里才一直是「暂停 + 进度 0」。
       */
      if (playIds.length && currentSong() !== target) {
        own.dispatchRemote({
          type: 'async:listenTogetherPlayList/playTracks',
          payload: { displayTrackIds: playIds, options: { playId: target, play: true } },
        });
        steps.push('playTracks');
        if (!await waitForSong(TRACK_WAIT)) return interrupted();
      }
      // playByTrackId 在队列里按 id 找歌。队列刚解析出来时它也能用，留着当第二档。
      if (currentSong() !== target) {
        own.dispatchRemote({
          type: 'async:listenTogetherPlayList/playByTrackId',
          // 指令类型不在切歌那一族时按 GOTO 处理：playByTrackId 只在切歌语义下才会换歌。
          payload: { id: target, playStatus: PLAYING, commandType: SWITCH.includes(type) ? type : 'GOTO' },
        });
        steps.push('playByTrackId');
        if (!await waitForSong(SWITCH_WAIT)) return interrupted();
      }
      if (currentSong() !== target) {
        // 再退一步：直接让播放器播这一首，不经过房间队列。真机实测不带 clear 的那一版只会把
        // 播放状态从 2 掰成 1 再掰回 2，歌还是原来那首（探针里 pos 恒为 0 就是它）。
        own.dispatchRemote({ type: 'playing/play', payload: { playId: target } });
        steps.push('playing/play');
        if (!await waitForSong(SWITCH_WAIT)) return interrupted();
      }
      if (currentSong() !== target) {
        // 最后一档：照页面 playTracks 的原样来，带 clear 让它重建队列。
        own.dispatchRemote({ type: 'playing/play', payload: { playId: target, clear: true } });
        steps.push('playing/play+clear');
        if (!await waitForSong(SWITCH_WAIT)) return interrupted();
      }
      if (currentSong() !== target) {
        // 几档都不奏效。三件事分开说，指向的下一步完全不同：
        //   · 房主那首不在房间队列里 —— 服务端快照的问题，等下一条指令；
        //   · 队列里有、本地没有 —— syncPlayList 没落库，等或看字段名（queueShape/localShape）；
        //   · 本地也有却换不动 —— 页面 playTracks 被权限那道门拦了（otherSide 空、权限 0 条时
        //     它只会「暂停 + 进度归零」），或那首歌对当前账号不可播。
        const inRemote = songs.includes(target);
        const localHas = localQueue().includes(target);
        let reason;
        if (!inRemote) reason = '房主那首不在房间队列里，切不了';
        else if (!localHas) reason = '房间队列没搬进本地，切不了房主那首';
        else reason = '本地有这首，但页面没换成（多半是权限或不可播）';
        return settle({
          ...scene(),
          ok: true,
          applied: false,
          via: steps.join('>'),
          reason,
        });
      }
      applyPosition();
      const toggled = applyStatus();
      return settle({
        ...scene(),
        ok: true,
        applied: true,
        via: steps.join('>') + (toggled ? '+' + toggled : ''),
        followed: true,
        commandType: type,
      });
    }
    if (SWITCH.includes(type)) {
      // 切歌走页面自己的按曲目切换：它在队列里按 id 找，找到就换，不会清空队列。
      // （原来的 onRoomMsg 在这种情况下什么都不做，因为门禁要求指令的歌等于当前在播的歌。）
      // 已经在播这首、而且正放着就别再派：playByTrackId 无条件把状态掰成 Playing，对着同一首
      // 反复派没意义（自己刚上报的 GOTO 落地后下一轮就会走到这）。还停着才派——GOTO 语义下
      // 它顺带把「跟着房间继续播」补上。
      if (target === current && playing.playingState === PLAYING) {
        return settle({ ...scene(), ok: true, applied: false, reason: '已经在播这首' }, true);
      }
      own.dispatchRemote({
        type: 'async:listenTogetherPlayList/playByTrackId',
        payload: { id: target, playStatus: PLAYING, commandType: type },
      });
      return settle({ ...scene(), ok: true, applied: true, via: 'playByTrackId', commandType: type });
    }
    const sameSong = !!target && (target === String(cur.trackId ?? '') || target === String(cur.resourceId ?? ''));
    if (!sameSong) return settle({ ...scene(), ok: true, applied: false, reason: '不是同一首歌' });
    if (type === 'PAUSE') {
      if (playing.playingState === PLAYING) own.dispatchRemote({ type: 'playing/pause' });
      return settle({ ...scene(), ok: true, applied: true, via: 'playing/pause', commandType: type });
    }
    if (type === 'PLAY') {
      if (playing.playingState !== PLAYING) own.dispatchRemote({ type: 'playing/resume' });
      return settle({ ...scene(), ok: true, applied: true, via: 'playing/resume', commandType: type });
    }
    if (type === 'PROGRESS' || type === 'seek' || type === 'SEEK') {
      // 官方客户端发进度用的是 seek（见 QListenTogether 的 playCommand('seek')），插件自己的
      // 心跳发的是 PROGRESS，两个都当进度处理。
      const via = applyPosition() ? 'playing/setPlayingPosition' : '';
      return settle({ ...scene(), ok: true, applied: Boolean(via), via, reason: via ? '' : '进度无效', commandType: type });
    }
    return settle({ ...scene(), ok: true, applied: false, reason: '不认识的指令 ' + type });
  })().finally(() => {
    own.busy = false;
    if (own.remote && own.remote.revision === own.revision && own.handled && currentSong() === own.remote.target) own.remote = null;
  });
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
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  const status = String(playerStore.getState()?.['async:listenTogether']?.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, sent: false };
  if (status !== 'togetherOwner') return { ok: true, sent: false, reason: '只有房主能定房间队列' };
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
