// Cloudflare Pages Function: serves every api/<name>.js handler at /api/<name>, exactly like server.js does on Render.
// A directory middleware runs for every request under /api/, so one file covers all endpoints.
// Passes Cloudflare bindings to each handler; nodejs_compat provides Buffer and node:crypto.
import { runApi } from '../../api/_lib/fetch-adapter.js';

export const onRequest = ({ request, env }) => {
  const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/')[0] || '');
  return runApi(name, request, env);
};
