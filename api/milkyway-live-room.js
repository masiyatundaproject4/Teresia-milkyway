import { route, ApiError, requireUuid, isUuid } from './_lib/supa.js';
import { LIVE_DEFAULTS as DEFAULTS, loadLiveSettings as loadSettings } from './_lib/live-policy.js';
import { livekit, livekitConfigured, retryRoomCleanups, closeRoom, CAMERA, MIC } from './_lib/livekit.js';

// Co-host Live rooms (TikTok-style guests). The client polls `status`; request/approve/mute/remove change who may
// publish. Publish rights are changed in LiveKit itself with the server secret, so a guest cannot grant themselves
// camera/mic access by editing database rows. Needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
//
//   GET  /api/milkyway-live-room?action=lives  → { sessions: [...] } Lives whose room is really running on LiveKit
//   POST /api/milkyway-live-room { room, action: 'status' | 'request' | 'approve' | ... }

const ROOM = /^mw-(audio|video)-live-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ADMISSIONS = ['approval', 'open', 'broadcast'];
const COMMENT_MODES = ['everyone', 'followers', 'off'];
const SLOW_MODES = [0, 3, 10, 30, 60];
const INVITE_TTL_MS = 3 * 60_000;
const cleanBackground = value => {
  if (typeof value !== 'string' || value.length > 2048) throw new ApiError(400, 'Enter a valid HTTPS background URL.');
  if (!value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { throw new ApiError(400, 'Enter a valid HTTPS background URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError(400, 'Background URLs must use HTTPS.');
  return url.href;
};

const sourcesFor = (audioRoom, micAllowed) => audioRoom ? (micAllowed ? [MIC] : []) : (micAllowed ? [CAMERA, MIC] : [CAMERA]);
// An empty source list means "every source" to LiveKit, so a guest left with no allowed source cannot publish at all.
const setPublish = (room, identity, allowed, audioRoom, environment, micAllowed = true) => {
  const sources = allowed ? sourcesFor(audioRoom, micAllowed) : [];
  return livekit('UpdateParticipant', room, {
    identity,
    permission: { canSubscribe: true, canPublish: sources.length > 0, canPublishData: true, canPublishSources: sources },
  }, null, environment);
};

async function revokePublish(room, identity, audioRoom, environment) {
  try {
    await setPublish(room, identity, false, audioRoom, environment);
  } catch {
    try {
      await livekit('RemoveParticipant', room, { identity }, null, environment);
    } catch {
      throw new ApiError(503, "LiveKit could not revoke this participant's publishing access.");
    }
  }
}

// Short cache so every viewer polling does not hit LiveKit each time.
const presence = new Map();
async function connectedIds(room, environment) {
  const cached = presence.get(room);
  if (cached && Date.now() - cached.at < 2000) return cached.ids;
  let ids = cached?.ids || [];
  try {
    const data = await livekit('ListParticipants', room, {}, null, environment);
    ids = (data?.participants || []).map(participant => participant.identity);
  } catch { /* keep the last known list */ }
  presence.set(room, { at: Date.now(), ids });
  if (presence.size > 500) presence.delete(presence.keys().next().value);
  return ids;
}

const profiles = new Map();
async function whoAmI(ctx) {
  const cached = profiles.get(ctx.user.id);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  const [row] = await ctx.rest(`mw_profiles?id=eq.${ctx.user.id}&select=display_name,username,avatar_url&limit=1`).catch(() => []) || [];
  const value = { name: String(row?.display_name || row?.username || ctx.user.user_metadata?.name || 'MilkyWay user').slice(0, 80), avatar: String(row?.avatar_url || '').slice(0, 500) };
  profiles.set(ctx.user.id, { at: Date.now(), value });
  if (profiles.size > 1000) profiles.delete(profiles.keys().next().value);
  return value;
}

async function loadRoom(ctx, body) {
  const roomName = typeof body.room === 'string' ? body.room : typeof body.roomName === 'string' ? body.roomName : '';
  if (!ROOM.test(roomName)) throw new ApiError(400, 'Invalid Live room.');
  const [record] = await ctx.rest(`mw_video_live_sessions?room_name=eq.${encodeURIComponent(roomName)}&select=id,host_id,is_live,title,scope&limit=1`) || [];
  if (!record) throw new ApiError(404, 'This Live session is no longer available.');
  const host = record.host_id === ctx.user.id;
  if (!host) {
    if (record.scope === 'followers') {
      const follows = await ctx.rest(`mw_follows?follower_id=eq.${ctx.user.id}&following_id=eq.${record.host_id}&select=follower_id&limit=1`);
      if (!follows?.length) throw new ApiError(403, 'This session is for followers only.');
    } else if (!['public', 'everyone'].includes(record.scope)) {
      throw new ApiError(403, 'This Live session is not available.');
    }
  }
  return { roomName, record, host, audio: roomName.startsWith('mw-audio-') };
}


const requireHost = room => { if (!room.host) throw new ApiError(403, 'Only the host can do this.'); };
const enc = encodeURIComponent;
const memberPath = (roomName, userId) => `mw_live_room_members?room_name=eq.${enc(roomName)}&user_id=eq.${userId}`;
const upsertMember = (ctx, roomName, userId, fields) => ctx.rest('mw_live_room_members?on_conflict=room_name,user_id', {
  method: 'POST', prefer: 'resolution=merge-duplicates', body: { room_name: roomName, user_id: userId, updated_at: new Date().toISOString(), ...fields },
});
const saveSettings = (ctx, room, settings) => ctx.rest('mw_live_room_settings?on_conflict=room_name', {
  method: 'POST', prefer: 'resolution=merge-duplicates', body: { room_name: room.roomName, host_id: ctx.user.id, settings, updated_at: new Date().toISOString() },
});
const speakersOf = async (ctx, roomName) => (await ctx.rest(`mw_live_room_members?room_name=eq.${enc(roomName)}&state=eq.speaker&select=user_id`)) || [];
const freshInvites = invites => Object.fromEntries(Object.entries(invites || {}).filter(([id, at]) => isUuid(id) && Date.now() - Number(at) < INVITE_TTL_MS));
const without = (list, id) => (list || []).filter(entry => entry !== id);
const withId = (list, id) => [...new Set([...(list || []), id])].slice(-500);
const kickedMessage = 'The host removed you from this LIVE.';

// What a viewer may know about the room. Filter words and pending invites of other people stay with the host.
function publicSettings(settings, userId) {
  const { filterWords, invites, ...rest } = settings;
  return { ...rest, filterWordCount: filterWords.length, invited: !!freshInvites(invites)[userId] };
}

async function status(ctx, room, { enter = false } = {}) {
  const me = await whoAmI(ctx);
  const [settings, rows, messages, connected] = await Promise.all([
    loadSettings(ctx, room.roomName),
    ctx.rest(`mw_live_room_members?room_name=eq.${enc(room.roomName)}&select=room_name,user_id,name,avatar,state,host_muted,updated_at&order=updated_at.desc&limit=200`),
    ctx.rest(`mw_live_room_messages?room_name=eq.${enc(room.roomName)}&select=id,user_id,name,avatar,kind,body,deleted,created_at&order=created_at.desc&limit=100`),
    connectedIds(room.roomName, ctx.env),
  ]);
  const myId = ctx.user.id.toLowerCase();
  if (!room.host && settings.blockedIds.includes(myId)) throw new ApiError(403, kickedMessage);
  let own = (rows || []).find(row => row.user_id === ctx.user.id);
  if (!room.host && !own) {
    await upsertMember(ctx, room.roomName, ctx.user.id, { name: me.name, avatar: me.avatar, state: 'viewer' }).catch(() => {});
    own = { room_name: room.roomName, user_id: ctx.user.id, name: me.name, avatar: me.avatar, state: 'viewer', host_muted: false };
  } else if (!room.host && enter && own.state !== 'viewer') {
    // Every visit starts as a subscriber: a seat or request left from an earlier visit is cleared, and the guest asks
    // again with "Request to join". LiveKit rights are revoked too in case an old connection is still around.
    await upsertMember(ctx, room.roomName, ctx.user.id, { state: 'viewer', host_muted: false });
    if (own.state === 'speaker') await revokePublish(room.roomName, ctx.user.id, room.audio, ctx.env);
    own = { ...own, state: 'viewer', host_muted: false };
    const i = (rows || []).findIndex(row => row.user_id === ctx.user.id);
    if (i >= 0) rows[i] = { ...rows[i], state: 'viewer', host_muted: false };
  }
  if (room.host && !(await ctx.rest(`mw_live_room_settings?room_name=eq.${enc(room.roomName)}&select=room_name&limit=1`).catch(() => [null]))?.length) {
    await ctx.rest('mw_live_room_settings', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: { room_name: room.roomName, host_id: ctx.user.id, settings: DEFAULTS } }).catch(() => {});
  }
  const invites = freshInvites(settings.invites);
  const online = new Set(connected);
  const toMember = row => ({
    roomName: row.room_name, userId: row.user_id, name: row.name, avatar: row.avatar, state: row.state, hostMuted: !!row.host_muted,
    online: online.has(row.user_id), commentMuted: settings.mutedIds.includes(row.user_id), blocked: settings.blockedIds.includes(row.user_id),
    invited: !!invites[row.user_id],
  });
  const self = room.host
    ? { userId: ctx.user.id, name: me.name, avatar: me.avatar, state: 'speaker', hostMuted: false, host: true }
    : { ...toMember(own), invited: !!invites[myId] };
  const members = (rows || []).filter(row => row.user_id !== room.record.host_id).map(toMember);
  return {
    settings: room.host ? { ...settings, invites } : publicSettings(settings, myId),
    self,
    // Viewers only need the people on stage; the host gets everyone for audience management.
    members: room.host ? members : members.filter(member => member.state === 'speaker'),
    messages: (messages || []).reverse().map(row => ({ id: row.id, userId: row.user_id, name: row.name, avatar: row.avatar, kind: row.kind, body: row.deleted ? '' : row.body, deleted: !!row.deleted, createdAt: row.created_at })),
    connected: room.host ? connected : [],
    viewerCount: Math.max(0, connected.filter(id => id !== room.record.host_id).length),
    isLive: room.record.is_live,
    title: room.record.title || '',
  };
}

function cleanWords(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
  return [...new Set(list.map(word => String(word).trim().toLowerCase().slice(0, 30)).filter(word => word.length >= 2))].slice(0, 50);
}

async function handle({ ctx, body, method }) {
  if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
  await retryRoomCleanups(ctx, 1);
  const action = String(body.action || 'status');
  const room = await loadRoom(ctx, body);
  const target = () => requireUuid(typeof body.target === 'string' ? body.target.toLowerCase() : '', 'participant');
  const me = ctx.user.id.toLowerCase();

  if (action === 'status') return status(ctx, room, { enter: body.enter === true });
  if (action === 'started') return { ok: true };
  if (!room.record.is_live && action !== 'end') throw new ApiError(404, 'This Live session has ended.');

  // ---- Audience actions -----------------------------------------------------------------------------------
  // Stage states: viewer (silent subscriber) → pending (asked to join) → speaker (may publish).
  // Only server-controlled host approval or open-seat allocation can write 'speaker'.
  const ownRow = async () => (await ctx.rest(`${memberPath(room.roomName, ctx.user.id)}&select=state,host_muted&limit=1`) || [])[0] || null;

  if (action === 'request' || action === 'accept-invite') {
    if (room.host) throw new ApiError(400, 'The host is already on stage.');
    const settings = await loadSettings(ctx, room.roomName);
    if (settings.blockedIds.includes(me)) throw new ApiError(403, kickedMessage);
    const existing = await ownRow();
    if (existing?.state === 'speaker') return { state: 'speaker' };
    const invited = !!freshInvites(settings.invites)[me];
    if (action === 'accept-invite' && !invited) throw new ApiError(410, 'This invitation has expired.');
    if (existing?.state === 'pending' && settings.admission !== 'open') return { state: 'pending' };
    if (!invited && (settings.admission === 'broadcast' || settings.allowRequests === false)) throw new ApiError(403, 'The host is not taking guest requests right now.');
    if (action === 'request' && !invited && settings.admission === 'open') {
      const user = await whoAmI(ctx);
      const granted = await setPublish(room.roomName, me, true, room.audio, ctx.env);
      if (!granted) throw new ApiError(409, 'You are no longer watching this LIVE.');
      try {
        await ctx.rpc('mw_live_room_allocate_guest_seat', {
          p_room_name: room.roomName,
          p_user_id: me,
          p_name: user.name,
          p_avatar: user.avatar,
        });
      } catch (error) {
        await revokePublish(room.roomName, me, room.audio, ctx.env);
        throw error;
      }
      return { state: 'speaker', invited: false };
    }
    if (existing?.state === 'pending') return { state: 'pending' };
    const seated = await speakersOf(ctx, room.roomName);
    if (seated.length >= settings.layout - 1) throw new ApiError(409, 'All guest seats are full.');
    const user = await whoAmI(ctx);
    const state = await ctx.rpc('mw_live_room_request', {
      p_room_name: room.roomName,
      p_name: user.name,
      p_avatar: user.avatar,
    });
    if (!['pending', 'speaker'].includes(state)) throw new ApiError(503, 'The LIVE request could not be saved.');
    return { state, invited };
  }

  if (action === 'cancel-request' || action === 'decline-invite' || action === 'leave-stage') {
    if (room.host) throw new ApiError(400, 'The host cannot leave the stage.');
    const existing = await ownRow();
    if (existing && existing.state !== 'viewer') await upsertMember(ctx, room.roomName, ctx.user.id, { state: 'viewer', host_muted: false });
    // Always revoke: a guest leaving must stop publishing even if the database was already updated.
    if (action === 'leave-stage' || existing?.state === 'speaker') await revokePublish(room.roomName, ctx.user.id, room.audio, ctx.env);
    return { state: 'viewer' };
  }

  if (action === 'resync') {
    // An approved guest whose connection does not carry publish rights yet (approved while reconnecting) asks for them
    // again. Granted only when the host's approval is on record.
    if (room.host) return { state: 'speaker' };
    const existing = await ownRow();
    if (existing?.state !== 'speaker') return { state: existing?.state || 'viewer' };
    const granted = await setPublish(room.roomName, ctx.user.id, true, room.audio, ctx.env, !existing.host_muted);
    return { state: 'speaker', granted: !!granted };
  }

  if (action === 'message') {
    const id = requireUuid(body.id, 'message');
    const text = typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
    if (!text) throw new ApiError(400, 'Write a message first.');
    return ctx.rpc('mw_live_room_send_message', { p_id: id, p_room_name: room.roomName, p_body: text });
  }

  if (action === 'message-status') {
    const id = requireUuid(body.id, 'message');
    const sender = requireUuid(body.sender, 'sender');
    const [message] = await ctx.rest(`mw_live_room_messages?id=eq.${id}&room_name=eq.${enc(room.roomName)}&user_id=eq.${sender}&kind=eq.chat&deleted=eq.false&select=id,user_id,name,body,created_at&limit=1`) || [];
    return { message: message ? { id: message.id, userId: message.user_id, name: message.name, body: message.body, createdAt: message.created_at } : null };
  }

  if (action === 'gift-status') {
    const id = requireUuid(body.id, 'gift');
    const sender = requireUuid(body.sender, 'sender');
    return { gift: await ctx.rpc('mw_live_room_gift_status', { p_id: id, p_room_name: room.roomName, p_sender: sender }) };
  }

  if (action === 'like') {
    const id = requireUuid(body.id, 'like');
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, 'Invalid like event.');
    return { like: await ctx.rpc('mw_live_room_send_like', { p_id: id, p_room_name: room.roomName, p_count: count }) };
  }

  if (action === 'like-status') {
    const id = requireUuid(body.id, 'like');
    const sender = requireUuid(body.sender, 'sender');
    return { like: await ctx.rpc('mw_live_room_like_status', { p_id: id, p_room_name: room.roomName, p_sender: sender }) };
  }

  // ---- Host controls --------------------------------------------------------------------------------------
  requireHost(room);
  const settings = await loadSettings(ctx, room.roomName);
  const update = async changes => {
    const next = { ...settings, ...changes, invites: freshInvites(changes.invites ?? settings.invites) };
    await saveSettings(ctx, room, next);
    return { ok: true, settings: next };
  };

  if (action === 'approve') {
    const userId = target();
    if (settings.blockedIds.includes(userId)) throw new ApiError(409, 'Unblock this person before inviting them on stage.');
    const [member] = await ctx.rest(`${memberPath(room.roomName, userId)}&select=user_id,state,name,avatar&limit=1`) || [];
    if (!member) throw new ApiError(404, 'That person is not in this Live.');
    if (member.state === 'speaker') return { ok: true, state: 'speaker' };
    if (member.state !== 'pending') throw new ApiError(409, 'This person cancelled their request.');
    // Upgrade the guest's live LiveKit connection to publisher. LiveKit answers "not found" when they already left.
    const granted = await setPublish(room.roomName, userId, true, room.audio, ctx.env);
    if (!granted) {
      await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'viewer', host_muted: false, updated_at: new Date().toISOString() } }).catch(() => {});
      throw new ApiError(409, 'This person is no longer watching.');
    }
    try {
      await ctx.rpc('mw_live_room_allocate_guest_seat', {
        p_room_name: room.roomName,
        p_user_id: userId,
        p_name: member.name || '',
        p_avatar: member.avatar || '',
      });
    } catch (error) {
      await revokePublish(room.roomName, userId, room.audio, ctx.env);
      throw error;
    }
    const { [userId]: wasInvited, ...invites } = freshInvites(settings.invites);
    if (wasInvited) await update({ invites });
    return { ok: true, state: 'speaker' };
  }

  if (action === 'reject' || action === 'remove') {
    const userId = target();
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'viewer', host_muted: false, updated_at: new Date().toISOString() } });
    await revokePublish(room.roomName, userId, room.audio, ctx.env);
    return { ok: true };
  }

  if (action === 'mute' || action === 'allow-mic') {
    // A host mute takes the microphone right away from the guest in LiveKit (their mic track is stopped by the
    // server), so it holds even against a modified client. "Allow mic" gives the right back; the guest unmutes.
    const userId = target();
    const muted = action === 'mute';
    const [member] = await ctx.rest(`${memberPath(room.roomName, userId)}&select=state,host_muted&limit=1`) || [];
    if (member?.state !== 'speaker') throw new ApiError(409, 'This person is not on stage.');
    await setPublish(room.roomName, userId, true, room.audio, ctx.env, !muted);
    try {
      await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { host_muted: muted, updated_at: new Date().toISOString() } });
    } catch (error) {
      try { await setPublish(room.roomName, userId, true, room.audio, ctx.env, !member.host_muted); }
      catch { await revokePublish(room.roomName, userId, room.audio, ctx.env); }
      throw error;
    }
    return { ok: true };
  }

  if (action === 'invite') {
    const userId = target();
    if (userId === me) throw new ApiError(400, 'You are already on stage.');
    if (settings.blockedIds.includes(userId)) throw new ApiError(409, 'Unblock this person before inviting them.');
    const speakers = await speakersOf(ctx, room.roomName);
    if (speakers.some(row => row.user_id === userId)) throw new ApiError(409, 'This person is already a guest.');
    if (speakers.length >= settings.layout - 1) throw new ApiError(409, 'All guest seats are full. Add more guest seats in Guest settings.');
    return update({ invites: { ...freshInvites(settings.invites), [userId]: Date.now() } });
  }

  if (action === 'cancel-invite') {
    const userId = target();
    const { [userId]: _gone, ...invites } = freshInvites(settings.invites);
    return update({ invites });
  }

  if (action === 'mute-comments' || action === 'unmute-comments') {
    const userId = target();
    return update({ mutedIds: action === 'mute-comments' ? withId(settings.mutedIds, userId) : without(settings.mutedIds, userId) });
  }

  if (action === 'kick') {
    // Remove from the LIVE: off stage, disconnected now, and refused if they try to come back.
    const userId = target();
    if (userId === me) throw new ApiError(400, 'You cannot remove yourself.');
    const { [userId]: _gone, ...invites } = freshInvites(settings.invites);
    const result = await update({ blockedIds: withId(settings.blockedIds, userId), invites });
    await ctx.rest(memberPath(room.roomName, userId), { method: 'PATCH', body: { state: 'viewer', host_muted: false, updated_at: new Date().toISOString() } });
    await revokePublish(room.roomName, userId, room.audio, ctx.env);
    await livekit('RemoveParticipant', room.roomName, { identity: userId }, null, ctx.env);
    presence.delete(room.roomName);
    return result;
  }

  if (action === 'unblock') return update({ blockedIds: without(settings.blockedIds, target()) });

  if (action === 'pin') {
    const id = requireUuid(body.id, 'message');
    const [row] = await ctx.rest(`mw_live_room_messages?id=eq.${id}&room_name=eq.${enc(room.roomName)}&select=id,user_id,name,body,deleted&limit=1`) || [];
    if (!row || row.deleted) throw new ApiError(404, 'That comment is no longer available.');
    return update({ pinned: { id: row.id, userId: row.user_id, name: row.name, body: row.body, at: Date.now() } });
  }

  if (action === 'unpin') return update({ pinned: null });

  if (action === 'settings') {
    const requestedLayout = Number.isInteger(body.layout) ? body.layout : Number(settings.layout) || 9;
    const layout = Math.max(2, Math.min(9, requestedLayout));
    if (layout < settings.layout) {
      const speakers = await speakersOf(ctx, room.roomName);
      if (speakers.length > layout - 1) throw new ApiError(409, 'Remove a guest from the stage before reducing the number of guest seats.');
    }
    const flag = (key) => typeof body[key] === 'boolean' ? body[key] : settings[key];
    return update({
      layout,
      admission: ADMISSIONS.includes(body.admission) ? body.admission : settings.admission,
      layoutStyle: ['fullscreen', 'featured'].includes(body.layoutStyle) ? body.layoutStyle : settings.layoutStyle,
      hostPosition: body.hostPosition === 'end' || body.hostPosition === 'start' ? body.hostPosition : settings.hostPosition,
      mobileLayout: body.mobileLayout === 'compact' || body.mobileLayout === 'stack' ? body.mobileLayout : settings.mobileLayout,
      featuredId: body.featuredId === null ? null : isUuid(body.featuredId) ? body.featuredId : settings.featuredId,
      order: Array.isArray(body.order) ? body.order.filter(isUuid).slice(0, 21) : settings.order || [],
      comments: COMMENT_MODES.includes(body.comments) ? body.comments : settings.comments,
      slowMode: SLOW_MODES.includes(body.slowMode) ? body.slowMode : settings.slowMode,
      filterWords: body.filterWords !== undefined ? cleanWords(body.filterWords) : settings.filterWords,
      filterLinks: flag('filterLinks'),
      giftsEnabled: flag('giftsEnabled'),
      likesEnabled: flag('likesEnabled'),
      showViewerCount: flag('showViewerCount'),
      allowRequests: flag('allowRequests'),
      showGuestSlots: flag('showGuestSlots'),
      hostBackground: body.hostBackground === undefined ? settings.hostBackground || '' : cleanBackground(body.hostBackground),
      hostBackgroundKind: ['image', 'video'].includes(body.hostBackgroundKind) ? body.hostBackgroundKind : settings.hostBackgroundKind === 'video' ? 'video' : 'image',
    });
  }

  if (action === 'title') {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    await ctx.rest(`mw_video_live_sessions?id=eq.${room.record.id}`, { method: 'PATCH', body: { title } });
    return { ok: true, title };
  }

  if (action === 'scope') {
    const scope = body.scope === 'followers' ? 'followers' : 'public';
    await ctx.rest(`mw_video_live_sessions?id=eq.${room.record.id}`, { method: 'PATCH', body: { scope } });
    return { ok: true, scope };
  }

  if (action === 'delete-message') {
    const id = requireUuid(body.id, 'message');
    await ctx.rest(`mw_live_room_messages?id=eq.${id}&room_name=eq.${enc(room.roomName)}`, { method: 'PATCH', body: { deleted: true } });
    if (settings.pinned?.id === id) await update({ pinned: null });
    return { ok: true };
  }

  if (action === 'end') {
    await ctx.rest(`mw_video_live_sessions?id=eq.${room.record.id}`, { method: 'PATCH', body: { is_live: false, ended_at: new Date().toISOString() } });
    const closed = await closeRoom(ctx, room.roomName);
    return { ok: true, cleanupPending: !closed };
  }

  throw new ApiError(400, 'Unsupported room action.');
}

// Lives directory: sessions marked live whose LiveKit room is really running (a host whose app closed without
// ending leaves a row behind; those are hidden instead of showing a room nobody can connect to).
const LIVE_SELECT = 'id,room_name,host_id,host_name,title,scope,is_live,started_at';
const STARTING_MS = 90_000;
async function lives({ ctx }) {
  const rows = (await ctx.rest(`mw_video_live_sessions?is_live=eq.true&select=${LIVE_SELECT}&order=started_at.desc&limit=60`)) || [];
  const named = rows.filter(row => ROOM.test(row.room_name || ''));
  if (!named.length || !livekitConfigured(ctx.env)) return { sessions: named, verified: false };
  let rooms;
  try {
    const data = await livekit('ListRooms', null, { names: named.map(row => row.room_name) }, { roomList: true }, ctx.env);
    rooms = new Map((data?.rooms || []).map(room => [room.name, room]));
  } catch { return { sessions: named, verified: false }; }
  const running = named.filter(row => {
    const room = rooms.get(row.room_name);
    if (room && Number(room.num_publishers ?? room.numPublishers ?? 0) > 0) return true;
    // Just started: the host may still be connecting their camera.
    return Date.now() - Date.parse(row.started_at || 0) < STARTING_MS;
  });
  return { sessions: running, verified: true };
}

export default route({ '': handle, lives: { auth: false, run: lives } });
