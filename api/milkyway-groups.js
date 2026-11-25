import { route, ApiError, requireUuid, eq, isUuid } from './_lib/supa.js';

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const groupName = value => {
  const name = text(value, 70);
  if (!name) throw new ApiError(400, 'Group name is required.');
  return name;
};
const groupJoinMode = value => {
  const mode = value == null || value === '' ? 'invite_only' : String(value);
  if (!['open', 'request_approval', 'invite_only'].includes(mode)) throw new ApiError(400, 'Invalid group join mode.');
  return mode;
};
const uuidList = (value, max = 255) => {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.filter(isUuid).map(id => id.toLowerCase()))].slice(0, max);
};
const groupId = (body, query) => requireUuid(String(body.group || body.id || query.id || query.group || ''), 'group');
const missingGroupColumn = (error, column) => error?.status === 400
  && new RegExp(`\\b${column}\\b`, 'i').test(String(error.message || ''))
  && /(does not exist|schema cache|could not find)/i.test(String(error.message || ''));
const activeMember = (member, group, userId) => ['active', 'approved'].includes(String(member?.join_status || '').toLowerCase())
  || ['admin', 'owner'].includes(String(member?.role || '').toLowerCase())
  || group?.created_by === userId;
const groupAdmin = (member, group, userId) => group?.created_by === userId
  || (['admin', 'co_admin', 'owner'].includes(String(member?.role || '').toLowerCase())
    && (['active', 'approved'].includes(String(member?.join_status || '').toLowerCase())
      || ['admin', 'co_admin', 'owner'].includes(String(member?.role || '').toLowerCase())));

async function groupAuthorization(ctx, group) {
  const [groups, members] = await Promise.all([
    ctx.rest(`mw_dm_groups?select=id,created_by&id=${eq(group)}&limit=1`),
    ctx.rest(`mw_dm_group_members?select=role,join_status&group_id=${eq(group)}&user_id=${eq(ctx.user.id)}&limit=1`),
  ]);
  return { group: groups?.[0], member: members?.[0] };
}

async function listGroupMemberships(ctx) {
  const filters = `user_id=${eq(ctx.user.id)}&limit=500`;
  const optionalColumns = new Set(['avatar_url', 'join_mode', 'created_by']);
  while (true) {
    const groupColumns = ['id', 'name', 'caption', ...optionalColumns, 'created_at'];
    const select = `role,join_status,joined_at,mw_dm_groups(${groupColumns.join(',')})`;
    try {
      return await ctx.rest(`mw_dm_group_members?select=${select}&${filters}`);
    } catch (error) {
      const missing = [...optionalColumns].find(column => missingGroupColumn(error, column));
      if (!missing) throw error;
      optionalColumns.delete(missing);
      console.warn(`[groups] mw_dm_groups.${missing} is unavailable; loading groups without it`);
    }
  }
}

async function listCreatedGroups(ctx) {
  const optionalColumns = new Set(['avatar_url', 'join_mode']);
  while (true) {
    const columns = ['id', 'name', 'caption', ...optionalColumns, 'created_by', 'created_at'];
    try {
      return await ctx.rest(`mw_dm_groups?select=${columns.join(',')}&created_by=${eq(ctx.user.id)}&order=created_at.desc&limit=500`);
    } catch (error) {
      const missing = [...optionalColumns].find(column => missingGroupColumn(error, column));
      if (!missing) throw error;
      optionalColumns.delete(missing);
      console.warn(`[groups] mw_dm_groups.${missing} is unavailable; loading created groups without it`);
    }
  }
}

export default route({
  list: async ({ ctx }) => {
    const [rows, created] = await Promise.all([listGroupMemberships(ctx), listCreatedGroups(ctx)]);
    const groupsById = new Map((rows || [])
      .filter(row => row.mw_dm_groups)
      .map(row => {
        const group = row.mw_dm_groups;
        const member = { role: row.role, join_status: row.join_status || '' };
        return [group.id, {
          id: group.id, name: group.name, caption: group.caption || '',
          avatar_url: group.avatar_url || '', join_mode: group.join_mode || 'invite_only',
          created_by: group.created_by || '', role: row.role, join_status: row.join_status || '',
          created_at: group.created_at,
          is_active: activeMember(member, group, ctx.user.id),
        }];
      }));
    for (const group of created || []) {
      if (!groupsById.has(group.id)) groupsById.set(group.id, {
        ...group, caption: group.caption || '', avatar_url: group.avatar_url || '',
        join_mode: group.join_mode || 'invite_only', role: 'owner', join_status: 'approved',
        is_active: true,
      });
    }
    const groups = [...groupsById.values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { groups };
  },

  discover: async ({ ctx, query }) => {
    const search = text(query.q, 50).replace(/[%*,()"\\]/g, '');
    const filter = search ? `&name=ilike.${encodeURIComponent(`*${search}*`)}` : '';
    const rows = await ctx.rest(`mw_dm_groups?select=id,name,caption,avatar_url,join_mode,created_at&join_mode=in.(open,request_approval)${filter}&order=created_at.desc&limit=50`);
    return { groups: rows || [] };
  },

  group: async ({ ctx, query, body }) => {
    const id = groupId(body, query);
    const [groups, members, blocked] = await Promise.all([
      ctx.rest(`mw_dm_groups?select=id,name,caption,description,avatar_url,join_mode,members_can_invite,created_by,created_at&id=${eq(id)}&limit=1`),
      ctx.rest(`mw_dm_group_members?select=user_id,role,join_status,joined_at,invited_by&group_id=${eq(id)}&order=joined_at.asc&limit=500`),
      ctx.rest(`mw_dm_group_blocks?select=user_id,created_at&group_id=${eq(id)}&limit=500`).catch(error => {
        if (error.status === 403) return [];
        throw error;
      }),
    ]);
    const group = groups?.[0];
    const mine = (members || []).find(member => member.user_id === ctx.user.id);
    if (!group || (!mine && group.created_by !== ctx.user.id
      && !['open', 'request_approval'].includes(group.join_mode))) throw new ApiError(404, 'Group not found.');
    return {
      group: {
        ...group, caption: group.caption || '', description: group.description || '',
        avatar_url: group.avatar_url || '', join_mode: group.join_mode || 'invite_only',
        members_can_invite: group.members_can_invite !== false,
        role: mine?.role || (group.created_by === ctx.user.id ? 'owner' : ''),
        join_status: mine?.join_status || (group.created_by === ctx.user.id ? 'approved' : ''),
      },
      members: members || [], blocked: blocked || [],
    };
  },

  create: async ({ ctx, body }) => {
    const id = await ctx.rpc('mw_group_create_advanced', {
      p_name: groupName(body.name),
      p_caption: text(body.caption, 120),
      p_description: text(body.description, 1000),
      p_avatar_url: text(body.avatarUrl, 1000),
      p_join_mode: groupJoinMode(body.joinMode),
      p_members_can_invite: body.membersCanInvite !== false,
      p_members: uuidList(body.members),
    });
    const groups = await ctx.rest(`mw_dm_groups?select=id,name,caption,description,avatar_url,join_mode,members_can_invite,created_by,created_at&id=${eq(id)}&limit=1`);
    return { group: { ...(groups?.[0] || { id, name: groupName(body.name) }), role: 'admin' } };
  },

  update: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_update_settings', {
      p_group: groupId(body, query),
      p_name: groupName(body.name),
      p_caption: text(body.caption, 120),
      p_description: text(body.description, 1000),
      p_avatar_url: text(body.avatarUrl, 1000),
      p_join_mode: groupJoinMode(body.joinMode),
      p_members_can_invite: body.membersCanInvite !== false,
    });
    return { ok: true };
  },

  'add-member': async ({ ctx, body, query }) => {
    const added = await ctx.rpc('mw_group_add_members', {
      p_group: groupId(body, query),
      p_users: uuidList(body.userIds || body.members),
    });
    return { added: Number(added) || 0 };
  },

  'set-role': async ({ ctx, body, query }) => {
    const role = String(body.role || '');
    if (!['admin', 'co_admin', 'member'].includes(role)) throw new ApiError(400, 'Invalid role.');
    await ctx.rpc('mw_group_set_role', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user'), p_role: role });
    return { ok: true };
  },

  join: async ({ ctx, body, query }) => {
    const status = await ctx.rpc('mw_group_join', { p_group: groupId(body, query) });
    return { status };
  },

  'decide-request': async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_join_request_decide', {
      p_group: groupId(body, query),
      p_user: requireUuid(body.userId, 'user'),
      p_approve: body.approve === true,
    });
    return { ok: true };
  },

  'remove-member': async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_remove_member', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user'), p_block: body.block === true });
    return { ok: true };
  },

  unblock: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_unblock', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user') });
    return { ok: true };
  },

  leave: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_leave', { p_group: groupId(body, query) });
    return { ok: true };
  },

  delete: async ({ ctx, body, query }) => {
    const group = groupId(body, query);
    const access = await groupAuthorization(ctx, group);
    if (!access.group || !groupAdmin(access.member, access.group, ctx.user.id)) {
      throw new ApiError(403, 'Only group admins or the creator can delete the group.');
    }
    await ctx.rpc('mw_group_delete', { p_group: group });
    return { ok: true };
  },

  'clear-messages': async ({ ctx, body, query }) => {
    const group = groupId(body, query);
    const access = await groupAuthorization(ctx, group);
    if (!access.group || !groupAdmin(access.member, access.group, ctx.user.id)) {
      throw new ApiError(403, 'Only group admins or the creator can clear messages.');
    }
    await ctx.rest(`mw_dm_group_messages?group_id=${eq(group)}`, { method: 'DELETE' });
    return { ok: true };
  },

  send: async ({ ctx, body }) => {
    const group = requireUuid(String(body.group || ''), 'group');
    const message = String(body.body ?? '').trim();
    if (!message || message.length > 4000) throw new ApiError(400, 'Message must be 1-4000 characters.');
    const messageType = String(body.messageType || 'text');
    if (!['text', 'image', 'video', 'audio', 'voice_note', 'video_note'].includes(messageType)) {
      throw new ApiError(400, 'Unsupported message type.');
    }
    if (body.viewOnce === true) throw new ApiError(400, 'Use the one-view message action for self-destructing media.');
    const mediaUrl = text(body.mediaUrl, 2000);
    const mediaType = text(body.mediaType, 100);
    if (messageType !== 'text' && (!mediaUrl.startsWith('https://') || !/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(mediaType))) {
      throw new ApiError(400, 'Media attachment is invalid.');
    }
    const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
    const row = {
      group_id: group, sender_id: ctx.user.id, body: message,
      message_type: messageType, media_url: mediaUrl, media_type: mediaType, media_metadata: metadata,
    };
    if (isUuid(body.id)) row.id = body.id;
    // A retried send with the same client id is ignored rather than duplicated.
    const rows = await ctx.rest('mw_dm_group_messages?on_conflict=id', { method: 'POST', body: row, returning: true });
    return { message: rows?.[0] || { ...row, created_at: new Date().toISOString() } };
  },

  walkie: async ({ ctx, body }) => {
    const group = requireUuid(String(body.group || ''), 'group');
    const id = requireUuid(String(body.id || ''), 'message');
    const mediaType = String(body.mediaType || '').split(';', 1)[0].trim().toLowerCase();
    if (!['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav'].includes(mediaType)) {
      throw new ApiError(400, 'Unsupported Walkie-Talkie audio type.');
    }
    const storagePath = `${group}/${ctx.user.id}/${id}`;
    if (body.storagePath !== storagePath) throw new ApiError(400, 'Invalid Walkie-Talkie upload path.');
    await requireActiveGroupMember(ctx, group);
    const row = {
      id, group_id: group, sender_id: ctx.user.id, body: 'Walkie-Talkie transmission',
      message_type: 'voice_note', media_url: '', media_type: mediaType,
      media_metadata: { walkie: true, storage_path: storagePath },
    };
    const rows = await ctx.rest('mw_dm_group_messages?on_conflict=id', {
      method: 'POST', body: row, returning: true,
    });
    return { message: rows?.[0] || { ...row, created_at: new Date().toISOString() } };
  },

  'walkie-history': async ({ ctx, query, body }) => {
    const group = groupId(body, query);
    await requireActiveGroupMember(ctx, group);
    const walkieFilter = encodeURIComponent('media_metadata->>walkie');
    const rows = await ctx.rest(
      `mw_dm_group_messages?select=id,group_id,sender_id,body,created_at,message_type,media_type,media_metadata&group_id=${eq(group)}&message_type=eq.voice_note&${walkieFilter}=eq.true&order=created_at.desc&limit=100`,
    );
    const message = (rows || []).find(row => row.media_metadata?.storage_path === `${group}/${row.sender_id}/${row.id}`);
    return { message: message || null };
  },

  messages: async ({ ctx, query, body }) => {
    const group = groupId(body, query);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 200);
    const rows = await ctx.rest(`mw_dm_group_messages?select=id,sender_id,body,created_at,edited_at,message_type,media_url,media_type,media_metadata,view_once,viewed_at&group_id=${eq(group)}&order=created_at.desc&limit=${limit}`);
    return { messages: rows || [] };
  },

  'delete-message': async ({ ctx, body }) => {
    const id = requireUuid(String(body.id || ''), 'message');
    const rows = await ctx.rest(`mw_dm_group_messages?select=id,group_id,sender_id&id=${eq(id)}&limit=1`);
    const message = rows?.[0];
    if (!message) return { ok: true };
    if (body.group && requireUuid(String(body.group), 'group') !== message.group_id) {
      throw new ApiError(400, 'Message does not belong to this group.');
    }
    const access = await groupAuthorization(ctx, message.group_id);
    if (message.sender_id !== ctx.user.id && (!access.group || !groupAdmin(access.member, access.group, ctx.user.id))) {
      throw new ApiError(403, 'Only the sender or a group admin can delete this message.');
    }
    await ctx.rest(`mw_dm_group_messages?id=${eq(id)}&group_id=${eq(message.group_id)}`, { method: 'DELETE' });
    return { ok: true };
  },
});
