// LiveKit helpers shared by the Live room API and the token endpoint. Tokens and room-admin calls are signed with the
// same server credentials (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET), so permissions granted by the host
// (guest seats, mic mutes, removals) always apply to the room the viewers actually joined.
import { createHmac, randomUUID } from 'node:crypto';
import { ApiError } from './supa.js';
import { logError, logWarning } from './observability.js';

const env = (name, environment) => String(environment ? environment[name] ?? '' : process.env[name] ?? '').trim();
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const REQUIRED_ENV = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];

export function livekitMissingVariables(environment) {
  return REQUIRED_ENV.filter(name => !env(name, environment));
}
export function livekitConfigurationError(environment) {
  const missing = livekitMissingVariables(environment);
  if (missing.length) {
    return `LiveKit is not configured. Missing ${missing.join(', ')}. Set LIVEKIT_URL in [vars] and LIVEKIT_API_KEY / LIVEKIT_API_SECRET as Cloudflare secrets.`;
  }
  if (!validLivekitUrl(environment)) return 'LIVEKIT_URL is invalid. Set it to the LiveKit project WebSocket URL (wss://...).';
  return '';
}

export const CAMERA = 1, MIC = 2, SCREEN_SHARE = 3;
const SOURCE_NAMES = { [CAMERA]: 'camera', [MIC]: 'microphone', [SCREEN_SHARE]: 'screen_share' };

export const livekitConfigured = environment => livekitMissingVariables(environment).length === 0;
// Clients connect over WebSocket; an https:// project URL (as copied from the LiveKit dashboard) means the same host.
export const livekitUrl = environment => env('LIVEKIT_URL', environment).replace(/\/+$/, '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
const validLivekitUrl = environment => {
  try {
    const url = new URL(livekitUrl(environment));
    return ['ws:', 'wss:'].includes(url.protocol) && Boolean(url.hostname)
      && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

function sign(claims, environment) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', env('LIVEKIT_API_SECRET', environment)).update(head).digest('base64url')}`;
}

/** Calls the LiveKit RoomService (Twirp). Returns null when the room or participant is not connected right now. */
export async function livekit(method, room, body = {}, grant = null, environment = null) {
  const configError = livekitConfigurationError(environment);
  if (configError) throw new ApiError(503, configError);
  const now = Math.floor(Date.now() / 1000);
  const jwt = sign({ iss: env('LIVEKIT_API_KEY', environment), sub: 'milkyway-server', nbf: now - 5, exp: now + 60, video: grant || { roomAdmin: true, room } }, environment);
  const origin = livekitUrl(environment).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  let result;
  try {
    result = await fetch(`${origin}/twirp/livekit.RoomService/${method}`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(room ? { room, ...body } : body), signal: AbortSignal.timeout(8000),
    });
  } catch { throw new ApiError(503, 'LiveKit is unreachable.'); }
  const data = await result.json().catch(() => ({}));
  if (result.status === 404) return null;
  if (!result.ok) throw new ApiError(503, data?.msg || 'LiveKit rejected the request.');
  return data;
}

// The RoomService check is only for the explicit health endpoint. Token issuance can be performed locally and must
// not spend management API quota for every new server instance or call.
let credentialCheck = { at: 0, ok: true, reason: '' };
let credentialCheckInFlight = null;
export async function livekitUsable({ verifyCredentials = false, environment = null } = {}) {
  if (!livekitConfigured(environment) || !validLivekitUrl(environment)) return false;
  if (!verifyCredentials) return true;
  const age = Date.now() - credentialCheck.at;
  if (credentialCheck.at && age < (credentialCheck.ok ? 60 * 60_000 : 5 * 60_000)) return credentialCheck.ok;
  if (credentialCheckInFlight) return credentialCheckInFlight;
  credentialCheckInFlight = checkLivekitCredentials(environment);
  try { return await credentialCheckInFlight; }
  finally { credentialCheckInFlight = null; }
}

async function checkLivekitCredentials(environment) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = sign({ iss: env('LIVEKIT_API_KEY', environment), sub: 'milkyway-server', nbf: now - 5, exp: now + 60, video: { roomList: true } }, environment);
  const origin = livekitUrl(environment).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  try {
    const result = await fetch(`${origin}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['milkyway-credential-check'] }), signal: AbortSignal.timeout(5000),
    });
    const details = await result.json().catch(() => ({}));
    // A management API quota is not evidence that the signing credentials are invalid.
    const rejected = result.status === 401 || result.status === 403;
    const quotaLimited = [402, 429].includes(result.status)
      || /quota|resource[\s_-]*exhausted|rate.?limit|usage limit/i.test(`${details?.code || ''} ${details?.msg || details?.message || ''}`);
    const reason = rejected
      ? 'LiveKit rejected LIVEKIT_API_KEY / LIVEKIT_API_SECRET for LIVEKIT_URL.'
      : quotaLimited ? 'LiveKit management API reported a usage limit; token signing will continue.'
        : '';
    if (quotaLimited) console.warn('[livekit] management API usage limit reached', {
      status: result.status, code: details?.code || null, message: details?.msg || details?.message || '',
    });
    credentialCheck = { at: Date.now(), ok: !rejected, reason };
  } catch {
    credentialCheck = { at: Date.now(), ok: true, reason: 'LiveKit was unreachable during the credential check; token signing remains enabled.' };
  }
  return credentialCheck.ok;
}
export const livekitCredentialStatus = () => ({ ...credentialCheck });

async function claimCleanup(ctx, roomName = null) {
  const jobs = await ctx.rpc('mw_room_cleanup_claim', { p_room_name: roomName });
  const job = Array.isArray(jobs) ? jobs[0] : null;
  return job ? { room_name: job.job_room_name, job_lease_id: job.job_lease_id } : null;
}

async function runCleanup(ctx, job) {
  if (!job?.room_name || !job?.job_lease_id) return false;
  try {
    const participants = await livekit('ListParticipants', job.room_name, {}, null, ctx.env);
    const revokeTokenTs = String(Math.ceil(Date.now() / 1000));
    for (const participant of participants?.participants || []) {
      await livekit('RemoveParticipant', job.room_name, { identity: participant.identity, revokeTokenTs }, null, ctx.env);
    }
    await livekit('DeleteRoom', job.room_name, {}, null, ctx.env);
    await ctx.rpc('mw_room_cleanup_complete', { p_room_name: job.room_name, p_lease_id: job.job_lease_id });
    return true;
  } catch (error) {
    try {
      await ctx.rpc('mw_room_cleanup_retry', {
        p_room_name: job.room_name,
        p_lease_id: job.job_lease_id,
        p_error: String(error?.message || 'LiveKit room cleanup failed').slice(0, 240),
      });
    } catch (queueError) {
      logError('livekit.cleanup_retry_record_failed', queueError, { requestId: ctx.requestId || 'unavailable', room: job.room_name });
    }
    logError('livekit.room_cleanup_failed', error, { requestId: ctx.requestId || 'unavailable', room: job.room_name });
    return false;
  }
}

/** Queue and immediately attempt an idempotent room close; failed closes remain available for retry. */
export async function closeRoom(ctx, roomName, { immediate = true } = {}) {
  await ctx.rpc('mw_room_cleanup_enqueue', { p_room_name: roomName });
  if (!immediate) return false;
  const job = await claimCleanup(ctx, roomName);
  return job ? runCleanup(ctx, job) : true;
}

/** Opportunistically drains a small amount of queued cleanup work on authenticated API traffic. */
export async function retryRoomCleanups(ctx, limit = 1) {
  for (let index = 0; index < limit; index++) {
    let job;
    try { job = await claimCleanup(ctx); }
    catch (error) {
      logWarning('livekit.cleanup_queue_unavailable', { requestId: ctx.requestId || 'unavailable', message: String(error?.message || error).slice(0, 240) });
      return;
    }
    if (!job) return;
    await runCleanup(ctx, job);
  }
}

/** Signs a participant access token for one room. `sources` are LiveKit track source numbers. */
export function accessToken({ identity, name = '', metadata = '', room, canPublish = false, sources = [], ttlSeconds = 60 }, environment = null) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: env('LIVEKIT_API_KEY', environment), sub: identity, name: String(name || 'MilkyWay user').slice(0, 80), metadata, jti: randomUUID(),
    nbf: now - 5, exp: now + ttlSeconds,
    video: {
      room, roomJoin: true, canSubscribe: true, canPublishData: true, canPublish,
      canPublishSources: canPublish ? sources.map(source => SOURCE_NAMES[source]).filter(Boolean) : [],
    },
  }, environment);
}
