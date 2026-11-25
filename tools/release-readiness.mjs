import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const issues = [];
const warnings = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Confirm syntax checks and the core architecture tests pass before packaging.
for (const [label, args] of [
  ['JavaScript syntax', ['tools/check-syntax.mjs']],
  ['core architecture tests', ['--test', 'tools/core-architecture.test.mjs']],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) issues.push(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  else console.log(`PASS: ${label}`);
}

// Public client code must never embed a Supabase service-role key or private key.
const scanRoots = ['index.html', 'admin.html', 'media.html', 'sanaa.html', 'careers.html', 'lib', 'milkyway'];
const secretPatterns = [/service_role/i, /SUPABASE_SERVICE_ROLE_KEY/i, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
function walk(p) {
  if (!fs.existsSync(path.join(root, p))) return [];
  const abs = path.join(root, p);
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [p];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e => {
    const child = path.join(p, e.name);
    if (e.isDirectory() && ['node_modules', '.git', 'dist'].includes(e.name)) return [];
    return walk(child);
  });
}
for (const file of [...new Set(scanRoots.flatMap(walk))]) {
  if (!/\.(?:html|js|mjs|ts|json)$/i.test(file)) continue;
  const body = read(file);
  for (const pattern of secretPatterns) {
    if (pattern.test(body)) issues.push(`Potential sensitive key/identifier pattern in client-facing source: ${file} (${pattern})`);
  }
}
if (!issues.some(x => x.includes('Potential sensitive'))) console.log('PASS: no obvious service-role/private-key marker in scanned client source');

const cap = JSON.parse(read('capacitor.config.json'));
if (cap.server?.url) warnings.push(`Capacitor uses remote server.url (${cap.server.url}); bundled Android app depends on network for its web UI and cannot be assumed to boot offline from local assets.`);
const splash = path.join(root, 'android/capacitor/app/src/main/res/drawable/splash.png');
if (!fs.existsSync(splash)) issues.push('Android splash image is missing.');
else {
  const bytes = fs.readFileSync(splash);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) issues.push('Android splash image is not a valid PNG.');
  else console.log(`PASS: Android splash image is a recognizable PNG (${bytes.length} bytes)`);
}

const apk = path.join(root, 'milkyway/download/MilkyWay.apk');
if (!fs.existsSync(apk)) issues.push('Downloadable Android APK is missing.');
else {
  const bytes = fs.readFileSync(apk);
  if (bytes.length < 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) issues.push('Downloadable Android APK is missing, truncated, or not a ZIP-based APK.');
  else console.log(`PASS: downloadable Android APK exists (${bytes.length} bytes)`);
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (issues.length) {
  for (const issue of issues) console.error(`FAIL: ${issue}`);
  process.exitCode = 1;
} else {
  console.log('PASS: release readiness checks completed; warnings still require review before Production.');
}
