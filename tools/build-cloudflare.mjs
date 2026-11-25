// Builds the static site for Cloudflare Pages into dist/. Mirrors what server.js exposes: only public web assets,
// never SQL, notes, sources or tooling. The /api routes are served by functions/api/_middleware.js.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const blocked = /\.(sql|bak|md|txt|map|gradle|java|ts)$/i;
const maxBytes = 25 * 1024 * 1024; // Cloudflare Pages per-file limit
const configuredSupabaseUrl = process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || '';
let buildSupabaseUrl = '';
const buildId = String(process.env.CF_PAGES_COMMIT_SHA || process.env.BUILD_VERSION || Date.now().toString(36))
  .trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);

if (!buildId) throw new Error('Could not determine a valid deployment version.');

if (configuredSupabaseUrl) {
  let address;
  try { address = new URL(configuredSupabaseUrl); }
  catch { throw new Error('Invalid VITE_SUPABASE_URL or SUPABASE_URL; provide a plain HTTPS origin without quotes or brackets.'); }
  if (address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error('Invalid VITE_SUPABASE_URL or SUPABASE_URL; expected an HTTPS origin without credentials, path, query, or fragment.');
  }
  buildSupabaseUrl = address.origin;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const filter = source => {
  if (blocked.test(source)) return false;
  const info = statSync(source);
  if (info.isFile() && info.size > maxBytes) { console.warn(`Skipped ${source} (over 25 MB).`); return false; }
  return true;
};

for (const file of ['index.html', 'sw.js', 'sw-cache.js', 'manifest.webmanifest', 'placeholder.svg', 'careers.html', 'media.html', 'sanaa.html', 'admin.html', 'privacy.html', 'account-deletion.html']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(out, file));
}
for (const folder of ['img', 'slides', 'milkyway']) {
  if (existsSync(join(root, folder))) cpSync(join(root, folder), join(out, folder), { recursive: true, filter });
}

const appVersion = { buildId, updatedAt: new Date().toISOString() };
writeFileSync(join(out, 'milkyway', 'app', 'app-version.json'), `${JSON.stringify(appVersion, null, 2)}\n`);
const workerPath = join(out, 'milkyway', 'sw.js');
const workerSource = readFileSync(workerPath, 'utf8');
const versionedWorker = workerSource.replace(/const CACHE='[^']+';/, `const CACHE='milkyway-${buildId}';`);
if (versionedWorker === workerSource) throw new Error('Could not set the deployment version in the MilkyWay service worker.');
writeFileSync(workerPath, versionedWorker);

{
  const appIndex = join(out, 'milkyway', 'index.html');
  const html = readFileSync(appIndex, 'utf8');
  const config = JSON.stringify(buildSupabaseUrl).replace(/</g, '\\u003c');
  const deployment = JSON.stringify(buildId).replace(/</g, '\\u003c');
  const supabaseConfig = buildSupabaseUrl
    ? `supabase:{...((window.MW_CONFIG||{}).supabase||{}),url:${config}},`
    : '';
  const injection = `<script>window.MW_CONFIG={...(window.MW_CONFIG||{}),deploymentId:${deployment},${supabaseConfig}};</script>\n`;
  writeFileSync(appIndex, html.replace('<!-- Optional provider overrides', `${injection}<!-- Optional provider overrides`));
}

// The APK is also published under a name that carries its version. Download managers resume interrupted
// downloads with byte ranges; a versioned file never changes underneath them, so a resumed download can't
// mix two builds, and browsers or proxies holding an older MilkyWay.apk can never hand it out again.
const downloads = join(out, 'milkyway', 'download');
const release = JSON.parse(readFileSync(join(downloads, 'version.json'), 'utf8'));
const apkPath = join(downloads, 'MilkyWay.apk');
if (!Number.isInteger(release.versionCode) || !existsSync(apkPath)) throw new Error('milkyway/download needs MilkyWay.apk and a valid version.json.');
const apkHeader = readFileSync(apkPath).subarray(0, 2);
if (statSync(apkPath).size < 1024 * 1024 || apkHeader[0] !== 0x50 || apkHeader[1] !== 0x4b) {
  throw new Error('milkyway/download/MilkyWay.apk is missing, truncated, or not a ZIP-based APK.');
}
const publicDownloads = join(out, 'download');
mkdirSync(publicDownloads, { recursive: true });
copyFileSync(join(downloads, 'MilkyWay.apk'), join(publicDownloads, 'MilkyWay.apk'));
copyFileSync(join(downloads, 'MilkyWay.apk'), join(out, 'MilkyWay.apk'));
const versionedApk = `MilkyWay-${release.versionCode}.apk`;
copyFileSync(join(downloads, 'MilkyWay.apk'), join(downloads, versionedApk));
const versionedApkUrl = `/milkyway/download/${versionedApk}`;
writeFileSync(join(downloads, 'version.json'), `${JSON.stringify({ ...release, url: versionedApkUrl, apk: versionedApkUrl }, null, 2)}\n`);
const homepage = join(out, 'index.html');
writeFileSync(homepage, readFileSync(homepage, 'utf8').replace(/href="\/MilkyWay\.apk"/g, `href="${versionedApkUrl}"`));

// Pages from the old MilkyWay app were removed. Saved links, bookmarks and old notifications that still
// point at them open the new app instead of an error page.
writeFileSync(join(out, '_redirects'), [
  '/milkyway/classic.html /milkyway/ 301',
  '/milkyway/classic /milkyway/ 301',
  '/milkyway/classic/* /milkyway/ 301',
  '/account.html /milkyway/ 301',
  '/account /milkyway/ 301',
  '/portal.html / 301',
  '/portal / 301',
  '',
].join('\n'));

// Same response headers server.js sets. LIVE needs the camera and microphone on this origin.
writeFileSync(join(out, '_headers'), `/*
  Permissions-Policy: camera=(self), microphone=(self), autoplay=(self), fullscreen=(self), geolocation=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/*.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/sw-cache.js
  Cache-Control: no-cache
/*.webmanifest
  Cache-Control: no-cache
/milkyway/app/*
  Cache-Control: public, max-age=0, must-revalidate
/milkyway/download/version.json
  Cache-Control: no-cache
/milkyway/app/app-version.json
  Cache-Control: no-store
/MilkyWay.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: no-cache, no-transform
/milkyway/download/MilkyWay.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: public, max-age=0, must-revalidate, no-transform
/milkyway/download/MilkyWay-*.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment; filename="MilkyWay.apk"
  Accept-Ranges: bytes
  Cache-Control: public, max-age=31536000, immutable, no-transform
`);
// The same build also deploys on Netlify: there, pictures are resized by Netlify Image CDN instead of
// Cloudflare Image Resizing (which only exists on Cloudflare hosts).
if (process.env.NETLIFY === 'true') {
  const appConfig = join(out, 'milkyway', 'app', 'config.js');
  writeFileSync(appConfig, readFileSync(appConfig, 'utf8').replace("imageCdn: 'auto'", "imageCdn: 'netlify'"));
}
console.log(`${process.env.NETLIFY === 'true' ? 'Netlify' : 'Cloudflare Pages'} build written to dist/.`);
