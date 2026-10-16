/** 页面中共享的房间请求、成员资料和退出状态处理。 */
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
export const REMEMBERED_ROOM = `  const remembered = globalThis.__NEMusicOnSteamRoom || null;`;

export const ROOM_EXIT_HELPER = `  const roomExited = () => globalThis.__NEMusicOnSteamRoomExit?.store === playerStore;
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
export const PROFILE_HELPER = `  const fetchProfiles = async uids => {
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

export const ROOM_STATUS_HELPER = `  /**
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
export const SAVE_DIAGNOSTICS_HELPER = `  const saveDiagnostics = (checkData, acceptData, statusData, refer) => {
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

