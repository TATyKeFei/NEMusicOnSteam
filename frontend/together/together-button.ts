import { PLAYER_ACCESS_SCRIPT } from "../player/player-access.ts";

/**
 * 一起听按钮：挂在网易云播放栏里，分享按钮左边。
 *
 * 页面自己有一个 btn_pc_minibar_listentogether，但它只能开/关房间，没有房间码和链接，也没法
 * 解散房间；这里另起一个按钮，给一个完整的上拉菜单。
 *
 * 为什么不让页面直接派 action：建房要走 TogetherBridge——身份补丁（APP_CONF + cookie）必须在
 * 建房之前打好，否则服务端会把我们当成低版本客户端、别人进不来。页面按钮只负责把「用户想建房
 * / 退房」记在 api.pending 上，由 TogetherBridge 在自己的 tick 里读走并执行，两边只有这一条
 * 通路。房间码和链接倒是页面自己就能从 store 读，不必绕一圈。
 *
 * 菜单用 position: fixed + 按钮的 rect 定位，而不是 absolute：播放栏不少地方带 overflow
 * hidden，absolute 会被裁掉。
 */

/** 注入页面的 api 一有变化就递增，升级时才能替换掉旧脚本留下的闭包。 */
const BUTTON_API_VERSION = 14;

/**
 * 素材取自 assets/icon/together.svg（测试会拿素材原文比一遍，改这里就得改素材）。
 * fill 从素材里的 #ffffff 换成 currentColor 才能跟随播放栏配色，尺寸取 22px 和旁边那几个
 * 图标按钮一致。
 */
const ICON = "<svg width=\"22\" height=\"22\" viewBox=\"0 0 1024 1024\" aria-hidden=\"true\" fill=\"currentColor\"><path d=\"M585.209884 578.669422c11.915377-1.765203 23.856337-3.501754 36.259832-3.501754 76.262918 0 136.351458 30.125111 189.545984 75.55786 10.17678-11.399631 24.588001-18.889209 41.035602-18.889209 5.347798 0 10.205433 1.62808 15.117302 3.066849-41.578977-46.843888-95.859231-82.044598-157.928892-99.197256 70.103638-33.138748 119.037117-104.001679 119.037117-186.534394 0-114.042359-92.764753-206.808136-206.808136-206.808136-41.008996 0-79.08622 12.267395-111.274316 32.920784-32.133861-20.599154-70.102614-32.920784-111.057375-32.920784-114.042359 0-206.807113 92.764753-206.807113 206.808136 0 81.528851 47.820122 151.495366 116.511597 185.176466-139.418306 39.461757-241.981217 167.588903-241.981217 319.492568 0 15.361873 12.4301 27.791973 27.791973 27.791973 15.360849 0 27.79095-12.4301 27.79095-27.791973 0-152.581094 124.111692-276.719392 276.69381-276.719392 152.581094 0 276.719392 124.138298 276.719392 276.719392 0 15.361873 12.4301 27.791973 27.791973 27.791973 15.360849 0 27.79095-12.4301 27.79095-27.791973C731.440339 739.501434 673.388179 638.486786 585.209884 578.669422zM514.672364 542.682813c-8.277524-3.094478-16.663518-5.916756-25.239847-8.360412 7.571443-3.690042 15.116279-7.436366 22.118763-11.995195 6.78452 4.315282 15.551184 10.258645 22.146393 13.380752C527.130094 537.524327 520.942161 540.211529 514.672364 542.682813zM399.137001 500.397754c-83.374896 0-151.22419-67.850317-151.22419-151.22419 0-83.374896 67.850317-151.225213 151.22419-151.225213s151.225213 67.850317 151.225213 151.225213C550.362214 432.547437 482.511897 500.397754 399.137001 500.397754zM554.758338 214.476793c20.246113-10.123568 42.61047-16.528442 66.710354-16.528442 83.374896 0 151.22419 67.850317 151.22419 151.225213 0 83.373873-67.850317 151.22419-151.22419 151.22419-24.127514 0-46.599318-6.242168-66.846454-16.338107 31.537274-36.313044 51.321876-83.130326 51.321876-134.886083C605.945137 297.497625 586.213747 250.763231 554.758338 214.476793z\"/><path d=\"M929.346735 742.134401l-54.715159 0 0-54.714136c0-15.361873-12.429077-27.791973-27.79095-27.791973s-27.79095 12.4301-27.79095 27.791973l0 54.714136-54.715159 0c-15.361873 0-27.79095 12.4301-27.79095 27.79095 0 15.361873 12.429077 27.791973 27.79095 27.791973l54.715159 0 0 54.714136c0 15.361873 12.429077 27.79095 27.79095 27.79095s27.79095-12.429077 27.79095-27.79095l0-54.714136 54.715159 0c15.360849 0 27.79095-12.4301 27.79095-27.791973C957.137685 754.564501 944.706561 742.134401 929.346735 742.134401z\"/></svg>";

/**
 * 菜单项。visible 每次开菜单时按房间状态重算——房间状态只有插件侧知道，页面这边读 store
 * 拿到的和 TogetherBridge 读的是同一份，不会有第二个真相。
 */
const MENU_ITEMS = `
  const ITEMS = [
    { key: 'start', label: '创建房间', visible: room => !room.inRoom },
    { key: 'join', label: '加入房间', visible: room => !room.inRoom },
    { key: 'leave', label: '退出房间', visible: room => room.inRoom && !room.isHost },
    { key: 'dissolve', label: '解散房间', visible: room => room.inRoom && room.isHost },
    { key: 'invite', label: '邀请好友', visible: room => room.inRoom && room.isHost },
    { key: 'code', label: '复制房间码', visible: room => room.inRoom && !!room.roomId },
    { key: 'link', label: '复制房间链接', visible: room => room.inRoom && !!room.roomId },
  ];
  // 网易云没有网页版的邀请链接：官方邀请是原生 App 的 ListenTogetherInviteModal，网页播放器
  // 只读 main / route 两个参数，不认房间号。所以这个链接是给插件自己的「加入房间」用的——
  // 官方接受接口必须同时有 roomId 和房主 uid，而没有任何「roomId → 房主 uid」的接口，所以复制
  // 端（房主）把自己的 uid 一起编进去，加入端才拆得出来。inviterId 缺省时只带房间码。
  const roomLink = (roomId, inviterId) => {
    let url = 'https://music.163.com/st/webplayer?roomId=' + encodeURIComponent(roomId);
    if (inviterId) url += '&inviterId=' + encodeURIComponent(inviterId);
    return url;
  };
  const visibleItems = room => ITEMS.filter(item => item.visible(room));
`;

/**
 * 装按钮和菜单。返回 {ok, note}，note 是人话版的失败原因，直接显示到插件设置页。
 */
export const togetherButtonScript = (): string => `(() => {
  ${PLAYER_ACCESS_SCRIPT}
  const key = '__nemusicTogetherButton';
  const version = ${BUTTON_API_VERSION};
  const existing = window[key];
  if (existing && existing.version === version) {
    const note = existing.ensure();
    return { ok: true, note, anchor: String(existing.anchorName || ''), bar: String(existing.barInfo || '') };
  }
  if (existing) {
    try { existing.destroy(); } catch (error) {}
    try { delete window[key]; } catch (error) { window[key] = undefined; }
  }
  // 播放栏那条横带里可能出现的控件：图标按钮组件都带 cmd-button 的 class，埋点按钮都有
// title，剩下的靠 btn_pc_ 开头的 id 兜住（播放按钮就属于这种）。class 名和条件渲染的按钮
// 集合每版都在变，所以这里只要能认出「这是个控件」，不猜它是哪个按钮。
const STRIP_SELECTOR = '[title],[id^="btn_pc_"],[class*="cmd-button"]';
// 离播放按钮中线多远还算同一条带子。播放栏只有六七十像素高，26px 足够宽松，又不会把上面歌单
// 列表里的行内菜单拉进来。
const STRIP_TOLERANCE = 26;
const SHARE_OID = 'btn_pc_minibar_share';
  const api = { version, pending: '', button: null, menu: null, toastTimer: 0, note: '', anchorName: '', anchor: null, barInfo: '', middleY: 0, healTimer: 0, healSeq: 0, retries: 0, observer: null };
  // 分享按钮的两种认法：可访问名 title 是组件里写死的，埋点 oid 更死（哪版改文案都不会变）。
  api.isShare = node => {
    if ((node.getAttribute?.('title') || '') === '分享') return true;
    return String(node.getAttribute?.('data-log') || '').includes(SHARE_OID);
  };
  ${MENU_ITEMS}  const readRoom = () => {
    const store = findPlayerStore();
    if (globalThis.__NEMusicOnSteamRoomExit?.store === store) {
      return { status: 'alone', roomId: '', inviterId: '', inRoom: false, isHost: false };
    }
    const state = store?.getState() || {};
    const together = state['async:listenTogether'] || {};
    const status = String(together.status || '');
    const remembered = globalThis.__NEMusicOnSteamRoom || null;
    const room = together.roomInfo && typeof together.roomInfo === 'object' ? together.roomInfo : {};
    const roomId = String(room.roomId || together.roomId || remembered?.roomId || '');
    const creatorId = String(room.creatorId || together.creatorId || remembered?.creatorId || '');
    const pendingCreation = Boolean(remembered?.pending && Number(remembered.expiresAt || 0) > Date.now());
    const rememberedOwnRoom = remembered?.createdByUs === true
      && (!remembered?.roomId || !roomId || String(remembered.roomId) === roomId);
    const activeStatus = status === 'together' || status === 'togetherOwner'
      || status === 'waiting' || status === 'opening';
    // 建房流程可能先写 roomInfo、再写 status；只要页面已经拿到房间号，且不是明确的结束状态，
    // 就不要再显示创建/加入，避免用户重复建房。
    const inRoom = !['closing', 'closed', 'timeout'].includes(status)
      && (activeStatus || !!roomId || pendingCreation);
    const ownUid = String(state.host?.uid || together.hostUid || '');
    return {
      status,
      roomId: inRoom ? roomId : '',
      // 房主 uid：复制链接时要编进去，加入端靠它过 accept 的 inviterId 校验。
      inviterId: String(together.hostUid || creatorId || remembered?.ownerUid || ownUid),
      inRoom,
      isHost: status === 'togetherOwner' || status === 'waiting' || status === 'opening' || pendingCreation
        || rememberedOwnRoom
        || (inRoom && !!creatorId && creatorId === ownUid),
    };
  };
  const toast = message => {
    let node = document.querySelector('[data-nemusic-together-toast]');
    if (!node) {
      node = document.createElement('div');
      node.setAttribute('data-nemusic-together-toast', '');
      node.style.cssText = 'position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483647;padding:8px 18px;border-radius:4px;background:rgba(0,0,0,.84);color:#fff;font:13px/1.5 system-ui,sans-serif;pointer-events:none;white-space:nowrap';
      document.body.append(node);
    }
    node.textContent = message;
    api.toastTimer = window.setTimeout(() => node.remove(), 1800);
  };
  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      // 剪贴板在非用户手势或者页面失焦时会拒绝，退回老办法。
      const area = document.createElement('textarea');
      area.value = value;
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area);
      area.select();
      try { document.execCommand('copy'); } catch (innerError) { area.remove(); toast('复制失败，请手动复制'); return; }
      area.remove();
    }
    toast(label + '已复制');
  };
  const openInvite = room => {
    if (!room.inRoom || !room.isHost || api.inviting) return;
    if (!room.roomId) { toast('房间还在创建，请稍后再试'); return; }
    try {
      const store = findPlayerStore();
      if (!store) { toast('播放器状态尚未就绪，请稍后再试'); return; }
      const state = store.getState() || {};
      let webpackRequire = window.__NEMusicOnSteamWebpackRequire;
      if (!webpackRequire?.c && Array.isArray(window.webpackJsonp)) {
        const moduleId = '__NEMusicOnSteamNativeInvite';
        window.webpackJsonp.push([[], {
          [moduleId]: (module, exports, require) => {
            window.__NEMusicOnSteamWebpackRequire = require;
          },
        }, [[moduleId]]]);
        webpackRequire = window.__NEMusicOnSteamWebpackRequire;
      }
      let modal = api.nativeModal;
      if (!modal) {
        for (const module of Object.values(webpackRequire?.c || {})) {
          try {
            const exports = module.exports;
            modal = [exports, ...Object.values(exports || {})]
              .find(candidate => typeof candidate?.listenTogetherInvite === 'function');
            if (modal) break;
          } catch (error) {}
        }
        if (modal) api.nativeModal = modal;
      }
      if (!modal) { toast('网易云原生邀请入口尚未加载，请稍后再试'); return; }
      const remembered = globalThis.__NEMusicOnSteamRoom;
      const saved = String(remembered?.roomId || '') === room.roomId ? remembered : null;
      const roomInfo = {
        ...(saved?.roomInfo || {}),
        ...(state['async:listenTogether']?.roomInfo || {}),
        roomId: room.roomId,
      };
      roomInfo.creatorId = String(roomInfo.creatorId || saved?.creatorId || room.inviterId);
      roomInfo.chatRoomId = String(roomInfo.chatRoomId || saved?.chatRoomId || '');
      const currentPlaying = state.playing || {};
      const trackId = [currentPlaying.resourceTrackId, currentPlaying.curTrack?.id]
        .map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
      const target = currentPlaying.curPlaying || (trackId > 0
        ? {
          resourceType: 'track', resourceId: String(trackId), trackId,
          track: Number(currentPlaying.curTrack?.id) === trackId ? currentPlaying.curTrack : { id: trackId },
        }
        : null);
      if (!target) { toast('请先播放一首网易云歌曲'); return; }
      api.inviting = true;
      Promise.resolve(modal.listenTogetherInvite({ roomInfo, refer: 'songplay_more', target }))
        .then(result => {
          const current = readRoom();
          if (current.inRoom && current.isHost && current.roomId === room.roomId
            && typeof result?.inviteFriendHandle === 'function') return result.inviteFriendHandle();
        })
        .catch(() => toast('网易云原生邀请失败，请稍后再试'))
        .finally(() => { api.inviting = false; });
    } catch (error) {
      api.inviting = false;
      toast('无法打开网易云原生邀请窗口，请稍后再试');
    }
  };
  const run = (key, room) => {
    if (key === 'start') { api.pending = 'start'; toast('正在创建房间…'); return; }
    if (key === 'leave') { api.pending = 'leave'; toast('正在退出房间…'); return; }
    if (key === 'dissolve') { api.pending = 'leave'; toast('正在解散房间…'); return; }
    if (key === 'invite') return void openInvite(room);
    if (key === 'code') return void copy(room.roomId, '房间码');
    if (key === 'link') return void copy(roomLink(room.roomId, room.inviterId), '房间链接');
  };
  // 「加入房间」不直接动作：先问房间码，再把这个动作摞到 api.pending 上交给 TogetherBridge——
  // 和建房 / 退房同一条通路，页面这边只负责收输入。
  const submitJoin = value => {
    const code = String(value || '').trim();
    if (!code) { toast('请输入房间码或邀请链接'); return; }
    api.pending = 'join:' + code;
    toast('正在加入房间…');
    closeMenu();
  };
  const closeMenu = () => {
    api.menu?.remove();
    api.menu = null;
    api.button?.setAttribute('aria-expanded', 'false');
  };
  const addMenuItem = (menu, item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.setAttribute('data-nemusic-together-item', item.key);
    row.textContent = item.label;
    row.style.cssText = 'display:block;width:100%;padding:9px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer';
    row.addEventListener('mouseenter', () => { row.style.background = '#3a3a44'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
    row.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      // 加入要先收房间码，把菜单原地换成输入框，别关掉。
      if (item.key === 'join') { openJoinInput(); return; }
      closeMenu();
      run(item.key, readRoom());
    });
    menu.append(row);
  };
  const renderMenu = (menu, room) => {
    menu.textContent = '';
    for (const item of visibleItems(room)) addMenuItem(menu, item);
  };
  const buildMenu = () => {
    const menu = document.createElement('div');
    menu.setAttribute('data-nemusic-together-menu', '');
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'position:fixed;z-index:2147483647;width:176px;padding:4px 0;box-sizing:border-box;border:1px solid #4a4a52;border-radius:4px;background:#2a2a30;box-shadow:0 10px 34px #0009;font:13px/1.5 system-ui,sans-serif;color:#e8e8ea;user-select:none';
    renderMenu(menu, readRoom());
    return menu;
  };
  /**
   * 把菜单原地换成「输入框 + 确定」。菜单本来就是 fixed + 上拉定位，输入框长出来后要重新量高度
   * 往上挪，否则会被底边切掉。
   */
  const openJoinInput = () => {
    const menu = api.menu;
    const button = api.button;
    if (!menu || !button) return;
    menu.textContent = '';
    const label = document.createElement('div');
    label.textContent = '加入房间';
    label.style.cssText = 'padding:8px 16px 4px;color:#a8a8b0;font-size:12px';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '房间码或邀请链接';
    input.setAttribute('data-nemusic-together-join-input', '');
    input.style.cssText = 'display:block;width:calc(100% - 24px);margin:0 12px 8px;padding:7px 10px;box-sizing:border-box;border:1px solid #4a4a52;border-radius:4px;background:#1e1e24;color:#e8e8ea;font:inherit;user-select:text';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.setAttribute('data-nemusic-together-join-confirm', '');
    confirm.textContent = '确定';
    confirm.style.cssText = 'display:block;width:calc(100% - 24px);margin:0 12px 10px;padding:8px;border:0;border-radius:4px;background:#4a6cf5;color:#fff;font:inherit;cursor:pointer';
    const submit = () => submitJoin(input.value);
    confirm.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); submit(); });
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
    menu.append(label, input, confirm);
    // 输入框长高了，重新贴回按钮上方。
    const rect = button.getBoundingClientRect();
    const height = menu.getBoundingClientRect().height;
    menu.style.top = Math.round(Math.max(8, rect.top - height - 8)) + 'px';
    window.setTimeout(() => input.focus(), 0);
  };
  const refreshMenu = () => {
    if (!api.menu) return;
    if (api.menu.querySelector('[data-nemusic-together-join-input]')) return;
    const room = readRoom();
    const expected = visibleItems(room).map(item => item.key).join('|');
    const actual = Array.from(api.menu.querySelectorAll('[data-nemusic-together-item]'))
      .map(row => row.getAttribute('data-nemusic-together-item') || '').join('|');
    if (expected !== actual) renderMenu(api.menu, room);
  };
  const openMenu = () => {
    if (api.menu) return closeMenu();
    const button = api.button;
    if (!button) return;
    const menu = buildMenu();
    document.body.append(menu);
    api.menu = menu;
    // 上拉：菜单底边贴在按钮顶边上方。播放栏贴底，所以往上弹才不会跑出窗口。
    const rect = button.getBoundingClientRect();
    const height = menu.getBoundingClientRect().height;
    const left = Math.max(8, Math.min((window.innerWidth || 0) - 184, rect.left));
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(Math.max(8, rect.top - height - 8)) + 'px';
    button.setAttribute('aria-expanded', 'true');
    refreshMenu();
  };
  api.destroy = () => {
    closeMenu();
    api.button?.remove();
    api.button = null;
    // 追补的回调可能还挂在 rAF/定时器上，序号一改它们就作废了。
    api.healSeq += 1;
    window.clearTimeout(api.healTimer);
    api.healTimer = 0;
    window.clearTimeout(api.toastTimer);
    try { api.observer?.disconnect(); } catch (error) {}
    api.observer = null;
    document.querySelector('[data-nemusic-together-toast]')?.remove();
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onDocumentKey, true);
  };
  const onDocumentClick = event => {
    if (!api.menu) return;
    if (event.target?.closest?.('[data-nemusic-together-menu],[data-nemusic-together-button]')) return;
    closeMenu();
  };
  const onDocumentKey = event => {
    if (event.key !== 'Escape' || !api.menu) return;
    event.preventDefault();
    closeMenu();
  };
  /**
   * 把按钮挂到播放栏左下角那组图标里、「分享」按钮的左边。
   *
   * 返回空串表示已经在位，非空就是人话的失败原因——找不到时会把播放栏这一带实际存在的控件
   * 连横坐标一起报出来，否则「按钮跑哪去了」只能靠猜。
   */
  // 播放栏里很多按钮是渲染了但不可见的（零尺寸、display:none、藏在折叠层里）。插在一个
  // 看不见的按钮前面，我们自己也会看不见——所以锚点必须限定在可见控件里。判断要连着祖先一起
  // 看：切歌词界面那一下播放栏是淡出/藏起来的，opacity:0 和 visibility:hidden 不会让 rect
  // 归零，只看自己会以为「按钮还在原位好好的」，其实已经跟着旧播放栏一起看不见了。
  api.visible = node => {
    try {
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const view = node.ownerDocument && node.ownerDocument.defaultView;
      if (!view || !view.getComputedStyle) return true;
      for (let cur = node; cur; cur = cur.parentElement) {
        const style = view.getComputedStyle(cur);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  };
  /**
   * 把匹配到的节点还原成「那个图标按钮」。
   *
   * title 有时落在按钮自己身上（分享就是），有时落在按钮里面的 svg 上——播放列表、音量、一起听
   * 都是把 title 传给图标组件的，而图标组件会把多余的 props 透传给 <svg>。插在 svg 前面等于
   * 插进别人的按钮肚子里，那我们自己也是看不见的，所以先爬回最外层那个按钮。
   */
  api.buttonOf = node => {
    try {
      const host = node?.closest?.('button,[role="button"],.cmd-button') || node;
      if (host && host.parentElement) return host;
    } catch (error) {}
    return null;
  };
  api.label = node => node.getAttribute('title') || node.getAttribute('aria-label') || node.id || node.tagName.toLowerCase();
  /**
   * 播放栏 = 页面最底下贴着窗口那条横带。
   *
   * 为什么不按 id/class 找：这一版页面里整个播放栏只有播放按钮有 DOM id（组件里只对它调了
   * 一次 Object(P.t)("btn_pc_minibar_play")），容器和别的按钮只有 class，而 class 名和条件
   * 渲染的按钮集合每版都在变——按猜测的 id 找，结果就是「一个都匹配不上」。
   *
   * 改用位置认：播放按钮一定在这条带子里，它所在的那条水平线就是带子的中线，带子里所有可见的
   * 控件（带 title / btn_pc_ 开头的 id / cmd-button 的 class）就是播放栏的全部按钮。带子外面
   * 的东西——歌单列表里每行的菜单、页面导航——都不在这条水平线上，所以不会混进来。
   */
  api.strip = () => {
    let middle = (window.innerHeight || 0) - 28;
    const play = document.querySelector('#btn_pc_minibar_play') || document.querySelector('[aria-label="播放进度调节"]');
    try {
      const rect = play?.getBoundingClientRect?.();
      if (rect && rect.height > 0) middle = rect.top + rect.height / 2;
    } catch (error) {}
    // 记下带子的中线：DOM 监听要用它分清「播放栏附近的变化」和页面别处的变化。
    api.middleY = middle;
    const out = [];
    for (const node of Array.from(document.querySelectorAll(STRIP_SELECTOR))) {
      if (node === api.button || node.getAttribute?.('data-nemusic-together-button') != null) continue;
      let rect;
      try {
        rect = node.getBoundingClientRect();
      } catch (error) {
        continue;
      }
      if (Math.abs(rect.top + rect.height / 2 - middle) > STRIP_TOLERANCE) continue;
      if (!api.visible(node)) continue;
      out.push(node);
    }
    out.sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
    return out;
  };
  api.anchor = strip => {
    strip = strip || api.strip();
    // 一、需求指定的位置：分享按钮左边。分享拿 title 认，拿埋点 oid 兜底（万一哪版把可访问名
    // 拿掉了，oid 是组件里写死的，不会变）。
    const share = strip.find(node => api.isShare(node));
    const shareButton = share ? api.buttonOf(share) : null;
    if (shareButton) return { selector: '播放栏里的分享按钮', node: shareButton, after: false };
    // 二、分享没渲染，但评论在：那一组图标是[添加, 评论, 分享]，插在评论后面正好落在分享原来的
    // 位置上。
    const comment = strip.find(node => node.getAttribute('title') === '评论');
    if (comment && comment.parentElement) return { selector: '播放栏里的评论按钮（分享没渲染）', node: comment, after: true };
    // 三、连评论都没有：插这条带子最左边的控件前面——播放栏左边那组图标就在那儿，插在它旁边
    // 至少还在左下角这一片，而不是跑到右边音量/歌单那边去。
    const first = strip[0];
    const firstButton = first ? api.buttonOf(first) : null;
    if (firstButton) return { selector: '播放栏最左边的控件', node: firstButton, after: false };
    return null;
  };
  // 播放栏在不同页面结构不一样（分享、一起听、评论、音效都是条件渲染），所以这里报的是这一带
  // 实际存在的控件和它们的横坐标——判断「这个页面到底有什么」最直接，也比逐页猜选择器快得多。
  api.describeBar = strip => {
    const bar = document.querySelector('#page_pc_mini_bar') ? '有 #page_pc_mini_bar' : '没有 #page_pc_mini_bar';
    strip = strip || api.strip();
    if (!strip.length) return bar + '｜这一带没找到任何可见控件';
    const parts = strip.slice(0, 10).map(node => {
      const rect = node.getBoundingClientRect();
      const tag = node.tagName.toLowerCase();
      return api.label(node) + '<' + tag + '>@' + Math.round(rect.left) + ',' + Math.round(rect.top);
    });
    return bar + '｜这一带的控件：' + parts.join(' / ');
  };
  api.ensureOnce = () => {
    // 整份脚本里最贵的就是扫一遍那条横带。补挂可能一帧一次，所以每次只扫一遍，锚点和诊断
    // 都用同一份结果。
    const strip = api.strip();
    const described = api.describeBar(strip);
    const found = api.anchor(strip);
    api.barInfo = described + (api.button && api.button.isConnected ? '' : '｜按钮当前不在页面里');
    if (!found) {
      const note = '播放栏里没找到可放一起听按钮的位置（' + described + '）';
      api.note = note;
      // 一次没挂上可能要连着追几十次，同一个原因别刷屏。
      if (!api.retries) { try { console.warn('[NEMusic] together anchor', note); } catch (error) {} }
      return note;
    }
    // 认评论那一档是插在它后面（分享原来在评论右边），其余都是插在前面。
    const sibling = found.after ? found.node.nextElementSibling : found.node;
    const button = api.button;
    // 在位 = 还在锚点旁边、而且看得见。少一个条件都会出事：页面把旧播放栏淡出时，按钮还连着、
    // 位置也没变，但已经看不见了，必须当成没在位重新挂到还亮着的那条播放栏上。
    const inPlace = button != null && button.isConnected && api.visible(button)
      && (found.after ? button.previousElementSibling === found.node : button.nextElementSibling === sibling);
    if (inPlace) {
      api.anchorName = found.selector;
      refreshMenu();
      return '';
    }
    if (!button || !button.isConnected) {
      const fresh = document.createElement('button');
      fresh.type = 'button';
      fresh.title = '一起听';
      fresh.setAttribute('aria-label', '一起听');
      fresh.setAttribute('aria-haspopup', 'true');
      fresh.setAttribute('aria-expanded', 'false');
      fresh.setAttribute('data-nemusic-together-button', '1');
      fresh.innerHTML = ${JSON.stringify(ICON)};
      fresh.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 4px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;opacity:.85';
      fresh.addEventListener('mouseenter', () => { fresh.style.opacity = '1'; });
      fresh.addEventListener('mouseleave', () => { fresh.style.opacity = '.85'; });
      fresh.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openMenu(); });
      api.button = fresh;
    }
    if (sibling) found.node.parentElement.insertBefore(api.button, sibling);
    else found.node.parentElement.append(api.button);
    api.anchorName = found.selector;
    api.note = '';
    return '';
  };
  /**
   * 补挂节奏。核心是「赶在下一次绘制之前」：插件那边再快也是秒级轮询，页面自己盯着才来得及。
   *
   * - DOM 变化 → requestAnimationFrame 里补。以前是 40ms 防抖，那一帧已经画出去了，用户看到的
   *   就是「一起听按钮消失又弹出来」。
   * - 补不上（切歌词界面那一下锚点还没渲染出来，或者按钮被 CSS 藏了）→ 继续追：头 16 次逐帧
   *   （约 270ms，正好盖住界面切换），然后 200ms，再往后 1 秒。只等下一次 DOM 变化的话，
   *   可能要等到插件 1.5 秒的轮询，那段时间按钮就是肉眼可见地没了。
   */
  api.scheduleHeal = delay => {
    const seq = ++api.healSeq;
    const fire = () => { if (seq === api.healSeq) api.heal(); };
    if (delay <= 0) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fire);
      else window.setTimeout(fire, 0);
    } else {
      window.clearTimeout(api.healTimer);
      api.healTimer = window.setTimeout(fire, delay);
    }
  };
  api.keepTrying = note => {
    const placed = api.button && api.button.isConnected && !note;
    if (placed) { api.retries = 0; return; }
    if (api.retries >= 40) return;
    api.retries += 1;
    api.scheduleHeal(api.retries <= 16 ? 0 : (api.retries <= 28 ? 200 : 1000));
  };
  api.heal = () => {
    api.healTimer = 0;
    api.ensure();
  };
  // 每次挂完都过一遍：没挂上就排下一次，挂上了就把追补的次数清零。
  api.ensure = () => {
    const note = api.ensureOnce();
    api.keepTrying(note);
    return note;
  };
  // 页面里改字改图太频繁，每次都全量扫一遍不划算：按钮还在位、锚点也有时，只有播放栏那条横带
  // 附近的变化才重挂，歌词、歌单列表那些一概不管。按钮已经被冲掉就没得挑，什么变化都得接。
  api.nearBar = node => {
    if (!api.middleY) return true;
    try {
      const rect = node.getBoundingClientRect();
      if (!rect || !rect.height) return true;
      const top = rect.top;
      const bottom = rect.top + rect.height;
      return bottom > api.middleY - 90 && top < api.middleY + 90;
    } catch (error) {
      return true;
    }
  };
  api.onMutations = mutations => {
    // 按钮被冲掉：从头开始追（之前可能已经追到上限停了）。
    if (!api.button || !api.button.isConnected) {
      api.retries = 0;
      api.scheduleHeal(0);
      return;
    }
    // 按钮被页面用 CSS 藏起来了——切歌词界面那一下常见的是旧播放栏淡出，纯样式变化、没有结构
    // 变化，光盯 childList 会漏掉。次数不清零：一直藏不起来的话，别让它变成满页扫的忙等。
    if (!api.visible(api.button)) {
      api.scheduleHeal(0);
      return;
    }
    // 按钮好好的：只有播放栏那条横带附近的结构变化才值得重挂（分享、评论被重新渲染会把我们
    // 顶掉）。样式变化一概不管，进度条每秒都在改 style，全量扫一遍纯属浪费。
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') continue;
      if (api.nearBar(mutation.target)) {
        api.scheduleHeal(0);
        return;
      }
    }
  };
  try {
    api.observer = new MutationObserver(api.onMutations);
    // class/style 也要盯：播放栏藏起来/露出来经常只改一个 class，没有结构变化，光盯 childList
    // 会漏掉，按钮就一直留在藏起来的那条播放栏里。
    api.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  } catch (error) {
    api.observer = null;
  }
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKey, true);
  window[key] = api;
  const note = api.ensure();
  api.note = note;
  return { ok: true, note, anchor: String(api.anchorName || ''), bar: String(api.barInfo || '') };
})()`;

/**
 * 页面脚本在位时的每 tick 调用：只重新确认按钮在不在位、刷新菜单状态，不重发整份脚本。
 * 识曲那边也是这么分的（recognitionUpdateScript / recognitionScript）。
 */
export const togetherButtonUpdateScript = (): string => `(() => {
  const api = window.__nemusicTogetherButton;
  if (!api || api.version !== ${BUTTON_API_VERSION}) return { ok: false, note: '页面脚本还没装上' };
  const note = api.ensure();
  return { ok: true, note, anchor: String(api.anchorName || ''), bar: String(api.barInfo || '') };
})()`;

/**
 * 取走页面按钮攒下的动作。由 TOGETHER_STATE_SCRIPT 顺带带回来，不额外多一次 CDP 往返。
 * 取走即清空，免得同一个动作被执行两遍。用 window 而不是 globalThis，和安装脚本保持一致。
 */
export const TOGETHER_PENDING_SCRIPT = `(() => {
  const api = window && window.__nemusicTogetherButton;
  const action = api && api.pending ? String(api.pending) : '';
  if (api) api.pending = '';
  return action;
})()`;
