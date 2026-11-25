// MilkyWay app configuration — the ONE place to plug in providers.
//
// Only PUBLIC values belong here (they ship to every browser). Secrets — the LiveKit API secret, a Cloudinary API
// secret, the Supabase service-role key — stay server-side as environment variables of the token/API functions.
//
// Any value can be overridden without editing this file by defining `window.MW_CONFIG` before app/main.js runs
// (e.g. an inline script injected by the Android shell, an edge function, or a staging page):
//   <script>window.MW_CONFIG = { livekit: { url: 'wss://my-project.livekit.cloud' }, cloudinary: { cloudName: 'demo' } }</script>

const envSupabaseUrl = import.meta.env?.VITE_SUPABASE_URL;

function normalizeSupabaseUrl(value) {
  let address;
  try { address = new URL(value); }
  catch { throw new Error('Supabase URL is invalid; configure a plain HTTPS origin without quotes or brackets.'); }
  if (address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error('Supabase URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return address.origin;
}

const defaults = {
  supabase: {
    url: envSupabaseUrl || 'https://wpclkhgizbvxuvbhbwzs.supabase.co',
    // Publishable (anon) key — safe in the browser; row-level security protects the data.
    anonKey: 'sb_publishable_GCFJ3Is8t8mdia4gLeHApg_M_3ez9xb',
    // UMD bundle, loaded lazily after first paint (never blocks startup).
    sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  },
  livekit: {
    // Leave empty: the token endpoint returns the server URL. Set it to pre-warm the connection earlier.
    url: '',
    tokenEndpoint: '/api/milkyway-livekit-token',
    // Used by LIVE sessions when the site API is unreachable (e.g. a static mirror).
    directTokenEndpoint: `${(envSupabaseUrl || 'https://wpclkhgizbvxuvbhbwzs.supabase.co').replace(/\/+$/, '')}/functions/v1/livekit-token`,
    sdkUrls: [
      'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js',
      'https://unpkg.com/livekit-client@2/dist/livekit-client.umd.js',
    ],
  },
  live: {
    // Override these millisecond durations through window.MW_CONFIG.live when needed.
    // Viewers keep listening briefly after hiding a tab; hosts are ended sooner when hidden and later when idle.
    viewerHiddenGraceMs: 60_000,
    hostHiddenGraceMs: 60_000,
    hostIdleGraceMs: 300_000,
  },
  cloudinary: {
    // Set cloudName to deliver images/posters through Cloudinary fetch (f_auto, q_auto, sized). Empty = off.
    cloudName: '',
    // Unsigned upload preset, for future direct uploads from the composer.
    uploadPreset: '',
  },
  media: {
    // 'auto' → Cloudinary if configured, else Cloudflare Image Resizing on Cloudflare Pages hosts, else original files.
    imageCdn: 'auto',
  },
  api: {
    base: '/api',
    feed: '/api/milkyway-feed',
    liveRoom: '/api/milkyway-live-room',
    wallet: '/api/milkyway-wallet',
    message: '/api/milkyway-message',
    groups: '/api/milkyway-groups',
  },
  feed: {
    pageSize: 10,
    // Posts kept per feed in IndexedDB for instant, offline startup.
    cacheLimit: 60,
  },
};

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const merge = (base, extra) => {
  if (!isObject(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  return out;
};

const resolved = merge(defaults, globalThis.MW_CONFIG);
resolved.supabase.url = normalizeSupabaseUrl(String(resolved.supabase.url || ''));
if (!globalThis.MW_CONFIG?.livekit?.directTokenEndpoint) {
  resolved.livekit.directTokenEndpoint = `${resolved.supabase.url}/functions/v1/livekit-token`;
}

export const config = Object.freeze(resolved);
