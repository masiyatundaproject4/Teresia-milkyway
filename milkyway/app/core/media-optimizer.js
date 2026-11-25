import { mediaInfo } from './media-files.js';
import { t } from './i18n.js';

const PREVIEW_EDGE = 640;

function outputSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(source, width, height, type = 'image/webp', quality = 0.8, maxEdge = PREVIEW_EDGE) {
  const { width: outputWidth, height: outputHeight } = outputSize(width, height, maxEdge);
  const canvas = canvasFor(outputWidth, outputHeight);
  const context = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  context.drawImage(source, 0, 0, outputWidth, outputHeight);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('Browser could not encode the media preview.'));
  }, type, quality));
}

async function blobToFile(blob, name, type) {
  if (typeof File === 'function') return new File([blob], name, { type: blob.type || type, lastModified: Date.now() });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

let worker = null;
let nextWorkerTask = 0;
const workerTasks = new Map();

function stopWorker(error) {
  worker?.terminate();
  worker = null;
  for (const task of workerTasks.values()) {
    clearTimeout(task.timer);
    task.reject(error);
  }
  workerTasks.clear();
}

function optimizeInWorker(file) {
  if (typeof Worker !== 'function') return Promise.reject(new Error('Web Workers are unavailable.'));
  if (!worker) {
    worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => {
      const task = workerTasks.get(event.data?.id);
      if (!task) return;
      workerTasks.delete(event.data.id);
      clearTimeout(task.timer);
      if (event.data.error) task.reject(new Error(event.data.error));
      else task.resolve(event.data.result);
    });
    worker.addEventListener('error', event => stopWorker(event.error || new Error('Media worker failed.')));
    worker.addEventListener('messageerror', () => stopWorker(new Error('Media worker could not read the selected photo.')));
  }
  const id = ++nextWorkerTask;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopWorker(new Error('Timed out while preparing the selected photo.')), 30_000);
    workerTasks.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, file }); }
    catch (error) { clearTimeout(timer); workerTasks.delete(id); reject(error); }
  });
}

/** Compresses photos off the UI thread and makes a small rendition for feed/profile surfaces. */
export async function optimizeImage(file) {
  try {
    return await optimizeInWorker(file);
  } catch (workerError) {
    console.warn('[media] worker photo optimization unavailable; trying the browser main thread', workerError);
    try {
      return await optimizeImageOnMain(file);
    } catch (error) {
      if (/^image\/hei[cf]/i.test(mediaInfo(file).type)) {
        throw new Error(`${t('heicConversionFailed')} ${error?.message || ''}`.trim(), { cause: error });
      }
      console.warn('[media] photo optimization unavailable; uploading the selected file', error);
      return { full: file, preview: null };
    }
  }
}

/** Re-encodes large short videos on devices with MediaRecorder and falls back to the original elsewhere. */
export async function optimizeVideo(file, { onProgress = () => {} } = {}) {
  if (file.size < 8 * 1024 * 1024 || typeof MediaRecorder !== 'function') return file;
  const video = document.createElement('video');
  let objectUrl = '';
  let sourceStream;
  let outputStream;
  let recorder;
  let frame = 0;
  try {
    objectUrl = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = objectUrl;
    await waitFor(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 120) return file;
    if (video.videoWidth > 4096 || video.videoHeight > 4096) return file;

    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4']
      .find(type => MediaRecorder.isTypeSupported?.(type));
    const captureSource = video.captureStream?.bind(video) || video.mozCaptureStream?.bind(video);
    const captureCanvas = document.createElement('canvas');
    if (!mimeType || !captureSource || typeof captureCanvas.captureStream !== 'function') return file;

    const { width, height } = outputSize(video.videoWidth, video.videoHeight, 1280);
    captureCanvas.width = width;
    captureCanvas.height = height;
    const context = captureCanvas.getContext('2d');
    if (!context) return file;
    sourceStream = captureSource();
    outputStream = captureCanvas.captureStream(24);
    for (const track of sourceStream.getAudioTracks()) outputStream.addTrack(track);
    recorder = new MediaRecorder(outputStream, {
      mimeType,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });
    const chunks = [];
    const recorded = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('error', event => reject(event.error || new Error('Video encoding failed.')), { once: true });
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType })), { once: true });
    });
    recorded.catch(() => {});
    const progress = () => {
      try { onProgress(Math.min(99, Math.round(video.currentTime / video.duration * 100))); } catch {}
    };
    const draw = () => {
      if (video.paused || video.ended) return;
      context.drawImage(video, 0, 0, width, height);
      frame = requestAnimationFrame(draw);
    };
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out while compressing the video.')), video.duration * 1500 + 5000);
      video.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not decode the selected video.')); }, { once: true });
      video.addEventListener('timeupdate', progress);
    });
    recorder.start(1000);
    await video.play();
    frame = requestAnimationFrame(draw);
    await ended;
    cancelAnimationFrame(frame);
    frame = 0;
    video.removeEventListener('timeupdate', progress);
    if (recorder.state === 'recording') recorder.stop();
    const blob = await recorded;
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    if (blob.size >= file.size * 0.9) return file;
    try { onProgress(100); } catch {}
    return await blobToFile(blob, `${file.name.replace(/\.[^.]+$/, '')}.${extension}`, blob.type);
  } catch (error) {
    console.warn('[media] video compression unavailable; uploading the selected file', error);
    return file;
  } finally {
    cancelAnimationFrame(frame);
    if (recorder?.state === 'recording') recorder.stop();
    for (const track of [...(sourceStream?.getTracks() || []), ...(outputStream?.getTracks() || [])]) track.stop();
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function optimizeImageOnMain(file) {
  const { source, width: sourceWidth, height: sourceHeight, release } = await decodeImage(file);
  const isHeic = /^image\/hei[cf]/i.test(mediaInfo(file).type);
  try {
    const maxEdge = 2048;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    let full = file;
    if (isHeic || Math.max(sourceWidth, sourceHeight) > maxEdge || file.size > 600 * 1024) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable.');
      context.drawImage(source, 0, 0, width, height);
      const fullBlob = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Photo encoding failed.')), 'image/webp', 0.82));
      if (fullBlob.size < file.size || isHeic) full = await blobToFile(fullBlob, `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.webp`, 'image/webp');
    }
    let preview = null;
    if (Math.max(sourceWidth, sourceHeight) > PREVIEW_EDGE || file.size > 300 * 1024) {
      const previewScale = Math.min(1, PREVIEW_EDGE / Math.max(sourceWidth, sourceHeight));
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = Math.max(1, Math.round(sourceWidth * previewScale));
      previewCanvas.height = Math.max(1, Math.round(sourceHeight * previewScale));
      const previewContext = previewCanvas.getContext('2d');
      if (!previewContext) throw new Error('Canvas 2D context is unavailable.');
      previewContext.drawImage(source, 0, 0, previewCanvas.width, previewCanvas.height);
      const previewBlob = await new Promise((resolve, reject) => previewCanvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Photo preview encoding failed.')), 'image/webp', 0.68));
      if (previewBlob.size < file.size) preview = await blobToFile(previewBlob, `${file.name.replace(/\.[^.]+$/, '')}-preview.webp`, 'image/webp');
    }
    return { full, preview };
  } finally {
    release();
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch (error) {
      if (typeof Image !== 'function') throw error;
    }
  }
  if (typeof Image !== 'function') throw new Error('Image decoding is unavailable.');
  let url = '';
  try {
    url = URL.createObjectURL(file);
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The browser could not decode this photo.'));
      element.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The browser could not decode this photo.');
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    throw error;
  }
}

function waitFor(video, eventName) {
  if ((eventName === 'loadedmetadata' && video.readyState >= 1) || (eventName === 'loadeddata' && video.readyState >= 2)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out while preparing the video preview.')), 8000);
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener(eventName, loaded);
      video.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('Could not decode the selected video.'));
    video.addEventListener(eventName, loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
  });
}

/** Extracts a small poster frame without transcoding or uploading the whole video twice. */
export async function createVideoPreview(file) {
  const video = document.createElement('video');
  let objectUrl = '';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    await waitFor(video, 'loadedmetadata');
    if (Number.isFinite(video.duration) && video.duration > 0.2) {
      video.currentTime = Math.min(0.25, video.duration / 2);
      await waitFor(video, 'seeked');
    } else await waitFor(video, 'loadeddata');
    const { width, height } = outputSize(video.videoWidth, video.videoHeight, PREVIEW_EDGE);
    const blob = await encode(video, width, height, 'image/jpeg', 0.64);
    return await blobToFile(blob, `${file.name.replace(/\.[^.]+$/, '')}-poster.jpg`, 'image/jpeg');
  } catch (error) {
    console.warn('[media] video poster generation unavailable', error);
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function yieldToBrowser() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}
