// Runs the Express-style api/<name>.js handlers (req, res) from a Fetch Request and returns a Fetch Response.
// Used by the Cloudflare Pages Function (functions/api/_middleware.js) that serves /api/<name>.
import account from '../milkyway-account.js';
import call from '../milkyway-call.js';
import discovery from '../milkyway-discovery.js';
import feed from '../milkyway-feed.js';
import gallery from '../milkyway-gallery.js';
import groups from '../milkyway-groups.js';
import health from '../milkyway-health.js';
import liveRoom from '../milkyway-live-room.js';
import livekitToken from '../milkyway-livekit-token.js';
import mediaAuthorize from '../milkyway-media-authorize.js';
import message from '../milkyway-message.js';
import notifications from '../milkyway-notifications.js';
import social from '../milkyway-social.js';
import wallet from '../milkyway-wallet.js';
import { logError, requestId as getRequestId } from './observability.js';

export const handlers = {
  'milkyway-account': account,
  'milkyway-call': call,
  'milkyway-discovery': discovery,
  'milkyway-feed': feed,
  'milkyway-gallery': gallery,
  'milkyway-groups': groups,
  'milkyway-health': health,
  'milkyway-live-room': liveRoom,
  'milkyway-livekit-token': livekitToken,
  'milkyway-media-authorize': mediaAuthorize,
  'milkyway-message': message,
  'milkyway-notifications': notifications,
  'milkyway-social': social,
  'milkyway-wallet': wallet,
};

const JSON_LIMIT = 16 * 1024;
const json = (status, body, id) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-Id': id } });

async function readJsonBody(request, id) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > JSON_LIMIT)) {
    return { response: json(413, { error: 'Request too large.', requestId: id }, id) };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > JSON_LIMIT) {
        await reader.cancel('Request body exceeds limit.');
        return { response: json(413, { error: 'Request too large.', requestId: id }, id) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

function makeResponse() {
  const state = { status: 200, headers: new Headers(), body: null, sent: false };
  const finish = body => {
    if (!state.sent) { state.sent = true; state.body = body; }
    return res;
  };
  const res = {
    get headersSent() { return state.sent; },
    status(code) { state.status = code; return res; },
    setHeader(name, value) { state.headers.set(name, String(value)); return res; },
    json(value) { state.headers.set('Content-Type', 'application/json'); return finish(JSON.stringify(value)); },
    send(value) { return finish(value ?? null); },
    end(value) { return finish(value ?? null); },
    redirect(code, location) { state.status = code; state.headers.set('Location', location); return finish(null); },
  };
  return { res, state };
}

export async function runApi(name, request, environment = null) {
  const id = getRequestId(request);
  const handler = handlers[name];
  if (!handler) return json(404, { error: 'Not found.', requestId: id }, id);

  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  const query = Object.fromEntries(url.searchParams);
  let body;
  let raw = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    if (/\bjson\b/i.test(headers['content-type'] || '')) {
      let text;
      try {
        const result = await readJsonBody(request, id);
        if (result.response) return result.response;
        text = result.text;
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return json(400, { error: 'Invalid request body.', requestId: id }, id);
        logError('api.body_read_failed', error, { requestId: id, route: name });
        return json(400, { error: 'Invalid request body.', requestId: id }, id);
      }
      try { body = text ? JSON.parse(text) : undefined; } catch { return json(400, { error: 'Invalid request body.', requestId: id }, id); }
    } else {
      raw = request.body;
    }
  }

  const { res, state } = makeResponse();
  const req = {
    method: request.method, headers: { ...headers, 'x-request-id': id }, query, body, res, url: url.pathname + url.search,
    env: environment,
    // Multipart uploads read the raw body as a stream, as with a Node request.
    async *[Symbol.asyncIterator]() { if (raw) for await (const chunk of raw) yield chunk; },
  };
  state.headers.set('X-Request-Id', id);
  try {
    await handler(req, res);
  } catch (error) {
    logError('api.unhandled', error, { requestId: id, route: name, method: request.method });
  }
  if (!state.sent) return json(500, { error: 'Service unavailable.', requestId: id }, id);
  return new Response(request.method === 'HEAD' ? null : state.body, { status: state.status, headers: state.headers });
}
