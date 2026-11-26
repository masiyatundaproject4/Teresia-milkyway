// Create photo, slideshow, video or text posts. All slideshow assistance runs locally on the device.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { identifyMediaFile, openFilePicker } from '../core/media-files.js';
import { createVideoPreview, optimizeImage, optimizeVideo, yieldToBrowser } from '../core/media-optimizer.js';
import { profiles } from '../data/profiles.js';
import { feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, icon, toast, count, WaitIndicator, brandMark } from './dom.js';
import { TRANSPARENT_VIDEO_POSTER } from '../core/media.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_PHOTOS = 8;
const MAX_SOUND_TRACKS = 24;
const MEDIA_PREPARATION_TIMEOUT = 15_000;

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (!blob) reject(new Error(t('photoCropFailed')));
      else resolve(blob);
    };
    const timer = setTimeout(() => finish(new Error(t('photoCropFailed'))), MEDIA_PREPARATION_TIMEOUT);
    try { canvas.toBlob(blob => finish(null, blob), type, quality); }
    catch (error) { finish(error); }
  });
}

function formatSoundDuration(seconds) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration < 0) return '—';
  return `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
}

function soundText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && !/^(?:null|undefined)$/i.test(text) ? text : fallback;
}

async function trimSoundFile(url, start, end) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(t('studioSoundTrimFailed'));
  const bytes = await response.arrayBuffer();
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error(t('studioSoundTrimFailed'));
  const context = new AudioContextCtor();
  let audio;
  try { audio = await context.decodeAudioData(bytes); }
  finally { await context.close(); }
  const firstFrame = Math.max(0, Math.min(audio.length - 1, Math.floor(start * audio.sampleRate)));
  const lastFrame = Math.max(firstFrame + 1, Math.min(audio.length, Math.floor(end * audio.sampleRate)));
  const channels = Math.min(2, audio.numberOfChannels);
  const frames = lastFrame - firstFrame;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = firstFrame; frame < lastFrame; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, audio.getChannelData(channel)[frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new File([output], 'milkyway-sound-clip.wav', { type: 'audio/wav' });
}

function readableError(error, fallback) {
  const message = String(error?.message || error || '').replace(/\b(?:null|undefined)\b/gi, '').replace(/\s+/g, ' ').trim();
  return message || fallback;
}

async function mapConcurrent(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function publishError(error, phase) {
  const message = String(error?.message || error || '').replace(/\b(?:null|undefined)\b/gi, '').replace(/\s+/g, ' ').trim();
  const code = String(error?.code || '');
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|timed out/i.test(message)) {
    return `${t('postNetworkFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === 'PGRST204' || /schema cache|column .*mw_posts|could not find the .*column/i.test(message)) {
    return `${t('postSchemaFailed')} ${message}`;
  }
  if (code === '42501' || /row-level security|not allowed|permission denied/i.test(message)) {
    return `${t('postPermissionFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === '23502' || code === '23514' || /not-null constraint|check constraint/i.test(message)) {
    return `${t('postFieldFailed')} ${message}`;
  }
  return `${t('postPublishFailed')} (${phase}): ${message || t('retry')}`;
}

export class ComposeSheet {
  constructor({ onPublished, onGoLive } = {}) {
    this.onPublished = onPublished;
    this.onGoLive = onGoLive;
    this.sheet = new Sheet({ title: t('newPost'), className: 'compose-sheet creator-studio-sheet', dismissible: false, onClose: () => {
      this.wait?.stop('camera');
      this.wait?.stop('media');
      this.#stopCamera();
      this.#releaseMedia();
      this.#pickAudio(null);
    } });
    this.files = [];
    this.mediaSelection = 0;
    this.audioSelection = 0;
    this.audioTrack = null;
    this.soundTracks = [];
    this.soundPreview = null;
    this.soundCategory = 'hot';
    this.soundQuery = '';
    this.soundFavourites = this.#readSoundList('mw_sound_favourites');
    this.soundRecent = this.#readSoundList('mw_sound_recent');
    this.mediaPending = false;
    this.audioPending = false;
    this.publishing = false;
    this.preview = h('div', { class: 'compose-preview' });
    this.mediaInput = h('input', { type: 'file', accept: 'image/*,video/*,.heic,.heif,.mov,.m4v,.3gp', multiple: true, hidden: true, onchange: () => { void this.#pickMedia([...(this.mediaInput.files || [])]); } });
    this.audioInput = h('input', { type: 'file', accept: 'audio/*,.m4a,.aac,.wav,.ogg,.opus,.mp3', hidden: true, onchange: () => { void this.#pickAudio(this.audioInput.files?.[0] || null); } });
    this.caption = h('textarea', { class: 'field area', maxlength: '2200', placeholder: t('captionPlaceholder') });
    this.captionCount = h('small', { class: 'compose-count', 'aria-live': 'polite' }, `0 / ${this.caption.maxLength}`);
    this.caption.addEventListener('input', () => {
      this.captionCount.textContent = `${this.caption.value.length} / ${this.caption.maxLength}`;
    });
    this.style = h('select', { class: 'field', 'aria-label': t('slideshowStyle') },
      h('option', { value: 'fade' }, t('styleFade')),
      h('option', { value: 'zoom' }, t('styleZoom')),
      h('option', { value: 'cinema' }, t('styleCinema')),
      h('option', { value: 'page' }, t('stylePage')),
      h('option', { value: 'slide' }, t('styleSlide')));
    this.assist = h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#autoStyle() }, t('autoStyle'));
    this.audioPreview = h('div', { class: 'compose-audio-preview' });
    this.audioBar = h('div', { class: 'creator-audio-bar', hidden: true }, this.audioPreview);
    this.cameraStream = null;
    this.microphoneStream = null;
    this.cameraFacing = 'user';
    this.captureMode = 'photo';
    this.captureDuration = 15_000;
    this.cameraFilter = 0;
    this.cameraOrientation = 'auto';
    this.cameraZoom = 1;
    this.hardwareZoom = 1;
    this.hardwareZoomSupported = false;
    this.zoomRequest = 0;
    this.captureCanvas = null;
    this.captureCanvasStream = null;
    this.captureFrame = 0;
    this.cameraRequest = 0;
    this.cameraStarting = false;
    this.captureTimer = 0;
    this.captureRecorder = null;
    this.captureChunks = [];
    this.recordingRequest = 0;
    this.recordingStarting = false;
    this.cameraVideo = h('video', { class: 'creator-camera-video', poster: TRANSPARENT_VIDEO_POSTER, autoplay: true, muted: true, playsinline: true, 'aria-label': t('camera') });
    this.cameraBackdrop = h('div', { class: 'creator-stage-backdrop', 'aria-hidden': 'true' }, brandMark('creator-stage'));
    this.stage = h('div', { class: 'creator-stage', 'data-mode': 'photo' }, this.cameraBackdrop, this.cameraVideo, this.preview);
    for (const type of ['playing', 'loadeddata', 'resize', 'pause', 'waiting', 'stalled', 'emptied', 'ended']) {
      this.cameraVideo.addEventListener(type, () => {
        this.cameraBackdrop.hidden = !this.cameraVideo.paused && this.cameraVideo.readyState >= 2 && this.cameraVideo.videoWidth > 0;
      });
    }
    this.stageMessage = h('div', { class: 'creator-stage-message', role: 'status', 'aria-live': 'polite' });
    this.textStage = h('div', { class: 'creator-text-stage', hidden: true });
    this.photoEditor = this.#createPhotoEditor();
    this.captionWrap = h('label', { class: 'creator-caption-wrap' },
      h('span', { class: 'creator-caption-label' }, t('captionLabel')),
      this.caption, this.captionCount);
    this.creatorDetails = h('div', { class: 'creator-details', hidden: true });
    this.reviewPanel = h('section', { class: 'creator-review', hidden: true });
    this.editorIndex = 0;
    this.editorPointers = new Map();
    this.editorPinch = null;
    this.createHub = h('section', { class: 'creator-hub', hidden: true });
    this.autoStyleNextSelection = false;
    this.modeButtons = [];
    this.scheduleToggle = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch', onchange: () => this.#paintSchedule() });
    this.scheduleDate = h('input', { class: 'field compose-schedule-date', type: 'datetime-local', disabled: true, 'aria-label': t('studioScheduleTime') });
    this.scheduleDateWrap = h('div', { class: 'compose-schedule-date-wrap', 'aria-hidden': 'true' },
      h('div', { class: 'compose-schedule-date-inner' }, this.scheduleDate));
    this.message = h('p', { class: 'muted', role: 'status' });
    this.submit = h('button', { class: 'pill-btn hot wide compose-submit', type: 'submit' }, t('publish'));
    const soundButton = h('button', {
      class: 'creator-sound-button', type: 'button', 'aria-label': t('studioAddSound'),
      onclick: () => this.#openSoundPicker(),
    }, h('span', { 'aria-hidden': 'true' }, '♫'), t('studioAddSound'));
    const createTitle = h('strong', { class: 'creator-create-title' }, t('create'));
    const closeButton = h('button', {
      class: 'creator-close', type: 'button', 'aria-label': t('cancel'), title: t('cancel'),
      onclick: () => this.sheet.close(),
    }, '×');
    const tool = (action, symbol, label, handler) => h('button', {
      class: 'creator-tool', type: 'button', 'data-tool': action, 'aria-label': label, title: label, onclick: handler,
    }, h('span', { 'aria-hidden': 'true' }, symbol), h('small', {}, label));
    const flipButton = tool('flip', '↻', t('flipCamera'), () => { void this.#flipCamera(); });
    const flashButton = tool('flash', 'ϟ', t('flash'), () => { void this.#toggleFlash(flashButton); });
    const effectsButton = tool('effects', '✧', t('effects'), () => this.#cycleCameraFilter(effectsButton));
    const timerButton = tool('timer', '◷', t('timer'), () => this.#toggleCaptureTimer(timerButton));
    const settingsButton = tool('settings', '⚙', t('cameraSettings'), () => {
      this.cameraSettingsPanel.hidden = !this.cameraSettingsPanel.hidden;
      settingsButton.classList.toggle('is-active', !this.cameraSettingsPanel.hidden);
      settingsButton.setAttribute('aria-expanded', String(!this.cameraSettingsPanel.hidden));
    });
    const moreButton = tool('more', '···', t('moreOptions'), () => {
      this.#showReview();
      this.creatorDetails.hidden = false;
      this.detailsToggle.setAttribute('aria-expanded', 'true');
    });
    const galleryButton = h('button', {
      class: 'creator-gallery', type: 'button', 'aria-label': t('choosePhotosOrVideo'), title: t('choosePhotosOrVideo'),
      onclick: () => this.#openPicker(this.mediaInput),
    }, '▧');
    this.shutter = h('button', {
      class: 'creator-shutter', type: 'button', 'aria-label': t('camera'), title: t('camera'),
      onclick: () => { void this.#capture(); },
    }, h('span', { 'aria-hidden': 'true' }));
    const effectsShortcut = h('button', {
      class: 'creator-effects-shortcut', type: 'button', 'aria-label': t('effects'), title: t('effects'),
      onclick: () => this.#cycleCameraFilter(effectsButton),
    }, '✧');
    const captureModes = [
      [t('photo'), 'photo', 0],
      [t('studioVideo15'), 'video', 15_000],
      [t('studioVideo60'), 'video', 60_000],
      [t('studioVideo10m'), 'video', 600_000],
    ];
    const modeRow = h('div', { class: 'creator-mode-row', role: 'group', 'aria-label': t('camera') },
      ...captureModes.map(([label, mode, duration]) => {
        const button = h('button', {
          class: 'creator-mode', type: 'button', 'aria-pressed': String(mode === 'photo'),
          dataset: { mode, duration: String(duration) },
          onclick: () => {
            this.captureDuration = duration;
            this.#setCaptureMode(mode, button);
          },
        }, label);
        this.modeButtons.push(button);
        return button;
      }));
    this.orientationButtons = [];
    const orientationModes = [
      ['auto', t('cameraAuto')],
      ['portrait', t('cameraPortrait')],
      ['landscape', t('cameraLandscape')],
    ];
    const orientationGroup = h('div', { class: 'creator-settings-options', role: 'group', 'aria-label': t('cameraOrientation') },
      ...orientationModes.map(([value, label]) => {
        const button = h('button', {
          class: 'creator-settings-option', type: 'button', 'aria-pressed': String(value === this.cameraOrientation),
          onclick: () => { void this.#setCameraOrientation(value); },
        }, label);
        this.orientationButtons.push(button);
        return button;
      }));
    this.zoomSlider = h('input', {
      class: 'creator-zoom-slider', id: 'creatorZoom', type: 'range', min: '1', max: '3', step: '0.05', value: String(this.cameraZoom),
      'aria-label': t('cameraZoom'), oninput: () => { void this.#setCameraZoom(Number(this.zoomSlider.value)); },
    });
    const zoomOutButton = h('button', {
      class: 'creator-zoom-step', type: 'button', 'aria-label': t('zoomOut'),
      onclick: () => { void this.#setCameraZoom(this.cameraZoom - 0.1); },
    }, '−');
    const zoomInButton = h('button', {
      class: 'creator-zoom-step', type: 'button', 'aria-label': t('zoomIn'),
      onclick: () => { void this.#setCameraZoom(this.cameraZoom + 0.1); },
    }, '+');
    this.zoomValue = h('output', { class: 'creator-zoom-value', htmlFor: 'creatorZoom' }, '1.0×');
    this.cameraSettingsPanel = h('section', { class: 'creator-settings-panel', hidden: true },
      h('header', { class: 'creator-settings-head' }, h('strong', {}, t('cameraSettings')),
        h('button', { class: 'creator-settings-close', type: 'button', 'aria-label': t('close'), onclick: () => {
          this.cameraSettingsPanel.hidden = true;
          settingsButton.classList.remove('is-active');
          settingsButton.setAttribute('aria-expanded', 'false');
        } }, '×')),
      h('label', { class: 'creator-settings-label' }, t('cameraOrientation')),
      orientationGroup,
      h('label', { class: 'creator-settings-label', for: 'creatorZoom' }, t('cameraZoom')),
      h('div', { class: 'creator-zoom-controls' }, zoomOutButton, this.zoomSlider, zoomInButton),
      this.zoomValue,
      h('small', { class: 'creator-settings-hint' }, t('cameraAutoHint')));
    const createTool = (label, symbol, handler) => h('button', {
      class: 'creator-hub-tool', type: 'button', onclick: handler, 'aria-label': label,
    }, h('span', { 'aria-hidden': 'true' }, symbol), h('b', {}, label));
    const openMediaForAutoCut = () => {
      this.autoStyleNextSelection = true;
      this.#openPicker(this.mediaInput);
    };
    const openDrafts = () => {
      if (this.files.length || this.caption.value.trim() || this.audioFile) this.#showReview();
      else toast(t('studioNoDrafts'));
    };
    const startNewVideo = () => {
      this.form.dataset.mode = 'camera';
      this.createHub.hidden = true;
      this.viewModeButtons.camera.classList.add('is-selected');
      this.viewModeButtons.camera.setAttribute('aria-pressed', 'true');
      this.viewModeButtons.create.classList.remove('is-selected');
      this.viewModeButtons.create.setAttribute('aria-pressed', 'false');
      this.captureDuration = 15_000;
      this.#setCaptureMode('video');
      void this.#startCamera();
    };
    const templateFilters = [
      ['all', t('studioTemplateForYou')],
      ['viral', t('studioTemplateViral')],
      ['trendy', t('studioTemplateTrendy')],
      ['ai', t('studioTemplateAi')],
      ['recap', t('studioTemplateRecap')],
    ];
    const templateFilterButtons = [];
    const templateStyles = [
      ['fade', 'viral', t('styleFade')],
      ['zoom', 'trendy', t('styleZoom')],
      ['cinema', 'ai', t('styleCinema')],
      ['page', 'recap', t('stylePage')],
      ['slide', 'viral', t('styleSlide')],
    ];
    const templateGrid = h('div', { class: 'creator-template-grid' },
      ...templateStyles.map(([style, category, label]) => {
        const button = h('button', {
          class: 'creator-template', type: 'button', dataset: { category, style, label },
          'aria-pressed': String(this.style.value === style),
          onclick: () => {
            this.style.value = style;
            templateGrid.querySelectorAll('.creator-template').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            this.message.textContent = '';
          },
        }, h('span', { class: `creator-template-preview style-${style}`, 'aria-hidden': 'true' }, '✦'), h('small', {}, label));
        return button;
      }));
    const templateSearch = h('input', {
      class: 'creator-template-search', type: 'search', placeholder: t('studioTemplateSearch'),
      'aria-label': t('studioTemplateSearch'), hidden: true,
      oninput: () => {
        const query = templateSearch.value.trim().toLocaleLowerCase();
        templateGrid.querySelectorAll('.creator-template').forEach(template => {
          template.hidden = (query && !template.dataset.label.toLocaleLowerCase().includes(query))
            || (activeTemplateCategory !== 'all' && template.dataset.category !== activeTemplateCategory);
        });
      },
    });
    let activeTemplateCategory = 'all';
    const templateSearchButton = h('button', {
      class: 'creator-template-search-button', type: 'button', 'aria-label': t('studioTemplateSearch'),
      'aria-expanded': 'false', onclick: () => {
        templateSearch.hidden = !templateSearch.hidden;
        templateSearchButton.setAttribute('aria-expanded', String(!templateSearch.hidden));
        if (!templateSearch.hidden) templateSearch.focus({ preventScroll: true });
        else { templateSearch.value = ''; templateSearch.dispatchEvent(new Event('input')); }
      },
    }, '⌕');
    const templateFilter = h('div', { class: 'creator-template-filters', role: 'group', 'aria-label': t('studioTemplates') },
      ...templateFilters.map(([category, label], index) => {
        const button = h('button', {
          class: `creator-template-filter${index === 0 ? ' is-selected' : ''}`, type: 'button',
          'aria-pressed': String(index === 0),
          onclick: () => {
            activeTemplateCategory = category;
            templateFilterButtons.forEach(filter => {
              const selected = filter === button;
              filter.classList.toggle('is-selected', selected);
              filter.setAttribute('aria-pressed', String(selected));
            });
            templateGrid.querySelectorAll('.creator-template').forEach(template => {
              const query = templateSearch.value.trim().toLocaleLowerCase();
              template.hidden = (category !== 'all' && template.dataset.category !== category)
                || (query && !template.dataset.label.toLocaleLowerCase().includes(query));
            });
          },
        }, label);
        templateFilterButtons.push(button);
        return button;
      }));
    const templatesSection = h('section', { class: 'creator-templates' },
      h('div', { class: 'creator-templates-heading' }, h('h3', {}, t('studioTemplates')), templateSearchButton),
      templateSearch, templateFilter, templateGrid);
    const liveShortcut = h('button', {
      class: 'creator-live-shortcut', type: 'button', onclick: () => {
        this.sheet.close();
        this.onGoLive?.();
      },
    }, h('span', { 'aria-hidden': 'true' }, '●'), t('studioLiveShortcut'));
    this.createHub.append(
      h('div', { class: 'creator-hub-tools' },
        createTool(t('studioPhotoEditor'), '▧', () => this.#openPicker(this.mediaInput)),
        createTool(t('studioAutoCut'), '✦', openMediaForAutoCut),
        createTool(t('studioCaptions'), 'Aa', () => {
          this.#showReview();
          this.caption.focus({ preventScroll: true });
        }),
        createTool(t('studioAiSelf'), '✧', () => this.#openPicker(this.mediaInput)),
        createTool(t('studioCutout'), '◉', () => this.#openPicker(this.mediaInput))),
      h('div', { class: 'creator-hub-actions' },
        h('button', { class: 'creator-hub-action creator-hub-new-video', type: 'button', onclick: startNewVideo },
          h('span', { 'aria-hidden': 'true' }, '+'), h('b', {}, t('studioNewVideo'))),
        h('button', { class: 'creator-hub-action creator-hub-drafts', type: 'button', onclick: openDrafts },
          h('span', { 'aria-hidden': 'true' }, '▤'), h('b', {}, t('studioDrafts')))),
      templatesSection);
    const detailsToggle = h('button', {
      class: 'creator-details-toggle', type: 'button', 'aria-expanded': 'false',
      onclick: () => {
        this.creatorDetails.hidden = !this.creatorDetails.hidden;
        detailsToggle.setAttribute('aria-expanded', String(!this.creatorDetails.hidden));
      },
    }, t('moreOptions'));
    this.detailsToggle = detailsToggle;
    const reviewBack = h('button', {
      class: 'creator-review-back', type: 'button', onclick: () => this.#returnFromReview(),
    }, t('studioReviewBack'));
    this.reviewBackButton = reviewBack;
    const cameraViewButton = h('button', {
      class: 'creator-view-mode is-selected', type: 'button', 'aria-pressed': 'true',
      onclick: () => {
        this.form.dataset.mode = 'camera';
        this.createHub.hidden = true;
        cameraViewButton.classList.add('is-selected');
        cameraViewButton.setAttribute('aria-pressed', 'true');
        createViewButton.classList.remove('is-selected');
        createViewButton.setAttribute('aria-pressed', 'false');
        this.captureDuration = 15_000;
        this.#setCaptureMode('photo');
        this.form.dataset.view = 'camera';
        this.reviewPanel.hidden = true;
        this.stageMessage.textContent = '';
        void this.#startCamera();
      },
    }, t('camera'));
    const createViewButton = h('button', {
      class: 'creator-view-mode', type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        this.#leaveCameraView();
        this.form.dataset.mode = 'create';
        this.createHub.hidden = false;
        createViewButton.classList.add('is-selected');
        createViewButton.setAttribute('aria-pressed', 'true');
        cameraViewButton.classList.remove('is-selected');
        cameraViewButton.setAttribute('aria-pressed', 'false');
        this.form.dataset.view = 'camera';
        this.reviewPanel.hidden = true;
        this.#setCaptureMode('photo');
      },
    }, t('create'));
    this.viewModeButtons = { camera: cameraViewButton, create: createViewButton };
    this.cameraToolButtons = { flashButton, effectsButton, timerButton, settingsButton, moreButton };
    this.scheduleToggle.id = 'composeScheduleToggle';
    const scheduleLabel = h('label', { class: 'compose-schedule-toggle', for: this.scheduleToggle.id },
      h('span', { class: 'compose-schedule-copy' },
        h('b', {}, t('studioSchedulePost')),
        h('small', { class: 'muted' }, t('studioScheduleHint'))),
      this.scheduleToggle);
    this.reviewPanel.append(
      h('header', { class: 'creator-review-head' }, reviewBack, h('strong', {}, t('studioReviewPost'))),
      this.captionWrap,
      this.audioBar,
      detailsToggle,
      this.creatorDetails,
      h('div', { class: 'creator-submit-area' }, this.submit, this.message));
    this.form = h('form', {
      class: 'compose-form creator-form',
      onsubmit: event => { event.preventDefault(); this.#publish(); },
      dataset: { view: 'camera' },
    },
    h('header', { class: 'creator-header' }, closeButton, soundButton, createTitle, h('span', { class: 'creator-header-spacer', 'aria-hidden': 'true' })),
    this.mediaInput, this.audioInput,
    this.photoEditor,
    h('div', { class: 'creator-stage-wrap' },
      this.stage, this.textStage, this.stageMessage,
      this.cameraSettingsPanel,
      h('aside', { class: 'creator-tool-rail', 'aria-label': t('camera') }, flipButton, flashButton, effectsButton, timerButton, settingsButton, moreButton)),
    this.createHub,
    modeRow,
    h('div', { class: 'creator-capture-row' }, galleryButton, this.shutter, effectsShortcut),
    h('div', { class: 'creator-bottom-dock' }, liveShortcut,
      h('div', { class: 'creator-bottom-switch', role: 'group', 'aria-label': t('create') }, cameraViewButton, createViewButton)),
    this.reviewPanel);
    this.sheet.body.append(this.form);
    this.wait = new WaitIndicator(this.sheet.panel);
    this.creatorDetails.append(
      h('div', { class: 'compose-assist' }, this.assist, this.style),
      h('section', { class: 'compose-card compose-schedule-card' }, scheduleLabel, this.scheduleDateWrap));
  }

  #createPhotoEditor() {
    const filters = [
      ['original', t('editorOriginal')],
      ['galaxy', t('editorGalaxyGlow')],
      ['vivid', t('editorVivid')],
      ['warm', t('editorWarm')],
      ['crisp', t('editorCrisp')],
      ['mono', t('editorBlackWhite')],
    ];
    const stickers = ['✨', '🌙', '💫', '⭐'];
    this.editorImage = h('img', { class: 'creator-photo-editor-image', alt: '', draggable: 'false' });
    this.editorText = h('div', { class: 'creator-photo-editor-text', hidden: true });
    this.editorIndexLabel = h('span', { class: 'creator-photo-editor-index', 'aria-live': 'polite' });
    this.photoEditorMessage = h('p', { class: 'creator-photo-editor-message', role: 'status', 'aria-live': 'polite' });
    this.editorZoom = h('input', {
      class: 'creator-photo-editor-range', type: 'range', min: '1', max: '3', step: '0.01', value: '1',
      'aria-label': t('cameraZoom'),
      oninput: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        edit.zoom = Number(this.editorZoom.value);
        this.#paintPhotoEditor();
      },
    });
    this.editorTextInput = h('input', {
      class: 'creator-photo-editor-text-input', type: 'text', maxlength: '80',
      placeholder: t('editorAddText'), 'aria-label': t('editorAddText'),
      oninput: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        edit.text = this.editorTextInput.value;
        this.#paintPhotoEditor();
      },
    });
    const frame = h('div', { class: 'creator-photo-editor-frame' }, this.editorImage, this.editorText, this.editorIndexLabel);
    const filterButtons = filters.map(([filter, label]) => {
      const button = h('button', {
        class: 'creator-photo-editor-filter', type: 'button', dataset: { filter },
        onclick: () => {
          const edit = this.#photoEdit();
          if (!edit) return;
          edit.filter = filter;
          this.#paintPhotoEditor();
        },
      }, label);
      return button;
    });
    const adjustment = (key, label, min, max, initial) => {
      const input = h('input', {
        class: 'creator-photo-editor-range', type: 'range', min: String(min), max: String(max), value: String(initial),
        'aria-label': label,
        oninput: () => {
          const edit = this.#photoEdit();
          if (!edit) return;
          edit[key] = Number(input.value);
          this.#paintPhotoEditor();
        },
      });
      return h('label', { class: 'creator-photo-editor-adjustment', dataset: { adjustment: key } }, h('span', {}, label), input);
    };
    const fitButton = h('button', {
      class: 'creator-photo-editor-tool is-selected', type: 'button', 'aria-pressed': 'true',
      onclick: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        edit.fit = 'fit';
        this.#paintPhotoEditor();
      },
    }, t('editorFit'));
    const fillButton = h('button', {
      class: 'creator-photo-editor-tool', type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        edit.fit = 'fill';
        this.#paintPhotoEditor();
      },
    }, t('editorFill'));
    this.editorFitButtons = { fit: fitButton, fill: fillButton };
    const rotateButton = h('button', {
      class: 'creator-photo-editor-tool', type: 'button',
      onclick: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        edit.rotation = (edit.rotation + 90) % 360;
        this.#paintPhotoEditor();
      },
    }, `↻ ${t('editorRotate')}`);
    const resetButton = h('button', {
      class: 'creator-photo-editor-tool', type: 'button',
      onclick: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        Object.assign(edit, { zoom: 1, panX: 0, panY: 0, fit: 'fit', filter: 'original', brightness: 100, contrast: 100, saturation: 100, rotation: 0, text: '', textX: 50, textY: 50, sticker: '' });
        this.#paintPhotoEditor();
      },
    }, t('editorReset'));
    const stickerButton = h('button', {
      class: 'creator-photo-editor-tool', type: 'button',
      onclick: () => {
        const edit = this.#photoEdit();
        if (!edit) return;
        const index = stickers.indexOf(edit.sticker);
        edit.sticker = stickers[(index + 1) % stickers.length];
        this.#paintPhotoEditor();
      },
    }, t('editorStickers'));
    const removeButton = h('button', {
      class: 'creator-photo-editor-tool is-danger', type: 'button',
      onclick: () => this.#removePhoto(this.editorIndex),
    }, t('remove'));
    const closeButton = h('button', {
      class: 'creator-photo-editor-close', type: 'button', 'aria-label': t('close'),
      onclick: () => this.sheet.close(),
    }, '×');
    const soundButton = h('button', {
      class: 'creator-photo-editor-sound', type: 'button',
      onclick: () => this.#openSoundPicker(),
    }, '♫ ', t('studioAddSound'));
    const nextButton = h('button', {
      class: 'creator-photo-editor-next', type: 'button',
      onclick: () => { void this.#commitPhotoEdits(); },
    }, t('editorNext'), '  ›');
    this.photoEditorNext = nextButton;
    const navigate = direction => {
      if (this.files.length < 2) return;
      this.editorIndex = (this.editorIndex + direction + this.files.length) % this.files.length;
      this.#paintPhotoEditor();
    };
    this.editorPrevious = h('button', {
      class: 'creator-photo-editor-nav', type: 'button', 'aria-label': t('previous'),
      onclick: () => navigate(-1),
    }, '‹');
    this.editorNextPhoto = h('button', {
      class: 'creator-photo-editor-nav', type: 'button', 'aria-label': t('next'),
      onclick: () => navigate(1),
    }, '›');
    frame.addEventListener('pointerdown', event => {
      if (event.target === this.editorText) return;
      frame.setPointerCapture(event.pointerId);
      this.editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const edit = this.#photoEdit();
      if (!edit) return;
      if (this.editorPointers.size === 2) {
        const points = [...this.editorPointers.values()];
        this.editorPinch = {
          distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
          zoom: edit.zoom,
        };
        this.editorDrag = null;
      } else this.editorDrag = { x: event.clientX, y: event.clientY, panX: edit.panX, panY: edit.panY };
    });
    frame.addEventListener('pointermove', event => {
      if (!this.editorPointers.has(event.pointerId)) return;
      this.editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const edit = this.#photoEdit();
      if (!edit) return;
      if (this.editorPointers.size > 1 && this.editorPinch) {
        const points = [...this.editorPointers.values()];
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        edit.zoom = Math.max(1, Math.min(3, this.editorPinch.zoom * distance / (this.editorPinch.distance || distance)));
        this.editorZoom.value = String(edit.zoom);
      } else if (this.editorDrag) {
        edit.panX = this.editorDrag.panX + event.clientX - this.editorDrag.x;
        edit.panY = this.editorDrag.panY + event.clientY - this.editorDrag.y;
      }
      this.#paintPhotoEditor();
    });
    const endPointer = event => {
      this.editorPointers.delete(event.pointerId);
      if (this.editorPointers.size < 2) {
        this.editorPinch = null;
        const remaining = [...this.editorPointers.values()][0];
        const edit = this.#photoEdit();
        this.editorDrag = remaining && edit
          ? { x: remaining.x, y: remaining.y, panX: edit.panX, panY: edit.panY }
          : null;
      }
    };
    frame.addEventListener('pointerup', endPointer);
    frame.addEventListener('pointercancel', endPointer);
    this.editorText.addEventListener('pointerdown', event => {
      event.stopPropagation();
      this.editorText.setPointerCapture(event.pointerId);
      const rect = frame.getBoundingClientRect();
      this.editorTextDrag = { pointerId: event.pointerId, rect };
    });
    this.editorText.addEventListener('pointermove', event => {
      if (this.editorTextDrag?.pointerId !== event.pointerId) return;
      const edit = this.#photoEdit();
      if (!edit) return;
      edit.textX = Math.max(0, Math.min(100, (event.clientX - this.editorTextDrag.rect.left) / this.editorTextDrag.rect.width * 100));
      edit.textY = Math.max(0, Math.min(100, (event.clientY - this.editorTextDrag.rect.top) / this.editorTextDrag.rect.height * 100));
      this.#paintPhotoEditor();
    });
    this.editorText.addEventListener('pointerup', () => { this.editorTextDrag = null; });
    this.editorText.addEventListener('pointercancel', () => { this.editorTextDrag = null; });
    return h('section', { class: 'creator-photo-editor', hidden: true, 'aria-label': t('editorPreview') },
      h('header', { class: 'creator-photo-editor-header' }, closeButton, soundButton, nextButton),
      h('div', { class: 'creator-photo-editor-stage' }, this.editorPrevious, frame, this.editorNextPhoto),
      h('div', { class: 'creator-photo-editor-controls' },
        h('div', { class: 'creator-photo-editor-filters', role: 'group', 'aria-label': t('editorFilters') }, ...filterButtons),
        h('div', { class: 'creator-photo-editor-adjustments' },
          adjustment('brightness', t('editorBrightness'), 50, 150, 100),
          adjustment('contrast', t('editorContrast'), 50, 150, 100),
          adjustment('saturation', t('editorSaturation'), 0, 200, 100)),
        h('div', { class: 'creator-photo-editor-tools' },
          h('label', { class: 'creator-photo-editor-zoom' }, h('span', {}, t('cameraZoom')), this.editorZoom),
          fitButton, fillButton, rotateButton, resetButton, stickerButton, removeButton),
        h('label', { class: 'creator-photo-editor-text-control' }, this.editorTextInput),
        this.photoEditorMessage),
      h('footer', { class: 'creator-photo-editor-footer' }, this.editorIndexLabel));
  }

  #photoEdit(entry = this.files[this.editorIndex]) {
    if (!entry || entry.kind !== 'image') return null;
    entry.edit ||= {
      zoom: 1, panX: 0, panY: 0, fit: 'fit', filter: 'original',
      brightness: 100, contrast: 100, saturation: 100, rotation: 0,
      text: '', textX: 50, textY: 50, sticker: '',
    };
    return entry.edit;
  }

  #paintPhotoEditor() {
    const entry = this.files[this.editorIndex];
    if (!entry || entry.kind !== 'image') return;
    const edit = this.#photoEdit(entry);
    const filter = {
      original: '',
      galaxy: 'contrast(1.1) saturate(1.25) brightness(1.05)',
      vivid: 'saturate(1.45) contrast(1.08)',
      warm: 'sepia(.22) saturate(1.18)',
      crisp: 'contrast(1.2) saturate(1.08)',
      mono: 'grayscale(1) contrast(1.08)',
    }[edit.filter] || '';
    if (this.editorImage.src !== entry.url) this.editorImage.src = entry.url;
    this.editorImage.style.objectFit = edit.fit === 'fill' ? 'cover' : 'contain';
    this.editorImage.style.filter = `${filter} brightness(${edit.brightness}%) contrast(${edit.contrast}%) saturate(${edit.saturation}%)`;
    this.editorImage.style.transform = `translate(calc(-50% + ${edit.panX}px), calc(-50% + ${edit.panY}px)) scale(${edit.zoom}) rotate(${edit.rotation}deg)`;
    this.editorText.textContent = edit.text || edit.sticker;
    this.editorText.hidden = !(edit.text || edit.sticker);
    this.editorText.style.left = `${edit.textX}%`;
    this.editorText.style.top = `${edit.textY}%`;
    this.editorZoom.value = String(edit.zoom);
    if (this.editorTextInput.value !== edit.text) this.editorTextInput.value = edit.text;
    this.editorIndexLabel.textContent = this.files.length > 1 ? `${this.editorIndex + 1} / ${this.files.length}` : '';
    this.editorPrevious.hidden = this.files.length < 2;
    this.editorNextPhoto.hidden = this.files.length < 2;
    this.photoEditor.querySelectorAll('.creator-photo-editor-filter').forEach(button => {
      button.classList.toggle('is-selected', button.dataset.filter === edit.filter);
      button.setAttribute('aria-pressed', String(button.dataset.filter === edit.filter));
    });
    for (const [fit, button] of Object.entries(this.editorFitButtons)) {
      button.classList.toggle('is-selected', edit.fit === fit);
      button.setAttribute('aria-pressed', String(edit.fit === fit));
    }
    this.photoEditor.querySelectorAll('.creator-photo-editor-adjustment input').forEach(input => {
      const key = input.closest('.creator-photo-editor-adjustment').dataset.adjustment;
      if (key) input.value = String(edit[key]);
    });
  }

  #showPhotoEditor() {
    if (!this.files.length || this.files.some(entry => entry.kind !== 'image')) return false;
    this.editorIndex = Math.min(this.editorIndex, this.files.length - 1);
    this.#leaveCameraView();
    this.message.textContent = '';
    this.stageMessage.textContent = '';
    this.photoEditorMessage.textContent = '';
    this.form.dataset.view = 'editor';
    this.reviewPanel.hidden = true;
    this.photoEditor.hidden = false;
    this.createHub.hidden = true;
    this.#paintPhotoEditor();
    return true;
  }

  #returnFromReview() {
    if (!this.#showPhotoEditor()) {
      this.#backToCamera();
      this.photoEditor.hidden = true;
    }
  }

  async #commitPhotoEdits() {
    if (!this.files.length || this.files.some(entry => entry.kind !== 'image') || this.mediaPending) return;
    this.wait.start('photo-edit', t('processingMedia'));
    this.photoEditorNext.disabled = true;
    const editedFiles = [];
    try {
      for (const entry of this.files) {
        const edit = this.#photoEdit(entry);
        if (!edit || (edit.zoom === 1 && edit.panX === 0 && edit.panY === 0 && edit.fit === 'fit'
          && edit.filter === 'original' && edit.brightness === 100 && edit.contrast === 100
          && edit.saturation === 100 && edit.rotation === 0 && !edit.text && !edit.sticker)) continue;
        const bitmap = await createImageBitmap(entry.file);
        try {
          const rotated = edit.rotation % 180 !== 0;
          const orientedWidth = rotated ? bitmap.height : bitmap.width;
          const orientedHeight = rotated ? bitmap.width : bitmap.height;
          const frame = this.editorImage.parentElement.getBoundingClientRect();
          const frameAspect = frame.width && frame.height ? frame.width / frame.height : orientedWidth / orientedHeight;
          let outputWidth = orientedWidth;
          let outputHeight = orientedHeight;
          if (edit.fit === 'fill') {
            if (orientedWidth / orientedHeight > frameAspect) outputWidth = Math.round(orientedHeight * frameAspect);
            else outputHeight = Math.round(orientedWidth / frameAspect);
          }
          const outputScale = Math.min(1, 4096 / Math.max(outputWidth, outputHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(outputWidth * outputScale));
          canvas.height = Math.max(1, Math.round(outputHeight * outputScale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error(t('photoCropFailed'));
          const fitScale = edit.fit === 'fill'
            ? Math.max(canvas.width / orientedWidth, canvas.height / orientedHeight)
            : Math.min(canvas.width / orientedWidth, canvas.height / orientedHeight);
          const scale = fitScale * edit.zoom;
          const filter = {
            original: '',
            galaxy: 'contrast(1.1) saturate(1.25) brightness(1.05)',
            vivid: 'saturate(1.45) contrast(1.08)',
            warm: 'sepia(.22) saturate(1.18)',
            crisp: 'contrast(1.2) saturate(1.08)',
            mono: 'grayscale(1) contrast(1.08)',
          }[edit.filter] || '';
          context.filter = `${filter} brightness(${edit.brightness}%) contrast(${edit.contrast}%) saturate(${edit.saturation}%)`;
          context.translate(canvas.width / 2, canvas.height / 2);
          context.rotate(edit.rotation * Math.PI / 180);
          context.drawImage(bitmap,
            -bitmap.width * scale / 2 + edit.panX / Math.max(1, frame.width) * canvas.width,
            -bitmap.height * scale / 2 + edit.panY / Math.max(1, frame.height) * canvas.height,
            bitmap.width * scale, bitmap.height * scale);
          const text = edit.text || edit.sticker;
          if (text) {
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.filter = 'none';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.font = `700 ${Math.max(28, Math.round(canvas.width * .07))}px sans-serif`;
            context.lineWidth = Math.max(3, Math.round(canvas.width * .006));
            context.strokeStyle = 'rgba(0,0,0,.68)';
            context.fillStyle = '#fff';
            const x = canvas.width * edit.textX / 100;
            const y = canvas.height * edit.textY / 100;
            context.strokeText(text, x, y, canvas.width * .82);
            context.fillText(text, x, y, canvas.width * .82);
          }
          const blob = await canvasToBlob(canvas, entry.file.type || 'image/jpeg', 0.94);
          const file = new File([blob], entry.file.name, { type: blob.type });
          if (file.size > MAX_IMAGE) throw new Error(t('imageTooBig'));
          editedFiles.push({ entry, file, url: URL.createObjectURL(file) });
        } finally {
          bitmap.close();
        }
      }
      for (const { entry, file, url } of editedFiles) {
        const originalUrl = entry.url;
        entry.file = file;
        entry.url = url;
        delete entry.edit;
        URL.revokeObjectURL(originalUrl);
      }
      this.#renderPreview();
      this.photoEditor.hidden = true;
      this.#showReview();
    } catch (error) {
      editedFiles.forEach(({ url }) => URL.revokeObjectURL(url));
      console.error('[compose] photo editing could not be applied', error);
      this.photoEditorMessage.textContent = readableError(error, t('photoCropFailed'));
    } finally {
      this.photoEditorNext.disabled = false;
      this.wait.stop('photo-edit');
    }
  }

  open(view = 'camera') {
    this.message.textContent = '';
    this.scheduleToggle.checked = false;
    this.scheduleDate.value = '';
    const earliest = new Date(Date.now() + 5 * 60 * 1000);
    earliest.setSeconds(0, 0);
    const latest = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    this.scheduleDate.min = new Date(earliest.getTime() - earliest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.scheduleDate.max = new Date(latest.getTime() - latest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.#paintSchedule();
    this.creatorDetails.hidden = true;
    this.detailsToggle.setAttribute('aria-expanded', 'false');
    this.reviewPanel.hidden = true;
    this.form.dataset.view = 'camera';
    const showCreate = view === 'create';
    this.form.dataset.mode = showCreate ? 'create' : 'camera';
    this.stage.dataset.orientation = this.cameraOrientation;
    this.cameraSettingsPanel.hidden = true;
    this.cameraToolButtons.settingsButton.classList.remove('is-active');
    this.cameraToolButtons.settingsButton.setAttribute('aria-expanded', 'false');
    this.zoomSlider.value = String(this.cameraZoom);
    this.#paintCameraZoom();
    this.autoStyleNextSelection = false;
    this.createHub.hidden = !showCreate;
    this.audioBar.hidden = !this.audioFile;
    this.stage.dataset.filter = '0';
    this.stage.dataset.timer = '';
    Object.values(this.cameraToolButtons).forEach(button => button.classList.remove('is-active'));
    this.viewModeButtons.camera.classList.toggle('is-selected', !showCreate);
    this.viewModeButtons.camera.setAttribute('aria-pressed', String(!showCreate));
    this.viewModeButtons.create.classList.toggle('is-selected', showCreate);
    this.viewModeButtons.create.setAttribute('aria-pressed', String(showCreate));
    this.cameraVideo.classList.toggle('is-selfie', this.cameraFacing === 'user');
    this.captureMode = 'photo';
    this.captureDuration = 15_000;
    this.cameraFilter = 0;
    this.#setCaptureMode('photo');
    this.stageMessage.textContent = '';
    this.preview.replaceChildren();
    this.stage.classList.remove('has-media');
    this.sheet.open();
    if (showCreate) {
      this.#leaveCameraView();
    } else void this.#startCamera();
  }

  #showReview() {
    if (this.form.dataset.view !== 'review') this.reviewReturnMode = this.form.dataset.mode || 'camera';
    this.reviewBackButton.textContent = `‹ ${t('studioReviewBack')}`;
    if (this.captureMode === 'text') this.reviewPanel.insertBefore(this.captionWrap, this.audioBar);
    this.form.dataset.view = 'review';
    this.reviewPanel.hidden = false;
    this.photoEditor.hidden = true;
    this.createHub.hidden = true;
  }

  #renderPreview() {
    this.preview.replaceChildren();
    for (const [index, entry] of this.files.entries()) {
      const media = entry.kind === 'video'
        ? h('video', { src: entry.url, controls: true, playsinline: true, muted: true, preload: 'metadata' })
        : h('img', { src: entry.url, alt: `${t('slide')} ${index + 1}` });
      this.preview.append(h('div', { class: 'compose-photo' }, media,
        h('span', { class: 'compose-photo-index' }, String(index + 1)),
        h('button', { class: 'link', type: 'button', 'aria-label': `${t('remove')} ${index + 1}`, onclick: () => this.#removePhoto(index) }, t('remove'))));
    }
    if (this.files.length > 1 && this.files.every(entry => entry.kind === 'image')) {
      this.preview.prepend(h('small', { class: 'muted compose-count' }, `${this.files.length} ${t('photosInSlideshow')}`));
    }
  }

  #showCurrentMediaStep() {
    if (this.files.length && this.files.every(entry => entry.kind === 'image')) this.#showPhotoEditor();
    else this.#showReview();
  }

  #backToCamera() {
    this.form.dataset.mode = this.reviewReturnMode === 'create' ? 'create' : 'camera';
    this.form.dataset.view = 'camera';
    this.reviewPanel.hidden = true;
    this.photoEditor.hidden = true;
    this.createHub.hidden = this.form.dataset.mode !== 'create';
    if (this.captureMode === 'text') this.textStage.append(this.captionWrap);
  }

  #discardCapture() {
    this.#releaseMedia();
    this.stageMessage.textContent = '';
    this.message.textContent = '';
    this.#backToCamera();
  }

  async #startCamera() {
    if (this.cameraStream || this.cameraStarting || !this.sheet.isOpen) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.#showCameraFallback();
      return;
    }
    this.cameraStarting = true;
    const request = ++this.cameraRequest;
    let cameraTimedOut = false;
    let cameraTimeout;
    try {
      const video = { facingMode: this.cameraFacing };
      if (this.cameraOrientation === 'portrait') video.aspectRatio = { ideal: 9 / 16 };
      else if (this.cameraOrientation === 'landscape') video.aspectRatio = { ideal: 16 / 9 };
      const cameraRequest = navigator.mediaDevices.getUserMedia({
        audio: false,
        video,
      });
      cameraRequest.then(stream => {
        if (cameraTimedOut || request !== this.cameraRequest || !this.sheet.isOpen) {
          stream.getTracks().forEach(track => track.stop());
        }
      }, () => undefined);
      const stream = await Promise.race([
        cameraRequest,
        new Promise((_, reject) => {
          cameraTimeout = setTimeout(() => {
            cameraTimedOut = true;
            reject(new Error(t('cameraAccessFailed')));
          }, 15_000);
        }),
      ]);
      if (request !== this.cameraRequest || !this.sheet.isOpen) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.cameraStream = stream;
      this.cameraVideo.classList.toggle('is-selfie', this.cameraFacing === 'user');
      this.cameraVideo.srcObject = this.cameraStream;
      await this.cameraVideo.play();
      await this.#applyHardwareZoom();
      this.stageMessage.textContent = '';
    } catch (error) {
      if (request === this.cameraRequest) {
        console.warn('[compose] camera unavailable; device media remains available', error);
        this.#stopCamera();
        this.#showCameraFallback();
      }
    } finally {
      clearTimeout(cameraTimeout);
      if (request === this.cameraRequest) {
        this.cameraStarting = false;
      }
    }
  }

  #showCameraFallback() {
    this.stageMessage.replaceChildren();
  }

  async #setCameraOrientation(orientation) {
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) return;
    this.cameraOrientation = orientation;
    this.stage.dataset.orientation = orientation;
    this.orientationButtons.forEach((button, index) => {
      const selected = ['auto', 'portrait', 'landscape'][index] === orientation;
      button.setAttribute('aria-pressed', String(selected));
    });
    if (!this.cameraStream) {
      if (this.cameraStarting) {
        this.cameraRequest++;
        this.cameraStarting = false;
        void this.#startCamera();
      }
      return;
    }
    this.#stopCamera();
    await this.#startCamera();
  }

  async #setCameraZoom(zoom) {
    this.cameraZoom = Math.min(3, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
    this.zoomSlider.value = String(this.cameraZoom);
    this.zoomValue.value = `${this.cameraZoom.toFixed(1)}×`;
    this.zoomValue.textContent = this.zoomValue.value;
    await this.#applyHardwareZoom();
  }

  async #applyHardwareZoom() {
    const request = ++this.zoomRequest;
    const track = this.cameraStream?.getVideoTracks()[0];
    let zoom;
    try {
      zoom = track?.getCapabilities?.().zoom;
    } catch {
      this.hardwareZoomSupported = false;
      this.hardwareZoom = 1;
      this.#paintCameraZoom();
      return;
    }
    this.hardwareZoomSupported = Boolean(zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max));
    if (!this.hardwareZoomSupported) {
      this.hardwareZoom = 1;
      this.#paintCameraZoom();
      return;
    }
    const target = Math.min(zoom.max, Math.max(zoom.min, this.cameraZoom));
    try {
      await track.applyConstraints({ advanced: [{ zoom: target }] });
      if (request !== this.zoomRequest) return;
      this.hardwareZoom = target;
    } catch {
      if (request !== this.zoomRequest) return;
      this.hardwareZoomSupported = false;
      this.hardwareZoom = 1;
    }
    this.#paintCameraZoom();
  }

  #paintCameraZoom() {
    const digitalZoom = this.cameraZoom / (this.hardwareZoom || 1);
    this.cameraVideo.style.setProperty('--creator-camera-zoom', String(Math.max(1, digitalZoom)));
  }

  #cameraFrameGeometry() {
    const sourceWidth = this.cameraVideo.videoWidth;
    const sourceHeight = this.cameraVideo.videoHeight;
    const frame = this.stage.getBoundingClientRect();
    if (!sourceWidth || !sourceHeight || !frame.width || !frame.height) return null;
    const frameAspect = frame.width / frame.height;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    if (sourceWidth / sourceHeight > frameAspect) cropWidth = sourceHeight * frameAspect;
    else cropHeight = sourceWidth / frameAspect;
    const softwareZoom = this.cameraZoom / (this.hardwareZoom || 1);
    cropWidth /= softwareZoom;
    cropHeight /= softwareZoom;
    return {
      x: (sourceWidth - cropWidth) / 2,
      y: (sourceHeight - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    };
  }

  #drawCameraFrame(context, canvas) {
    const crop = this.#cameraFrameGeometry();
    if (!crop) return false;
    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    const filters = ['', 'contrast(1.12) saturate(1.16)', 'sepia(.22) saturate(1.22)', 'grayscale(.45) contrast(1.08)'];
    context.filter = filters[this.cameraFilter];
    if (this.cameraFacing === 'user') {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(this.cameraVideo, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    context.restore();
    return true;
  }

  #createCaptureCanvas(maxDimension = 1920) {
    const crop = this.#cameraFrameGeometry();
    if (!crop) return null;
    const scale = Math.min(1, maxDimension / Math.max(crop.width, crop.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.width * scale));
    canvas.height = Math.max(1, Math.round(crop.height * scale));
    return canvas;
  }

  #clearCaptureCanvas() {
    if (this.captureFrame) cancelAnimationFrame(this.captureFrame);
    this.captureFrame = 0;
    this.captureCanvasStream?.getVideoTracks().forEach(track => track.stop());
    this.captureCanvasStream = null;
    this.captureCanvas = null;
  }

  #stopMicrophone() {
    this.microphoneStream?.getTracks().forEach(track => track.stop());
    this.microphoneStream = null;
  }

  #stopCamera() {
    this.cameraRequest++;
    this.cameraStarting = false;
    this.recordingRequest++;
    this.recordingStarting = false;
    clearTimeout(this.captureTimer);
    this.captureTimer = 0;
    if (this.captureRecorder && this.captureRecorder.state !== 'inactive') {
      this.captureRecorder.ondataavailable = null;
      this.captureRecorder.onstop = null;
      this.captureRecorder.stop();
    }
    this.captureRecorder = null;
    this.captureChunks = [];
    this.#clearCaptureCanvas();
    this.#stopMicrophone();
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.cameraStream = null;
    this.cameraVideo.srcObject = null;
    this.cameraBackdrop.hidden = false;
    this.shutter?.classList.remove('is-recording');
  }

  #leaveCameraView() {
    if (this.captureRecorder && this.captureRecorder.state !== 'inactive') {
      this.cameraRequest++;
      this.cameraStarting = false;
      return;
    }
    this.#stopCamera();
  }

  #setCaptureMode(mode, selectedButton) {
    this.captureMode = mode;
    this.stage.dataset.mode = mode;
    this.stage.classList.toggle('is-text-mode', mode === 'text');
    this.textStage.hidden = mode !== 'text';
    if (mode === 'text') this.textStage.append(this.captionWrap);
    else this.reviewPanel.insertBefore(this.captionWrap, this.audioBar);
    if (this.shutter) {
      this.shutter.setAttribute('aria-label', mode === 'video' ? t('recordVideo') : t('camera'));
      this.shutter.classList.toggle('video-mode', mode === 'video');
    }
    this.modeButtons.forEach(button => {
      const active = selectedButton
        ? button === selectedButton
        : button.dataset.mode === mode && (mode !== 'video' || Number(button.dataset.duration) === this.captureDuration);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  async #flipCamera() {
    this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
    this.cameraToolButtons.flashButton.classList.remove('is-active');
    this.#stopCamera();
    await this.#startCamera();
  }

  async #toggleFlash(button) {
    const track = this.cameraStream?.getVideoTracks()[0];
    if (!track?.getCapabilities?.().torch) {
      this.stageMessage.textContent = t('flashUnavailable');
      return;
    }
    const enabled = !button.classList.contains('is-active');
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled }] });
      button.classList.toggle('is-active', enabled);
      this.stageMessage.textContent = '';
    } catch (error) {
      this.stageMessage.textContent = String(error?.message || t('flashUnavailable')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('flashUnavailable');
    }
  }

  #cycleCameraFilter(button) {
    this.cameraFilter = (this.cameraFilter + 1) % 4;
    this.stage.dataset.filter = String(this.cameraFilter);
    button?.classList.toggle('is-active', this.cameraFilter > 0);
  }

  #toggleCaptureTimer(button) {
    const enabled = !button.classList.contains('is-active');
    button.classList.toggle('is-active', enabled);
    this.stage.dataset.timer = enabled ? '3' : '';
  }

  async #capture() {
    if (this.captureMode === 'text') {
      if (this.caption.value.trim()) this.#showReview();
      else this.caption.focus({ preventScroll: true });
      return;
    }
    if (!this.cameraStream) {
      await this.#startCamera();
      if (!this.cameraStream) return;
    }
    if (this.captureMode === 'video') {
      if (this.captureRecorder?.state === 'recording') {
        this.captureRecorder.stop();
        return;
      }
      this.#recordClip();
      return;
    }
    if (this.stage.dataset.timer === '3') {
      this.stageMessage.textContent = '3';
      await new Promise(resolve => { this.captureTimer = setTimeout(resolve, 3000); });
      this.captureTimer = 0;
    }
    const canvas = this.#createCaptureCanvas(2048);
    if (!canvas) { this.stageMessage.textContent = t('cameraAccessFailed'); return; }
    const context = canvas.getContext('2d');
    if (!context) { this.stageMessage.textContent = t('photoCropFailed'); return; }
    if (!this.#drawCameraFrame(context, canvas)) { this.stageMessage.textContent = t('photoCropFailed'); return; }
    const request = this.cameraRequest;
    try {
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      if (!this.sheet.isOpen || request !== this.cameraRequest) return;
      const photo = new File([blob], `milkyway-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      await this.#pickMedia([photo]);
      this.stageMessage.textContent = '';
    } catch (error) {
      if (this.sheet.isOpen && request === this.cameraRequest) {
        this.stageMessage.textContent = readableError(error, t('photoCropFailed'));
      }
    }
  }

  async #recordClip() {
    if (this.recordingStarting || this.captureRecorder?.state === 'recording') return;
    if (typeof MediaRecorder !== 'function') {
      this.stageMessage.textContent = t('recordingFailed');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.stageMessage.textContent = t('microphoneAccessFailed');
      return;
    }
    this.recordingStarting = true;
    const request = ++this.recordingRequest;
    try {
      const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (request !== this.recordingRequest || !this.sheet.isOpen) {
        microphoneStream.getTracks().forEach(track => track.stop());
        return;
      }
      this.microphoneStream = microphoneStream;
      const formats = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      const mimeType = formats.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
      let recordingStream = this.cameraStream;
      const canvas = this.#createCaptureCanvas(1280);
      if (canvas?.captureStream) {
        const context = canvas.getContext('2d');
        if (context) {
          this.#clearCaptureCanvas();
          this.captureCanvas = canvas;
          this.captureCanvasStream = canvas.captureStream(30);
          microphoneStream.getAudioTracks().forEach(track => this.captureCanvasStream.addTrack(track));
          recordingStream = this.captureCanvasStream;
          const draw = () => {
            if (!this.captureCanvas || this.captureRecorder?.state !== 'recording') return;
            this.#drawCameraFrame(context, canvas);
            this.captureFrame = requestAnimationFrame(draw);
          };
          this.captureFrame = requestAnimationFrame(draw);
        }
      }
      if (recordingStream === this.cameraStream) {
        recordingStream = new MediaStream([
          ...this.cameraStream.getVideoTracks(),
          ...microphoneStream.getAudioTracks(),
        ]);
      }
      const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
      this.captureRecorder = recorder;
      this.captureChunks = [];
      recorder.ondataavailable = event => { if (event.data?.size) this.captureChunks.push(event.data); };
      recorder.onerror = event => {
        this.stageMessage.textContent = String(event.error?.message || t('recordingFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('recordingFailed');
        this.#clearCaptureCanvas();
        clearTimeout(this.captureTimer);
        this.captureTimer = 0;
        this.shutter.classList.remove('is-recording');
        this.captureRecorder = null;
        this.recordingStarting = false;
        this.#stopMicrophone();
      };
      recorder.onstop = () => {
        this.shutter.classList.remove('is-recording');
        this.captureRecorder = null;
        this.recordingStarting = false;
        this.#clearCaptureCanvas();
        this.#stopMicrophone();
        clearTimeout(this.captureTimer);
        this.captureTimer = 0;
        const blob = new Blob(this.captureChunks, { type: recorder.mimeType || 'video/webm' });
        this.captureChunks = [];
        if (!blob.size) { this.stageMessage.textContent = t('recordingFailed'); return; }
        void this.#pickMedia([new File([blob], `milkyway-capture-${Date.now()}.webm`, { type: blob.type })]);
        this.stageMessage.textContent = '';
      };
      recorder.start(250);
      this.recordingStarting = false;
      this.shutter.classList.add('is-recording');
      this.stageMessage.textContent = t('recording');
      this.captureTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, this.captureDuration);
    } catch (error) {
      if (request !== this.recordingRequest || !this.sheet.isOpen) return;
      this.#clearCaptureCanvas();
      this.recordingStarting = false;
      this.#stopMicrophone();
      this.stageMessage.textContent = error?.name === 'NotAllowedError' || error?.name === 'NotFoundError'
        ? t('microphoneAccessFailed')
        : String(error?.message || t('recordingFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('recordingFailed');
    }
  }

  #paintSchedule() {
    const enabled = this.scheduleToggle.checked;
    this.scheduleDateWrap.classList.toggle('is-expanded', enabled);
    this.scheduleDateWrap.setAttribute('aria-hidden', String(!enabled));
    this.scheduleDate.disabled = !enabled;
    this.submit.textContent = this.scheduleToggle.checked ? t('studioSchedulePost') : t('publish');
  }

  #openPicker(input) {
    try { openFilePicker(input); }
    catch (error) {
      if (input === this.mediaInput) this.autoStyleNextSelection = false;
      this.#showMediaError(readableError(error, t('mediaPickerUnavailable')));
    }
  }

  #showMediaError(message) {
    this.photoEditor.hidden = true;
    this.reviewPanel.hidden = true;
    this.form.dataset.view = 'camera';
    this.stageMessage.textContent = message;
  }

  #releaseMedia(invalidate = true) {
    if (invalidate) {
      this.mediaSelection++;
      this.mediaPending = false;
    }
    for (const entry of this.files) URL.revokeObjectURL(entry.url);
    this.files = [];
    this.preview.replaceChildren();
    this.stage?.classList.remove('has-media');
  }

  async #pickMedia(files) {
    const selection = ++this.mediaSelection;
    const applyAutoStyle = this.autoStyleNextSelection;
    this.autoStyleNextSelection = false;
    this.#releaseMedia(false);
    this.photoEditor.hidden = true;
    this.reviewPanel.hidden = true;
    this.form.dataset.view = 'camera';
    this.stageMessage.textContent = '';
    this.mediaPending = false;
    if (!this.publishing && !this.audioPending) this.submit.disabled = false;
    this.mediaInput.value = '';
    this.preview.replaceChildren();
    if (!files.length) {
      this.wait.stop('media');
      if (!this.audioFile) this.#backToCamera();
      return;
    }
    this.message.textContent = t('loading');
    this.mediaPending = true;
    this.submit.disabled = true;
    const waitKey = 'media';
    this.wait.start(waitKey, t('preparingMedia'), {
      onCancel: () => {
        if (selection !== this.mediaSelection) return;
        this.mediaSelection++;
        this.mediaPending = false;
        this.submit.disabled = this.audioPending || this.publishing;
        this.#backToCamera();
        this.message.textContent = '';
      },
    });
    let ready = false;
    try {
      const entries = await Promise.all(files.map(async file => ({
        file,
        ...(await withTimeout(identifyMediaFile(file), MEDIA_PREPARATION_TIMEOUT, t('mediaPreparationTimeout'))),
      })));
      if (selection !== this.mediaSelection) return;
      const videos = entries.filter(entry => entry.kind === 'video');
      if (entries.some(entry => entry.kind === 'unknown' || entry.kind === 'audio')) throw new Error(t('mediaType'));
      if (videos.length && (files.length > 1 || videos.length > 1)) throw new Error(t('oneVideoOnly'));
      if (files.length > MAX_PHOTOS) throw new Error(t('slideshowPhotoLimit'));
      const video = videos.length === 1;
      for (const entry of entries) {
        if ((!video && entry.kind !== 'image') || (video && entry !== videos[0])) throw new Error(t('mediaType'));
        if (entry.file.size > (video ? MAX_VIDEO : MAX_IMAGE)) throw new Error(video ? t('videoTooBig') : t('imageTooBig'));
      }
      this.files = entries.map(entry => ({ ...entry, url: URL.createObjectURL(entry.file) }));
      this.message.textContent = '';
      this.stage.classList.add('has-media');
      this.#renderPreview();
      if (!video) {
        const images = [...this.preview.querySelectorAll('img')];
        await Promise.all(images.map(image => withTimeout(image.decode(), MEDIA_PREPARATION_TIMEOUT, t('mediaPreparationTimeout'))
          .catch(error => { console.warn('[compose] selected photo preview could not be decoded yet', error); })));
      }
      if (selection !== this.mediaSelection) return;
      ready = true;
    } catch (error) {
      if (selection === this.mediaSelection) {
        this.#releaseMedia(false);
        this.#showMediaError(readableError(error, t('mediaType')));
      }
    } finally {
      if (selection === this.mediaSelection) {
        this.mediaPending = false;
        this.wait.stop(waitKey);
        if (!this.publishing && !this.audioPending) this.submit.disabled = false;
      }
    }
    if (!ready || selection !== this.mediaSelection) return;
    this.#showCurrentMediaStep();
    if (applyAutoStyle) {
      if (this.files.length > 1) await this.#autoStyle();
      else this.message.textContent = t('pickSlideshowFirst');
    }
  }

  #removePhoto(index) {
    const [removed] = this.files.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    if (!this.files.length) {
      this.#releaseMedia();
      this.photoEditor.hidden = true;
      this.#backToCamera();
      if (this.form.dataset.mode !== 'create') void this.#startCamera();
      return;
    }
    this.editorIndex = Math.min(index, this.files.length - 1);
    this.#renderPreview();
    this.#showPhotoEditor();
  }

  #readSoundList(name) {
    try {
      const value = JSON.parse(localStorage.getItem(`${name}:${auth.userId || 'guest'}`) || '[]');
      return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 100) : [];
    } catch (error) {
      console.warn('[compose] Could not read saved sound selections', error);
      return [];
    }
  }

  #saveSoundList(name, values) {
    try {
      localStorage.setItem(`${name}:${auth.userId || 'guest'}`, JSON.stringify(values.slice(0, 100)));
      return true;
    } catch (error) {
      console.warn('[compose] Could not save sound selections', error);
      toast(t('studioSoundSaveFailed'));
      return false;
    }
  }

  #openSoundPicker() {
    if (!this.soundSheet) {
      this.soundStatus = h('p', { class: 'sound-picker-status', role: 'status', 'aria-live': 'polite' });
      this.soundList = h('div', { class: 'sound-picker-list' });
      this.soundSearch = h('input', {
        class: 'field sound-picker-search', type: 'search', placeholder: t('studioSoundSearch'),
        'aria-label': t('studioSoundSearch'), oninput: () => {
          this.soundQuery = this.soundSearch.value.trim().toLocaleLowerCase();
          this.#renderSoundTracks();
        },
      });
      const tabs = [
        ['hot', t('studioSoundHot')],
        ['forYou', t('studioSoundForYou')],
        ['favourites', t('studioSoundFavourites')],
        ['recent', t('studioSoundRecent')],
      ];
      this.soundTabs = h('div', { class: 'sound-picker-tabs', role: 'tablist', 'aria-label': t('studioAddSound') },
        ...tabs.map(([key, label]) => h('button', {
          class: `sound-picker-tab${key === this.soundCategory ? ' is-selected' : ''}`,
          type: 'button', role: 'tab', 'aria-selected': String(key === this.soundCategory),
          onclick: () => {
            this.soundCategory = key;
            this.#renderSoundTabs();
            this.#renderSoundTracks();
          },
        }, label)));
      const search = h('label', { class: 'sound-picker-search-wrap' },
        h('span', { html: icon.search, 'aria-hidden': 'true' }), this.soundSearch);
      this.soundSheet = new Sheet({
        title: t('studioAddSound'), className: 'sound-picker-sheet', autoFocus: false,
        onClose: () => {
          this.soundPreview?.pause();
          this.activeSoundPreviewButton?.classList.remove('is-playing');
        },
      });
      this.soundWait = new WaitIndicator(this.soundSheet.panel);
      this.soundSheet.body.replaceChildren(search, this.soundTabs, this.soundStatus, this.soundList);
    }
    this.soundSheet.open();
    void this.#loadSoundTracks();
  }

  #renderSoundTabs() {
    this.soundTabs.querySelectorAll('.sound-picker-tab').forEach((button, index) => {
      const selected = ['hot', 'forYou', 'favourites', 'recent'][index] === this.soundCategory;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-selected', String(selected));
    });
  }

  async #loadSoundTracks() {
    const request = (this.soundLoadRequest || 0) + 1;
    this.soundLoadRequest = request;
    const waitKey = `sounds-${request}`;
    this.soundWait.stop(this.soundWaitKey);
    this.soundWaitKey = waitKey;
    this.soundStatus.textContent = t('loading');
    this.soundList.replaceChildren();
    this.soundWait.start(waitKey, t('loadingSounds'), {
      onCancel: () => {
        this.soundLoadRequest++;
        this.soundSheet.close();
      },
    });
    try {
      const source = feed('foryou');
      await source.load();
      if (request !== this.soundLoadRequest) return;
      const posts = source.source.value?.posts || [];
      const usesByUrl = new Map();
      for (const post of posts) {
        const candidate = post.media?.audioUrl || post.audioUrl || post.audio_url || '';
        const url = typeof candidate === 'string' && /^https:\/\//i.test(candidate) ? candidate : '';
        if (url) usesByUrl.set(url, (usesByUrl.get(url) || 0) + 1);
      }
      this.soundTracks = posts.reduce((tracks, post) => {
        const candidate = post.media?.audioUrl || post.audioUrl || post.audio_url || '';
        const url = typeof candidate === 'string' && /^https:\/\//i.test(candidate) ? candidate : '';
        if (!url || tracks.some(track => track.url === url)) return tracks;
        try {
          const parsed = new URL(url, location.href);
          if (parsed.protocol !== 'https:' && parsed.origin !== location.origin) return tracks;
        } catch { return tracks; }
        tracks.push({
          id: String(post.id || url), url, post,
          postCount: usesByUrl.get(url) || 1,
          duration: Number(post.audioDuration || post.duration) || 0,
          durationProbe: null,
        });
        return tracks;
      }, []).slice(0, MAX_SOUND_TRACKS);
      this.soundStatus.textContent = '';
      this.#renderSoundTracks();
    } catch (error) {
      if (request !== this.soundLoadRequest) return;
      console.error('[compose] Sound picker could not load tracks', error);
      this.soundStatus.textContent = t('exploreLoadFailed');
    } finally {
      if (request === this.soundLoadRequest) {
        this.soundWait.stop(waitKey);
        this.soundWaitKey = '';
      }
    }
  }

  #renderSoundTracks() {
    if (!this.soundList) return;
    const query = this.soundQuery;
    const favourites = new Set(this.soundFavourites);
    const recent = new Map(this.soundRecent.map((url, index) => [url, index]));
    let tracks = this.soundTracks.filter(track => {
      const title = soundText(track.post.caption, t('exploreOriginalSound'));
      const creator = soundText(track.post.author?.name, 'MilkyWay');
      return `${title} ${creator}`.toLocaleLowerCase().includes(query);
    });
    if (this.soundCategory === 'favourites') tracks = tracks.filter(track => favourites.has(track.url));
    else if (this.soundCategory === 'recent') tracks = tracks.filter(track => recent.has(track.url))
      .sort((a, b) => recent.get(a.url) - recent.get(b.url));
    else if (this.soundCategory === 'hot') tracks.sort((a, b) => b.postCount - a.postCount || (Number(b.post.likes) || 0) - (Number(a.post.likes) || 0));
    this.soundList.replaceChildren();
    if (!tracks.length) {
      this.soundStatus.textContent = this.soundTracks.length ? t('studioSoundNoResults') : t('exploreNoSounds');
      return;
    }
    this.soundStatus.textContent = '';
    for (const track of tracks) {
      const title = soundText(track.post.caption, t('exploreOriginalSound')).split(/\r?\n/).map(line => line.trim()).find(Boolean) || t('exploreOriginalSound');
      const creator = soundText(track.post.author?.name, 'MilkyWay');
      const isFavourite = favourites.has(track.url);
      const duration = h('span', { class: 'sound-track-duration' }, formatSoundDuration(track.duration));
      const coverUrl = track.post.media?.type === 'image' ? track.post.media.url : '';
      const cover = coverUrl
        ? h('img', { class: 'sound-track-cover', src: coverUrl, alt: '', loading: 'lazy' })
        : h('span', { class: 'sound-track-cover sound-track-cover-placeholder', 'aria-hidden': 'true' }, '♫');
      const select = h('button', {
        class: 'sound-track-select', type: 'button', 'aria-label': `${t('studioSoundUse')} ${title}`,
        onclick: () => {
          this.soundRecent = [track.url, ...this.soundRecent.filter(url => url !== track.url)].slice(0, 100);
          this.#saveSoundList('mw_sound_recent', this.soundRecent);
          this.#pickAudioTrack(track);
          this.soundSheet.close();
        },
      }, cover, h('span', { class: 'sound-track-copy' },
        h('b', {}, title),
        h('small', {}, creator),
        h('small', { class: 'sound-track-meta' }, `${count(track.postCount)} ${t('posts')}`, ' · ', duration)));
      const preview = h('button', {
        class: 'sound-track-icon', type: 'button', 'aria-label': t('studioSoundPreview'),
        onclick: async () => {
          if (this.soundPreview?.src === new URL(track.url, location.href).href && !this.soundPreview.paused) {
            this.soundPreview.pause();
            preview.classList.remove('is-playing');
            return;
          }
          this.soundPreview?.pause();
          this.activeSoundPreviewButton?.classList.remove('is-playing');
          const player = new Audio(track.url);
          this.soundPreview = player;
          this.activeSoundPreviewButton = preview;
          player.preload = 'metadata';
          player.addEventListener('loadedmetadata', () => {
            track.duration = player.duration;
            duration.textContent = formatSoundDuration(track.duration);
          }, { once: true });
          player.addEventListener('ended', () => preview.classList.remove('is-playing'), { once: true });
          try {
            await player.play();
            preview.classList.add('is-playing');
          }
          catch (error) {
            console.warn('[compose] Sound preview could not play', error);
            toast(t('studioSoundPreviewFailed'));
          }
        },
      }, h('span', { class: 'sound-preview-play', html: icon.play, 'aria-hidden': 'true' }),
      h('span', { class: 'sound-equalizer', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')));
      const trim = h('button', {
        class: 'sound-track-icon', type: 'button', 'aria-label': t('studioSoundTrim'),
        onclick: () => this.#openSoundTrim(track),
      }, '✂');
      const favourite = h('button', {
        class: `sound-track-icon sound-track-save${isFavourite ? ' is-saved' : ''}`,
        type: 'button', 'aria-pressed': String(isFavourite),
        'aria-label': isFavourite ? t('studioSoundRemoveFavourite') : t('studioSoundSaveFavourite'),
        onclick: () => {
          this.soundFavourites = isFavourite
            ? this.soundFavourites.filter(url => url !== track.url)
            : [track.url, ...this.soundFavourites.filter(url => url !== track.url)];
          if (this.#saveSoundList('mw_sound_favourites', this.soundFavourites)) this.#renderSoundTracks();
        },
      }, isFavourite ? '★' : '☆');
      const row = h('article', { class: 'sound-track-row' }, select, preview, trim, favourite);
      if (!track.duration && !track.durationProbe) {
        track.durationProbe = new Audio();
        track.durationProbe.preload = 'metadata';
        track.durationProbe.addEventListener('loadedmetadata', () => {
          track.duration = track.durationProbe.duration;
          duration.textContent = formatSoundDuration(track.duration);
        }, { once: true });
        track.durationProbe.src = track.url;
        track.durationProbe.load();
      }
      this.soundList.append(row);
    }
  }

  #pickAudioTrack(track) {
    this.wait.stop('audio');
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioSelection++;
    this.audioPending = false;
    this.audioFile = null;
    this.audioUrl = null;
    this.audioTrack = track;
    this.audioInput.value = '';
    if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
    this.audioPreview.replaceChildren(
      h('audio', { src: track.url, controls: true, preload: 'metadata' }),
      h('button', { class: 'link', type: 'button', onclick: () => this.#pickAudio(null) }, t('remove')));
    this.audioBar.hidden = false;
    this.message.textContent = '';
    this.#showCurrentMediaStep();
  }

  #openSoundTrim(track) {
    this.trimSheet ||= new Sheet({
      title: t('studioSoundTrim'), className: 'sound-trim-sheet', autoFocus: false,
      onClose: () => {
        this.trimRequest = (this.trimRequest || 0) + 1;
        this.trimWait?.clear();
        this.trimAudio?.pause();
      },
    });
    this.trimWait ||= new WaitIndicator(this.trimSheet.panel);
    const audio = h('audio', { class: 'sound-trim-audio', src: track.url, controls: true, preload: 'metadata' });
    this.trimAudio = audio;
    const start = h('input', { class: 'field', type: 'range', min: '0', max: '0', step: '0.1', value: '0', disabled: true });
    const end = h('input', { class: 'field', type: 'range', min: '0.5', max: '0.5', step: '0.1', value: '0.5', disabled: true });
    const rangeText = h('p', { class: 'sound-trim-range' }, t('loading'));
    const message = h('p', { class: 'sound-trim-message', role: 'status', 'aria-live': 'polite' });
    const apply = h('button', { class: 'pill-btn hot wide', type: 'button', disabled: true, onclick: async () => {
      apply.disabled = true;
      message.textContent = t('loading');
      const request = (this.trimRequest || 0) + 1;
      this.trimRequest = request;
      this.trimWait.start('trim', t('processingMedia'), {
        onCancel: () => {
          this.trimRequest++;
          this.trimSheet.close();
        },
      });
      try {
        const file = await trimSoundFile(track.url, Number(start.value), Number(end.value));
        if (request !== this.trimRequest) return;
        if (file.size > MAX_AUDIO) throw new Error(t('audioTooBig'));
        this.#pickAudio(file);
        this.soundPreview?.pause();
        this.trimSheet.close();
        this.soundSheet.close();
      } catch (error) {
        if (request !== this.trimRequest) return;
        console.error('[compose] Sound clip could not be trimmed', error);
        message.textContent = readableError(error, t('studioSoundTrimFailed'));
        apply.disabled = false;
      } finally {
        if (request === this.trimRequest) this.trimWait.stop('trim');
      }
    } }, t('studioSoundUseClip'));
    const updateRange = () => {
      const from = Number(start.value);
      const to = Number(end.value);
      if (to <= from + 0.5) end.value = String(Math.min(Number(end.max), from + 0.5));
      rangeText.textContent = `${formatSoundDuration(Number(start.value))} – ${formatSoundDuration(Number(end.value))}`;
      if (audio.readyState >= 1) audio.currentTime = Number(start.value);
    };
    start.addEventListener('input', updateRange);
    end.addEventListener('input', updateRange);
    audio.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (duration < 0.5) {
        message.textContent = t('studioSoundTrimFailed');
        return;
      }
      start.max = String(Math.max(0, duration - 0.5));
      end.max = String(duration);
      end.value = String(Math.min(duration, 30));
      start.disabled = false;
      end.disabled = false;
      apply.disabled = false;
      updateRange();
    }, { once: true });
    this.trimSheet.body.replaceChildren(
      audio,
      h('label', { class: 'sound-trim-control' }, h('span', {}, t('studioSoundStart')), start),
      h('label', { class: 'sound-trim-control' }, h('span', {}, t('studioSoundEnd')), end),
      rangeText, message, apply);
    this.trimSheet.open();
  }

  async #pickAudio(file) {
    const selection = ++this.audioSelection;
    this.audioPending = false;
    this.audioTrack = null;
    if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioFile = null;
    this.audioUrl = null;
    this.audioInput.value = '';
    this.audioPreview.replaceChildren();
    this.audioBar.hidden = !file;
    if (!file) {
      this.wait.stop('audio');
      return;
    }
    this.#showCurrentMediaStep();
    this.audioPending = true;
    this.submit.disabled = true;
    this.wait.start('audio', t('preparingMedia'), {
      onCancel: () => {
        if (selection !== this.audioSelection) return;
        this.audioSelection++;
        this.audioPending = false;
        this.submit.disabled = this.mediaPending || this.publishing;
        this.#pickAudio(null);
      },
    });
    let info;
    try { info = await identifyMediaFile(file); }
    catch (error) {
      if (selection === this.audioSelection) this.message.textContent = readableError(error, t('audioFileOnly'));
      return;
    } finally {
      if (selection === this.audioSelection) {
        this.audioPending = false;
        if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
        this.wait.stop('audio');
      }
    }
    if (selection !== this.audioSelection) return;
    if (info.kind !== 'audio') { this.message.textContent = t('audioFileOnly'); return; }
    if (file.size > MAX_AUDIO) { this.message.textContent = t('audioTooBig'); return; }
    this.audioFile = file;
    try { this.audioUrl = URL.createObjectURL(file); }
    catch (error) {
      this.audioFile = null;
      this.message.textContent = readableError(error, t('mediaPickerUnavailable'));
      return;
    }
    this.audioPreview.append(h('audio', { src: this.audioUrl, controls: true, preload: 'metadata' }),
      h('button', { class: 'link', type: 'button', onclick: () => this.#pickAudio(null) }, t('remove')));
    this.message.textContent = '';
    this.#showCurrentMediaStep();
  }

  async #autoStyle() {
    if (this.files.length < 2 || this.files.some(entry => entry.kind !== 'image')) {
      this.message.textContent = t('pickSlideshowFirst');
      return;
    }
    let portraitCount = 0;
    try {
      for (const { file } of this.files) {
        const bitmap = await createImageBitmap(file);
        if (bitmap.height > bitmap.width * 1.15) portraitCount++;
        bitmap.close();
      }
    } catch (error) {
      console.warn('[compose] slideshow style analysis unavailable', error);
    }
    this.style.value = this.files.length >= 5 || portraitCount >= Math.ceil(this.files.length / 2) ? 'slide' : 'page';
    this.message.textContent = t('autoStyleApplied');
  }

  async #upload(sb, file, storagePath = '') {
    const fileName = String(file?.name || 'media');
    const name = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100) || 'media';
    try {
      const info = await identifyMediaFile(file);
      if (info.kind === 'unknown' || !info.type) throw new Error(t('mediaType'));
      const path = storagePath || `milkyway/${auth.userId}/${Date.now()}-${crypto.randomUUID()}-${name}`;
      const uploaded = await sb.storage.from('portfolio').upload(path, file, {
        contentType: info.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploaded.error) throw uploaded.error;
      const publicUrl = sb.storage.from('portfolio').getPublicUrl(path)?.data?.publicUrl;
      if (!publicUrl) throw new Error('Supabase Storage did not return a public URL.');
      return { url: publicUrl, path };
    } catch (error) {
      throw Object.assign(new Error(error?.message || String(error)), {
        cause: error,
        code: error?.code,
        statusCode: error?.statusCode,
        publishPhase: `uploading ${name}`,
      });
    }
  }

  async #publish() {
    if (this.publishing) return;
    if (this.mediaPending || this.audioPending) { this.message.textContent = t('loading'); return; }
    const caption = this.caption.value.trim();
    if (!caption && !this.files.length) { this.message.textContent = t('writeOrPick'); return; }
    if (!auth.signedIn()) { this.message.textContent = t('signInToContinue'); return; }
    let scheduledAt = null;
    if (this.scheduleToggle.checked) {
      const scheduledTime = Date.parse(this.scheduleDate.value);
      const earliest = Date.now() + 5 * 60 * 1000;
      const latest = Date.now() + 365 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(scheduledTime) || scheduledTime < earliest || scheduledTime > latest) {
        this.message.textContent = t('studioScheduleInvalid');
        return;
      }
      scheduledAt = new Date(scheduledTime).toISOString();
    }
    this.publishing = true;
    this.submit.disabled = true;
    this.submit.textContent = t('uploading');
    this.submit.setAttribute('aria-busy', 'true');
    this.message.textContent = t('uploading');
    this.wait.start('publish', t('processingMedia'));
    let phase = 'connecting to Supabase';
    try {
      const sb = await supabase();
      const video = this.files[0]?.kind === 'video';
      phase = 'uploading post media';
      this.wait.update('publish', t('processingMedia'));
      const mediaItems = [];
      const mediaPreviewItems = [];
      let media_url = null;
      if (video) {
        const selectedVideo = this.files[0].file;
        this.message.textContent = t('optimizingMedia');
        await yieldToBrowser();
        const videoFile = await optimizeVideo(selectedVideo, { onProgress: progress => {
          this.message.textContent = `${t('optimizingMedia')} ${progress}%`;
          this.wait.update('publish', `${t('processingMedia')} ${progress}%`);
        } });
        this.message.textContent = t('uploading');
        this.wait.update('publish', t('uploading'));
        const [uploaded, posterFile] = await Promise.all([
          this.#upload(sb, videoFile),
          createVideoPreview(videoFile),
        ]);
        media_url = uploaded.url;
        if (posterFile) {
          try { await this.#upload(sb, posterFile, `${uploaded.path}.poster.jpg`); }
          catch (error) { console.warn('[compose] video poster upload failed; the video will still publish', error); }
        }
      } else {
        const uploadedPhotos = await mapConcurrent(this.files, 2, async ({ file }, index) => {
          this.message.textContent = `${t('optimizingMedia')} ${index + 1}/${this.files.length}`;
          this.wait.update('publish', `${t('processingMedia')} ${index + 1}/${this.files.length}`);
          await yieldToBrowser();
          const optimized = await optimizeImage(file);
          const [uploaded, preview] = await Promise.all([
            this.#upload(sb, optimized.full),
            optimized.preview ? this.#upload(sb, optimized.preview).catch(error => {
              console.warn('[compose] photo preview upload failed; using the compressed photo in the feed', error);
              return null;
            }) : Promise.resolve(null),
          ]);
          return { uploaded, preview };
        });
        for (const { uploaded, preview } of uploadedPhotos) {
          mediaItems.push(uploaded.url);
          mediaPreviewItems.push(preview?.url || uploaded.url);
          media_url ||= uploaded.url;
        }
      }
      phase = 'uploading background audio';
      this.wait.update('publish', t('uploading'));
      const audioUpload = this.audioFile ? await this.#upload(sb, this.audioFile) : null;
      const audio_url = audioUpload?.url || this.audioTrack?.url || null;
      const media_type = video ? 'video' : media_url ? 'image' : null;
      const author_name = profiles.peek(auth.userId)?.name || auth.name;
      phase = 'saving post details';
      this.wait.update('publish', t('uploading'));
      const { data: savedPost, error } = await sb.from('mw_posts').insert({
        author_id: auth.userId, author_name, caption: caption || null, media_url, media_type,
        media_items: mediaItems, media_preview_items: mediaPreviewItems, audio_url, slideshow_style: this.style.value,
        scheduled_at: scheduledAt,
      }).select('id,author_id,created_at').single();
      if (error) throw error;
      if (!savedPost?.id || savedPost.author_id !== auth.userId) {
        throw new Error('Supabase did not return the saved post.');
      }
      this.caption.value = '';
      this.captionCount.textContent = `0 / ${this.caption.maxLength}`;
      this.#releaseMedia(); this.#pickAudio(null);
      this.preview.replaceChildren(); this.message.textContent = '';
      this.sheet.close();
      toast(scheduledAt ? t('studioScheduledSuccess') : t('published'));
      this.scheduleToggle.checked = false;
      this.scheduleDate.value = '';
      this.#paintSchedule();
      for (const scope of ['foryou', 'following']) feed(scope).refresh().catch(() => {});
      this.onPublished?.();
    } catch (error) {
      const failedPhase = error?.publishPhase || phase;
      console.error('[compose] post publication failed', { phase: failedPhase, error });
      this.message.textContent = publishError(error, failedPhase);
    } finally {
      this.publishing = false;
      this.submit.removeAttribute('aria-busy');
      this.submit.textContent = this.scheduleToggle.checked ? t('studioSchedulePost') : t('publish');
      this.wait.stop('publish');
      this.submit.disabled = false;
    }
  }
}
