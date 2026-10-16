import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";
import { ROOM_HOST_HELPER } from "./together-role.ts";
import { ROOM_QUEUE_HELPER } from "./queue.ts";
import { ROOM_STATUS_HELPER, PROFILE_HELPER } from "./room-scripts.ts";

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
${ROOM_HOST_HELPER}
  if (!playerStore) return { ok: false, error: '播放器还没准备好' };
  if (globalThis.__NEMusicOnSteamRoomExit?.store === playerStore) return { ok: true, armed: false };
  const state = playerStore.getState() || {};
  const together = state['async:listenTogether'] || {};
  const status = String(together.status || '');
  if (status !== 'together' && status !== 'togetherOwner') return { ok: true, armed: false };
  const roomId = String(together.roomInfo?.roomId || globalThis.__NEMusicOnSteamRoom?.roomId || '');
  const wanted = isRoomHost(together, String(state.host?.uid || ''), roomId);
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
${ROOM_HOST_HELPER}
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
  const isHost = isRoomHost(together, String(playerStore.getState()?.host?.uid || ''), roomId);
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
${ROOM_QUEUE_HELPER}
  const localQueue = () => roomQueueOf(queueSlice());
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

