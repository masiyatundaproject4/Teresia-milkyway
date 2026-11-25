import {
  createCipheriv, createECDH, createPrivateKey, createSign, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { authenticate, SUPABASE } from './_lib/supa.js';

const env = name => (process.env[name] || '').trim();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let googleToken;

function firebaseConfig() {
  const raw = env('FIREBASE_WEB_CONFIG');
  if (!raw) return null;
  try {
    const config = JSON.parse(raw);
    const required = ['apiKey', 'appId', 'projectId', 'messagingSenderId'];
    if (!required.every(key => typeof config[key] === 'string' && config[key])) return null;
    return {
      ...Object.fromEntries([...required, 'authDomain', 'storageBucket', 'measurementId'].filter(key => config[key]).map(key => [key, config[key]])),
      senderId: config.messagingSenderId,
    };
  } catch { return null; }
}

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

function constantTimeMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function serviceRequest(path, { method = 'GET', body } = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  const response = await fetch(`${SUPABASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Push delivery database request failed (${response.status}).`);
  return response;
}

async function firebaseAccessToken(account) {
  if (googleToken && googleToken.expiresAt > Date.now() + 60_000) return googleToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.access_token !== 'string') throw new Error('Firebase OAuth token request failed.');
  googleToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return googleToken.value;
}

async function firebaseAccount() {
  const raw = env('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!raw) return null;
  try {
    const account = JSON.parse(raw);
    return account.project_id && account.client_email && account.private_key ? account : null;
  } catch { return null; }
}

async function sendFcm(account, token, notification, data, ttl) {
  const accessToken = await firebaseAccessToken(account);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification,
        data,
        android: {
          priority: ttl <= 60 ? 'HIGH' : 'NORMAL',
          ttl: `${ttl}s`,
          notification: { channel_id: 'milkyway_default', sound: 'default' },
        },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = result?.error?.details?.find(item => item.errorCode)?.errorCode || result?.error?.status || '';
    if (code === 'UNREGISTERED') {
      await serviceRequest(`mw_fcm_devices?token=eq.${encodeURIComponent(token)}`, { method: 'DELETE' });
      return false;
    }
    throw new Error(`FCM delivery failed (${response.status}).`);
  }
  return true;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='), 'base64');
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function hkdfExpand(pseudorandomKey, info, length) {
  const chunks = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1, total = 0; total < length; counter++) {
    previous = createHmac('sha256', pseudorandomKey)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    chunks.push(previous);
    total += previous.length;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function webPushPayload(subscription, payload) {
  const receiverKey = decodeBase64Url(subscription.p256dh);
  const authSecret = decodeBase64Url(subscription.auth);
  const publicKey = decodeBase64Url(env('VAPID_PUBLIC_KEY') || env('NEXT_PUBLIC_VAPID_PUBLIC_KEY'));
  const privateKey = decodeBase64Url(env('VAPID_PRIVATE_KEY'));
  if (receiverKey.length !== 65 || authSecret.length !== 16 || publicKey.length !== 65 || privateKey.length !== 32) {
    throw new Error('Web Push encryption keys are invalid.');
  }
  const sender = createECDH('prime256v1');
  sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(receiverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderPublic]);
  const authPrk = createHmac('sha256', authSecret).update(sharedSecret).digest();
  const inputKey = hkdfExpand(authPrk, keyInfo, 32);
  const salt = randomBytes(16);
  const contentPrk = createHmac('sha256', salt).update(inputKey).digest();
  const contentKey = hkdfExpand(contentPrk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(contentPrk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, encrypted]);
}

function vapidAuthorization(endpoint) {
  const publicKey = env('VAPID_PUBLIC_KEY') || env('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = decodeBase64Url(env('VAPID_PRIVATE_KEY'));
  const rawPublicKey = decodeBase64Url(publicKey);
  if (privateKey.length !== 32 || rawPublicKey.length !== 65 || !env('VAPID_SUBJECT')) {
    throw new Error('Web Push VAPID configuration is invalid.');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(rawPublicKey.subarray(1, 33)),
    y: encodeBase64Url(rawPublicKey.subarray(33, 65)),
    d: encodeBase64Url(privateKey),
  };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: origin, exp: now + 12 * 60 * 60, sub: env('VAPID_SUBJECT') };
  const unsigned = `${encodeBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${encodeBase64Url(JSON.stringify(claims))}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  return `vapid t=${unsigned}.${signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url')}, k=${publicKey}`;
}

async function sendWebPush(subscription, payload, ttl) {
  const publicKey = env('VAPID_PUBLIC_KEY') || env('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = env('VAPID_PRIVATE_KEY');
  const subject = env('VAPID_SUBJECT');
  if (!publicKey || !privateKey || !subject) return false;
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return false; }
  const host = endpoint.hostname.toLowerCase();
  const allowedHost = host === 'fcm.googleapis.com'
    || host.endsWith('.push.services.mozilla.com')
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
  if (endpoint.protocol !== 'https:' || !allowedHost) {
    console.warn('[push] Refusing an unsupported Web Push endpoint.', { host });
    return false;
  }
  try {
    const body = webPushPayload(subscription, payload);
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: ttl <= 60 ? 'high' : 'normal',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if ([404, 410].includes(response.status)) {
      await serviceRequest(`mw_push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: 'DELETE' });
      return false;
    }
    if (!response.ok) throw new Error(`Web Push delivery failed (${response.status}).`);
    return true;
  } catch (error) {
    throw error;
  }
}

async function deliverPush(recipientId, notification, payload, ttl) {
  if (!UUID.test(recipientId || '')) throw new Error('Push recipient is invalid.');
  const account = await firebaseAccount();
  const [devicesResponse, subscriptionsResponse] = await Promise.all([
    serviceRequest(`mw_fcm_devices?user_id=eq.${recipientId}&select=token&limit=20`),
    serviceRequest(`mw_push_subscriptions?user_id=eq.${recipientId}&select=endpoint,p256dh,auth&limit=20`),
  ]);
  const [devices, subscriptions] = await Promise.all([devicesResponse.json(), subscriptionsResponse.json()]);
  const webReady = !!(env('VAPID_PUBLIC_KEY') || env('NEXT_PUBLIC_VAPID_PUBLIC_KEY'))
    && !!env('VAPID_PRIVATE_KEY') && !!env('VAPID_SUBJECT');
  if ((!account || !devices.length) && (!webReady || !subscriptions.length)) {
    console.warn('[push] No configured delivery provider or recipient endpoint.', { recipientId });
    return { fcm: 0, web: 0 };
  }
  const fcmResults = account ? await Promise.allSettled(devices.map(device => sendFcm(account, device.token, notification, payload.data, ttl))) : [];
  const webResults = webReady ? await Promise.allSettled(subscriptions.map(subscription => sendWebPush(subscription, payload.web, ttl))) : [];
  const failed = [...fcmResults, ...webResults].filter(result => result.status === 'rejected');
  if (failed.length) console.warn('[push] Some endpoints did not receive a notification.', { recipientId, failures: failed.length });
  return {
    fcm: fcmResults.filter(result => result.status === 'fulfilled' && result.value).length,
    web: webResults.filter(result => result.status === 'fulfilled' && result.value).length,
  };
}

async function profileName(userId) {
  const response = await serviceRequest(`mw_profiles?id=eq.${userId}&select=display_name,username&limit=1`);
  const [profile] = await response.json();
  return String(profile?.display_name || profile?.username || 'MilkyWay user').slice(0, 80);
}

async function event(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!constantTimeMatch(req.headers['x-webhook-secret'], env('FCM_WEBHOOK_SECRET'))) {
    return sendJson(res, 401, { error: 'Not allowed.' });
  }
  const record = req.body?.record || {};
  const type = req.body?.type;
  let recipientId, notification, data, web, ttl;

  if (type === 'post' && UUID.test(record.post_id || '') && UUID.test(record.recipient_id || '')) {
    recipientId = record.recipient_id;
    const author = String(record.actor_name || 'MilkyWay').slice(0, 80);
    const caption = String(record.caption || '').trim().slice(0, 140);
    notification = { title: `${author} published a new post`, body: caption || 'Tap to see the new post.' };
    const url = `/milkyway/?post=${encodeURIComponent(record.post_id)}`;
    data = { url, kind: 'post', postId: record.post_id };
    web = { title: notification.title, body: notification.body, url, tag: `post:${record.post_id}`, post: { id: record.post_id } };
    ttl = 86400;
  } else if (type === 'call' && UUID.test(record.id || '') && UUID.test(record.callee_id || '')
    && record.status === 'ringing') {
    const createdAt = Date.parse(record.created_at || '');
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 55_000) return sendJson(res, 200, { ok: true, skipped: 'expired_call' });
    recipientId = record.callee_id;
    if (!UUID.test(record.caller_id || '')) return sendJson(res, 400, { error: 'Invalid call event.' });
    const caller = await profileName(record.caller_id);
    const mode = record.offer?.callType === 'video' || record.offer?.mode === 'video' || record.offer?.videoEnabled === true ? 'video' : 'audio';
    notification = { title: `Incoming ${mode} call`, body: `${caller} is calling you.` };
    const url = `/milkyway/#call=${record.id}`;
    data = { url, kind: 'ring', callId: record.id, callType: mode, videoEnabled: String(mode === 'video') };
    web = {
      title: notification.title, body: notification.body, url, tag: `call:${record.id}`,
      call: { id: record.id, kind: 'ring', callType: mode, videoEnabled: mode === 'video', answer: 'Answer', decline: 'Decline' },
    };
    ttl = 60;
  } else {
    return sendJson(res, 400, { error: 'Unsupported push event.' });
  }

  const delivered = await deliverPush(recipientId, notification, { data, web }, ttl);
  return sendJson(res, 200, { ok: true, delivered });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query?.action || new URL(req.url, 'https://milkyway.invalid').searchParams.get('action') || '').toLowerCase();
  if (action === 'config' && req.method === 'GET') {
    const firebase = firebaseConfig();
    return sendJson(res, firebase ? 200 : 503, firebase ? { firebase } : { error: 'Firebase client configuration is not available.' });
  }
  if (action === 'event') {
    try { return await event(req, res); }
    catch (error) {
      console.error('[push] Event delivery failed.', error);
      return sendJson(res, 503, { error: 'Push delivery unavailable.' });
    }
  }
  if (!['register', 'unregister'].includes(action) || req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const ctx = await authenticate(req, res);
  if (!ctx) return;
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    return sendJson(res, 400, { error: 'Invalid device token.' });
  }
  const path = `mw_fcm_devices?token=eq.${encodeURIComponent(token)}`;
  if (action === 'unregister') {
    await ctx.rest(path, { method: 'DELETE' });
    return sendJson(res, 200, { ok: true });
  }
  await ctx.rpc('mw_fcm_device_register', { p_token: token, p_platform: 'android' });
  return sendJson(res, 200, { ok: true });
}
