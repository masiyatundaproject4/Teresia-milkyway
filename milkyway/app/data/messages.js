// Direct-message threads: history from the site API, sending straight to Supabase as the signed-in user
// (row-level security + the receiver's "who can message me" setting decide), and live delivery through
// Supabase Realtime (mw_messages is in the realtime publication).
import { config } from '../config.js';
import { api, rest, auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import { inbox } from './chats.js';
import { removeChatMedia, sendViewOnce, uploadChatMedia } from './chat-media.js';
import { containsPrivateContact, safePublicText } from './usernames.js';
import { profiles } from './profiles.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const listeners = new Set();
let channel = null;

/** Newest last. */
export async function loadThread(peer) {
  if (!UUID.test(peer)) throw new Error('Invalid conversation');
  const data = await api(`${config.api.message}?peer=${encodeURIComponent(peer)}`, { timeout: 12000 });
  return (data?.messages || []).slice().reverse();
}

export async function sendMessage(peer, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) throw new Error('Empty message');
  const rows = await rest('mw_messages?select=*', {
    method: 'POST', prefer: 'return=representation',
    body: { sender_id: auth.userId, receiver_id: peer, body: text },
  });
  const message = Array.isArray(rows) ? rows[0] : rows;
  inbox.refresh();
  return message;
}

export async function sendOneViewText(peer, body) {
  const text = String(body || '').trim().slice(0, 12000);
  if (!text) throw new Error('Empty message');
  const id = crypto.randomUUID();
  const message = await sendViewOnce({ id, receiver: peer, messageType: 'text', body: text });
  inbox.refresh();
  return message;
}

export async function sendDirectMedia(peer, { file, noteType = '', viewOnce = false, peaks = [] } = {}) {
  const id = crypto.randomUUID();
  const uploaded = await uploadChatMedia(file, { id, viewOnce });
  const messageType = noteType || uploaded.messageType;
  const labels = { image: 'Photo', video: 'Video', audio: 'Audio', voice_note: 'Voice note', video_note: 'Video note' };
  const metadata = noteType === 'voice_note' ? { waveform: peaks.slice(0, 120) } : {};
  try {
    let message;
    if (viewOnce) {
      message = await sendViewOnce({
        id, receiver: peer, messageType, body: '',
        bucket: uploaded.bucket, path: uploaded.path, mediaType: uploaded.mediaType, metadata,
      });
    } else {
      const rows = await rest('mw_messages?select=*', {
        method: 'POST', prefer: 'return=representation',
        body: {
          id, sender_id: auth.userId, receiver_id: peer, body: labels[messageType] || labels[uploaded.messageType],
          message_type: messageType, media_url: uploaded.url, media_type: uploaded.mediaType, media_metadata: metadata,
        },
      });
      message = Array.isArray(rows) ? rows[0] : rows;
    }
    inbox.refresh();
    return message;
  } catch (error) {
    await removeChatMedia(uploaded).catch(cleanupError => console.warn('[dm-media] failed to remove unlinked upload', cleanupError));
    throw error;
  }
}

/** Marks everything this peer sent me as read (the only column people may update on mw_messages). */
export function markRead(peer) {
  if (!auth.userId || !UUID.test(peer)) return Promise.resolve();
  return rest(`mw_messages?sender_id=eq.${peer}&receiver_id=eq.${auth.userId}&read_at=is.null`, {
    method: 'PATCH', body: { read_at: new Date().toISOString() },
  }).catch(() => {});
}

export async function deleteForMe(id) {
  await api(`${config.api.message}?action=hide`, { method: 'POST', body: { ids: [id] } });
}

/** fn({ type: 'INSERT' | 'UPDATE' | 'DELETE', message }) for messages I send or receive (any device). */
export function onMessage(fn) {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

async function connect() {
  if (channel || !auth.signedIn()) return;
  const me = auth.userId;
  try {
    const sb = await supabase();
    if (channel || auth.userId !== me) return;
    const emit = payload => {
      const message = payload.eventType === 'DELETE' ? payload.old : payload.new;
      listeners.forEach(fn => { try { fn({ type: payload.eventType, message }); } catch {} });
      if (payload.eventType === 'INSERT') inbox.refresh();
    };
    channel = sb.channel(`mw-dm-${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_messages', filter: `receiver_id=eq.${me}` }, emit)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_messages', filter: `sender_id=eq.${me}` }, emit)
      .subscribe();
  } catch { channel = null; }
}

bus.on('auth', async () => {
  const old = channel;
  channel = null;
  if (old) { try { (await supabase()).removeChannel(old); } catch {} }
  if (auth.signedIn() && listeners.size) connect();
});

/** People search for starting a new conversation (name or @username). */
export async function searchPeople(query) {
  const rawQuery = String(query || '').trim().replace(/^@/, '').replace(/\s+/g, ' ');
  if (rawQuery.length < 2 || rawQuery.length > 80 || containsPrivateContact(rawQuery)) return [];
  const q = rawQuery.replace(/[,()"\\]/g, '');
  if (q.length < 2) return [];
  const pattern = encodeURIComponent(`*${q.replace(/[\\%_]/g, '\\$&')}*`);
  const rows = await rest(`mw_profiles?select=id,display_name,username,avatar_url&or=(username.ilike.${pattern},display_name.ilike.${pattern})&order=created_at.desc&limit=1000`);
  const people = new Map();
  for (const row of rows || []) {
    if (!row || row.id == null || /^(?:null|undefined)$/i.test(String(row.id))
      || String(row.id) === auth.userId) continue;
    const person = {
      id: String(row.id),
      name: safePublicText(row.display_name) || safePublicText(row.username) || 'MilkyWay',
      username: safePublicText(row.username).replace(/^@/, '').toLowerCase(),
      avatar: safePublicText(row.avatar_url),
    };
    people.set(person.id, person);
  }
  for (const person of profiles.matching(q)) {
    if (person.id !== auth.userId && !people.has(person.id)) people.set(person.id, {
      id: person.id, name: person.name, username: person.username, avatar: person.avatar,
    });
  }
  return [...people.values()];
}
