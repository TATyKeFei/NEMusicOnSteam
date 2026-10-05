export const ROOM_HOST_HELPER = `  const isRoomHost = (together, ownUid, roomId) => {
    const status = String(together.status || '');
    if (status === 'togetherOwner' || status === 'waiting' || status === 'opening') return true;
    const saved = globalThis.__NEMusicOnSteamRoom;
    const pending = saved?.pending && Number(saved.expiresAt || 0) > Date.now();
    const sameRoom = saved?.roomId
      ? String(saved.roomId) === roomId
      : !!pending;
    const creatorId = String(together.roomInfo?.creatorId || together.creatorId
      || (sameRoom ? saved?.creatorId : '') || '');
    if (roomId && ownUid && creatorId === ownUid) return true;
    return saved?.createdByUs === true && sameRoom
      && (!saved.ownerUid || String(saved.ownerUid) === ownUid || (!ownUid && pending));
  };`;
