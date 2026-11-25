// Group chat API and Realtime delivery, kept separate from direct-message threads.
import { config } from '../config.js';
import { api, auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import {
  downloadGroupWalkieMedia, removeChatMedia, removeGroupWalkieMedia,
  sendViewOnce, uploadChatMedia, uploadGroupWalkieMedia,
} from './chat-media.js';

const endpoint = config.api.groups;
const listeners = new Set();
let channel = null;
const groupChannels = new Map();

const request = (action, options = {}, query = '') => api(`${endpoint}?action=${encodeURIComponent(action)}${query}`, options);
export function isActiveGroupMember(membership, { userId = auth.userId, createdBy = membership?.created_by } = {}) {
  const status = String(membership?.join_status || '').toLowerCase();
  const role = String(membership?.role || '').toLowerCase();
  return ['active', 'approved'].includes(status)
    || ['admin', 'owner'].includes(role)
    || Boolean(userId && membership?.created_by === userId)
    || Boolean(createdBy && membership?.user_id === createdBy);
}
const notify = (subscribers, payload) => subscribers.forEach(listener => {
  try { listener(payload); } catch (error) { console.error('[groups] message listener failed', error); }
});

export async function loadGroups() {
  const data = await request('list', { timeout: 12000 });
  return data?.groups || [];
}

export async function discoverGroups(query = '') {
  const suffix = query ? `&q=${encodeURIComponent(query)}` : '';
  const data = await api(`${endpoint}?action=discover${suffix}`, { timeout: 12000 });
  return data?.groups || [];
}

export async function loadGroup(id) {
  return request('group', { timeout: 12000 }, `&id=${encodeURIComponent(id)}`);
}

export async function createGroup(options) {
  return request('create', { method: 'POST', body: options });
}

export async function updateGroup(options) {
  return request('update', { method: 'POST', body: options });
}

export async function addGroupMembers(group, userIds) {
  return request('add-member', { method: 'POST', body: { group, userIds } });
}

export async function setGroupRole(group, userId, role) {
  return request('set-role', { method: 'POST', body: { group, userId, role } });
}

export async function removeGroupMember(group, userId, block = false) {
  return request('remove-member', { method: 'POST', body: { group, userId, block } });
}

export async function decideGroupRequest(group, userId, approve) {
  return request('decide-request', { method: 'POST', body: { group, userId, approve } });
}

export async function joinGroup(group) {
  return request('join', { method: 'POST', body: { group } });
}

export async function leaveGroup(group) {
  return request('leave', { method: 'POST', body: { group } });
}

export async function deleteGroup(group) {
  return request('delete', { method: 'POST', body: { group } });
}

export async function deleteGroupMessage(group, id) {
  return request('delete-message', { method: 'POST', body: { group, id } });
}

export async function clearGroupMessages(group) {
  return request('clear-messages', { method: 'POST', body: { group } });
}

export async function loadGroupMessages(group) {
  const data = await request('messages', { timeout: 12000 }, `&group=${encodeURIComponent(group)}`);
  return (data?.messages || []).slice().reverse();
}

export async function sendGroupMessage(group, body, options = {}) {
  return request('send', { method: 'POST', body: { group, body, ...options } });
}

export async function sendGroupOneViewText(group, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) throw new Error('Empty message');
  return sendViewOnce({ id: crypto.randomUUID(), group, messageType: 'text', body: text });
}

export async function sendGroupMedia(group, { file, noteType = '', viewOnce = false, peaks = [] } = {}) {
  const id = crypto.randomUUID();
  const uploaded = await uploadChatMedia(file, { id, viewOnce });
  const messageType = noteType || uploaded.messageType;
  const labels = { image: 'Photo', video: 'Video', audio: 'Audio', voice_note: 'Voice note', video_note: 'Video note' };
  const metadata = noteType === 'voice_note' ? { waveform: peaks.slice(0, 120) } : {};
  try {
    if (viewOnce) {
      return await sendViewOnce({
        id, group, messageType, body: '',
        bucket: uploaded.bucket, path: uploaded.path, mediaType: uploaded.mediaType, metadata,
      });
    }
    return await request('send', {
      method: 'POST',
      body: {
        group, id, body: labels[messageType] || labels[uploaded.messageType],
        messageType, mediaUrl: uploaded.url, mediaType: uploaded.mediaType, metadata,
      },
    });
  } catch (error) {
    await removeChatMedia(uploaded).catch(cleanupError => console.warn('[dm-media] failed to remove unlinked upload', cleanupError));
    throw error;
  }
}

export async function sendGroupWalkie(group, file) {
  const id = crypto.randomUUID();
  const uploaded = await uploadGroupWalkieMedia(group, file, id);
  try {
    const data = await request('walkie', {
      method: 'POST',
      body: { group, id, storagePath: uploaded.path, mediaType: uploaded.mediaType },
    });
    return data?.message;
  } catch (error) {
    await removeGroupWalkieMedia(uploaded.path).catch(cleanupError => {
      console.warn('[walkie] failed to remove unlinked upload', cleanupError);
    });
    throw error;
  }
}

export async function loadLatestGroupWalkie(group) {
  const data = await request('walkie-history', { timeout: 12000 }, `&group=${encodeURIComponent(group)}`);
  return data?.message || null;
}

export async function downloadGroupWalkie(group, sender, id) {
  const path = `${group}/${sender}/${id}`;
  return downloadGroupWalkieMedia(path);
}

export function onGroupMessage(listener, groupId = '') {
  if (!groupId) {
    listeners.add(listener);
    connect();
    return () => listeners.delete(listener);
  }
  const id = String(groupId);
  let entry = groupChannels.get(id);
  if (!entry) {
    entry = { listeners: new Set(), channel: null, connecting: false };
    groupChannels.set(id, entry);
  }
  entry.listeners.add(listener);
  connectGroup(id, entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size || groupChannels.get(id) !== entry) return;
    groupChannels.delete(id);
    if (entry.channel) removeChannel(entry.channel);
    entry.channel = null;
  };
}

async function connect() {
  if (channel || !auth.signedIn()) return;
  const me = auth.userId;
  try {
    const client = await supabase();
    if (channel || auth.userId !== me) return;
    channel = client.channel(`mw-dm-groups-${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_dm_group_messages' }, payload => {
        const message = payload.eventType === 'DELETE' ? payload.old : payload.new;
        notify(listeners, { type: payload.eventType, message });
      })
      .subscribe();
  } catch (error) {
    channel = null;
    console.warn('[groups] realtime connection failed', error);
  }
}

async function connectGroup(id, entry) {
  if (entry.channel || entry.connecting || !entry.listeners.size || !auth.signedIn()) return;
  entry.connecting = true;
  const me = auth.userId;
  try {
    const client = await supabase();
    if (auth.userId !== me || groupChannels.get(id) !== entry || !entry.listeners.size) return;
    const scopedChannel = client.channel(`mw-dm-group-walkie-${id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'mw_dm_group_messages',
        filter: `group_id=eq.${id}`,
      }, payload => {
        const message = payload.eventType === 'DELETE' ? payload.old : payload.new;
        notify(entry.listeners, { type: payload.eventType, message });
      })
      .subscribe();
    entry.channel = scopedChannel;
  } catch (error) {
    console.warn('[walkie] group realtime connection failed', error);
  } finally {
    entry.connecting = false;
  }
}

async function removeChannel(target) {
  try { await (await supabase()).removeChannel(target); }
  catch (error) { console.warn('[groups] realtime cleanup failed', error); }
}

bus.on('auth', async () => {
  const old = channel;
  channel = null;
  const scoped = [...groupChannels.entries()].map(([id, entry]) => {
    const oldChannel = entry.channel;
    entry.channel = null;
    entry.connecting = false;
    return [id, entry, oldChannel];
  });
  if (old) await removeChannel(old);
  await Promise.all(scoped.map(([, , oldChannel]) => oldChannel && removeChannel(oldChannel)));
  if (!auth.signedIn()) {
    groupChannels.clear();
    return;
  }
  if (listeners.size) connect();
  scoped.forEach(([id, entry]) => {
    if (entry.listeners.size) connectGroup(id, entry);
    else groupChannels.delete(id);
  });
});
