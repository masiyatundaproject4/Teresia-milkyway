const TYPES = {
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  png: ['image', 'image/png'],
  webp: ['image', 'image/webp'],
  gif: ['image', 'image/gif'],
  heic: ['image', 'image/heic'],
  heif: ['image', 'image/heif'],
  'heic-sequence': ['image', 'image/heic-sequence'],
  'heif-sequence': ['image', 'image/heif-sequence'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/x-m4v'],
  mov: ['video', 'video/quicktime'],
  qt: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  '3gp': ['video', 'video/3gpp'],
  '3g2': ['video', 'video/3gpp2'],
  mp3: ['audio', 'audio/mpeg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
};

const extension = name => String(name || '').split('.').pop()?.toLowerCase() || '';

function typed(kind, type, ext) {
  return { kind, type, extension: ext };
}

export function mediaInfo(file) {
  if (!file) return typed('unknown', '', '');
  const mime = String(file.type || '').toLowerCase().split(';', 1)[0].trim();
  const ext = extension(file.name);
  const byExtension = TYPES[ext];
  if (mime.startsWith('image/')) return typed('image', mime, ext || mime.slice(6));
  if (mime.startsWith('video/')) return typed('video', mime, ext || mime.slice(6));
  if (mime.startsWith('audio/')) return typed('audio', mime, ext || mime.slice(6));
  if (byExtension) return typed(byExtension[0], byExtension[1], ext);
  return typed('unknown', mime, ext);
}

export async function identifyMediaFile(file) {
  const info = mediaInfo(file);
  if (info.kind !== 'unknown' || typeof file?.slice !== 'function') return info;
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const text = String.fromCharCode(...bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return typed('image', 'image/jpeg', 'jpg');
  if (text.startsWith('\x89PNG\r\n\x1a\n')) return typed('image', 'image/png', 'png');
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return typed('image', 'image/webp', 'webp');
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return typed('image', 'image/gif', 'gif');
  if (text.slice(4, 8) === 'ftyp') {
    const brand = text.slice(8, 12).toLowerCase();
    if (/^(hei[cf]|heix|hevc|hevx|heim|heis|mif[1i]|msf[1i])$/.test(brand)) return typed('image', 'image/heic', 'heic');
    if (brand === 'qt  ') return typed('video', 'video/quicktime', 'mov');
    return typed('video', 'video/mp4', 'mp4');
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return typed('video', 'video/webm', 'webm');
  if (text.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return typed('audio', 'audio/mpeg', 'mp3');
  if (text.startsWith('OggS')) return typed('audio', 'audio/ogg', 'ogg');
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') return typed('audio', 'audio/wav', 'wav');
  return info;
}

export function openFilePicker(input) {
  if (!input || typeof input.click !== 'function') throw new Error('The media picker is unavailable on this device.');
  if (typeof input.showPicker === 'function') {
    try { input.showPicker(); return; } catch { /* Use the click fallback for WebViews and older browsers. */ }
  }
  input.click();
}
