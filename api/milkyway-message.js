import { SUPABASE, supabaseKey } from './_lib/supa.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_HIDE = 200;
const MESSAGE_TYPES = new Set(['text', 'image', 'video', 'audio', 'voice_note', 'video_note']);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const storagePath = value => String(value || '').split('/').map(encodeURIComponent).join('/');

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in first' });
  // The app does not send an apikey header with site API calls, so this must not depend on a server env var.
  const key = supabaseKey(req);
  const headers = { Authorization: auth, apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const rest = async (path, init = {}) => {
    const response = await fetch(`${SUPABASE}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const status = response.status === 401 ? 401 : data?.code === 'P0002' ? 404 : data?.code === '22023' ? 400 : response.status === 404 || response.status >= 500 ? 503 : 403;
      throw new HttpError(status, status === 503 ? 'Message service unavailable' : data?.message || 'Not allowed');
    }
    return data;
  };
  try {
    const userRes = await fetch(`${SUPABASE}/auth/v1/user`, { headers: { Authorization: auth, apikey: key } });
    const user = await userRes.json();
    if (!user?.id) return res.status(401).json({ error: 'Invalid session' });

    const params = new URL(req.url, 'http://localhost').searchParams;
    const action = params.get('action') || '';
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const groupId = String(params.get('group') || body.group || '');
    const isGroup = groupId !== '';
    if (isGroup && !UUID.test(groupId)) throw new HttpError(400, 'Invalid group');

    // Messages this person removed with "Delete for me" stay for everyone else.
    const visible = async rows => {
      if (!rows?.length) return rows || [];
      const ids = rows.map(row => row.id).filter(id => UUID.test(id));
      if (!ids.length) return rows;
      const query = column => rest(`mw_message_hides?select=message_id&${column}=eq.${user.id}&message_id=in.(${ids.join(',')})&limit=${ids.length}`);
      // Older Supabase layouts name the column owner_id (the repair SQL renames it to user_id). Hidden-message lookup
      // must never stop the conversation itself from loading.
      const found = await query('user_id').catch(() => query('owner_id')).catch(() => []);
      const hidden = new Set((found || []).map(row => row.message_id));
      return rows.filter(row => !hidden.has(row.id));
    };

    if (req.method === 'POST' && action === 'send-once') {
      const id = String(body.id || '');
      const group = String(body.group || '');
      const receiver = String(body.receiver || '');
      const messageType = String(body.messageType || 'text');
      const mediaPath = String(body.path || '');
      const mediaBucket = String(body.bucket || '');
      const mediaType = String(body.mediaType || '');
      if (!UUID.test(id) || (group && !UUID.test(group)) || (!group && !UUID.test(receiver))) {
        throw new HttpError(400, 'Invalid conversation or message.');
      }
      if (!MESSAGE_TYPES.has(messageType)) throw new HttpError(400, 'Unsupported message type.');
      if (messageType !== 'text' && (!mediaPath || mediaBucket !== 'mw-dm-ephemeral')) {
        throw new HttpError(400, 'Private media upload is missing.');
      }
      if (messageType === 'text' && String(body.body || '').trim().length > 12000) {
        throw new HttpError(400, 'Message is too long.');
      }
      const message = await rest('rpc/mw_message_send_once', {
        method: 'POST',
        body: JSON.stringify({
          p_receiver: group ? null : receiver,
          p_group: group || null,
          p_id: id,
          p_body: typeof body.body === 'string' ? body.body : '',
          p_type: messageType,
          p_bucket: mediaBucket,
          p_path: mediaPath,
          p_content_type: mediaType,
          p_metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        }),
      });
      return res.status(200).json({ message });
    }

    if (req.method === 'POST' && action === 'consume-once') {
      const id = String(body.id || '');
      const group = String(body.group || '');
      if (!UUID.test(id) || (group && !UUID.test(group))) throw new HttpError(400, 'Invalid message.');
      const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
      const args = { p_id: id, p_group: group || null };
      let consumed;
      try { consumed = await rpc('mw_message_consume_once', args); }
      catch (error) { throw error; }
      const payload = consumed?.payload || {};
      if (!payload.bucket) {
        await rpc('mw_message_complete_once', args);
        res.setHeader('Cache-Control', 'no-store, private, max-age=0');
        return res.status(200).json({ body: String(payload.body || '') });
      }
      if (payload.bucket !== 'mw-dm-ephemeral' || !payload.object_path) {
        await rpc('mw_message_release_once', args);
        throw new HttpError(503, 'Private media reference is invalid.');
      }
      const objectUrl = `${SUPABASE}/storage/v1/object/${encodeURIComponent(payload.bucket)}/${storagePath(payload.object_path)}`;
      let mediaResponse;
      try {
        mediaResponse = await fetch(objectUrl, { headers: { Authorization: auth, apikey: key }, signal: AbortSignal.timeout(45000) });
      } catch {
        await rpc('mw_message_release_once', args);
        throw new HttpError(503, 'Could not load the one-view media. You can try again.');
      }
      if (!mediaResponse.ok) {
        await rpc('mw_message_release_once', args);
        throw new HttpError(mediaResponse.status === 404 ? 404 : 503, mediaResponse.status === 404 ? 'One-view media is no longer available.' : 'Could not load the one-view media. You can try again.');
      }
      const mediaBytes = new Uint8Array(await mediaResponse.arrayBuffer());
      const removeResponse = await fetch(`${SUPABASE}/storage/v1/object/${encodeURIComponent(payload.bucket)}`, {
        method: 'DELETE',
        headers: { Authorization: auth, apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [payload.object_path] }),
        signal: AbortSignal.timeout(20000),
      });
      if (!removeResponse.ok) {
        await rpc('mw_message_release_once', args);
        throw new HttpError(503, 'Could not securely delete the viewed media. Please try again.');
      }
      await rpc('mw_message_complete_once', args);
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      res.setHeader('Content-Type', String(payload.content_type || 'application/octet-stream'));
      res.setHeader('Content-Length', String(mediaBytes.byteLength));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      return res.status(200).send(mediaBytes);
    }

    if (req.method === 'GET') {
      if (isGroup) {
        const rows = await rest(`mw_dm_group_messages?select=id,sender_id,body,created_at,edited_at&group_id=eq.${groupId}&order=created_at.desc&limit=200`);
        return res.status(200).json({ messages: await visible(rows) });
      }
      if (action === 'inbox') {
        const rows = await rest(`mw_messages?select=*&or=(sender_id.eq.${user.id},receiver_id.eq.${user.id})&order=created_at.desc&limit=200`);
        return res.status(200).json({ messages: await visible(rows) });
      }
      const peer = params.get('peer') || '';
      if (!UUID.test(peer)) throw new HttpError(400, 'Invalid conversation');
      const filter = `or=(and(sender_id.eq.${user.id},receiver_id.eq.${peer}),and(sender_id.eq.${peer},receiver_id.eq.${user.id}))`;
      const rows = await rest(`mw_messages?select=*&${filter}&order=created_at.desc&limit=100`);
      return res.status(200).json({ messages: await visible(rows) });
    }

    if (req.method === 'POST' && action === 'hide') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(id => typeof id === 'string' && UUID.test(id)).slice(0, MAX_HIDE);
      if (!ids.length) throw new HttpError(400, 'Nothing to delete');
      const scope = isGroup ? 'group' : 'dm';
      const save = (path, rows) => rest(path, { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      try { await save('mw_message_hides?on_conflict=user_id,message_id', ids.map(id => ({ user_id: user.id, message_id: id, scope }))); }
      catch (error) {
        if (error.status === 401) throw error;
        // Older layout (owner_id, no scope) until the repair SQL is applied.
        await save('mw_message_hides?on_conflict=owner_id,message_id', ids.map(id => ({ owner_id: user.id, message_id: id })));
      }
      return res.status(200).json({ ok: true, hidden: ids.length });
    }

    if (req.method === 'POST') {
      const id = String(body.id || '');
      const text = typeof body.message === 'string' ? body.message.trim() : '';
      if (!UUID.test(id)) throw new HttpError(400, 'Invalid message ID');
      if (!text) throw new HttpError(400, 'Write a message first');
      await rest('rpc/mw_message_edit', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ p_id: id, p_group: isGroup, p_body: text }) });
      return res.status(200).json({ ok: true, edited: id });
    }

    if (req.method === 'DELETE') {
      const id = params.get('id') || '';
      if (!UUID.test(id)) throw new HttpError(400, 'Invalid message ID');
      const table = isGroup ? `mw_dm_group_messages?id=eq.${id}&group_id=eq.${groupId}` : `mw_messages?id=eq.${id}`;
      // The sender filter and row-level security both limit "Delete for everyone" to the person who sent it.
      const removed = await rest(`${table}&sender_id=eq.${user.id}`, { method: 'DELETE' });
      if (!Array.isArray(removed) || !removed.length) throw new HttpError(404, 'Message not found or not yours to delete');
      return res.status(200).json({ ok: true, deleted: id });
    }
    return res.status(405).json({ error: 'This message action is not available.' });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    return res.status(503).json({ error: 'Message service unavailable' });
  }
}
