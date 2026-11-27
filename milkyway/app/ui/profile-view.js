// Profile ("Nova" tab for the signed-in user, or any author tapped in the feed / Lives).
// Header, counts and posts come from Supabase as the caller, so row-level security decides what is visible.
import { t } from '../core/i18n.js';
import { api, auth, supabase } from '../core/net.js';
import { config } from '../config.js';
import { identifyMediaFile, openFilePicker } from '../core/media-files.js';
import { optimizeImage } from '../core/media-optimizer.js';
import { profiles } from '../data/profiles.js';
import { loadPublicPosts, portfolioMediaUrl } from '../data/public-posts.js';
import { actions, feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, icon, avatar, count, toast } from './dom.js';
import { PostViewer, postKind } from './post-viewer.js';
import { presence } from '../data/presence.js';
import { isOwnerAccount } from './admin-view.js';
import { openShare } from './share-sheet.js';
import { USERNAME_COOLDOWN_MS, usernameAvailable, usernameValidationMessage } from '../data/usernames.js';

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));
const profileText = value => {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (/^(?:null|undefined)$/i.test(cleaned)) return '';
  return cleaned.replace(/\b(?:null|undefined)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
};
const coverCacheKey = id => `mw_profile_cover_${String(id || '')}`;

function cachedCover(id) {
  try { return localStorage.getItem(coverCacheKey(id)) || ''; }
  catch (error) {
    console.warn('[profile] cached cover photo is unavailable.', error);
    return '';
  }
}

function cacheCover(id, url) {
  try {
    if (url) localStorage.setItem(coverCacheKey(id), url);
    else localStorage.removeItem(coverCacheKey(id));
  } catch (error) {
    console.warn('[profile] cover photo could not be cached on this device.', error);
  }
}

const PROFILE_POST_REQUIRED = ['id', 'caption', 'media_url', 'media_type', 'created_at'];
const PROFILE_POST_OPTIONAL = ['author_id', 'user_id', 'username', 'author_username', 'scheduled_at', 'slideshow_style', 'audio_url', 'media_items', 'media_preview_items', 'storage_path'];
const PROFILE_POST_PAGE_SIZE = 500;
const isPublicProfilePost = post => post?.public_post === true;
const isPostsTabPost = post => isPublicProfilePost(post) || !post?.audience || post.audience === 'everyone';
const isPrivateProfilePost = post => !isPublicProfilePost(post) && Boolean(post?.audience) && post.audience !== 'everyone';
const PROFILE_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const PROFILE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_PHOTO_MAX_PIXELS = 40_000_000;

async function validateProfilePhoto(file) {
  const info = await identifyMediaFile(file);
  if (info.kind !== 'image' || !PROFILE_PHOTO_TYPES.has(info.type)) throw new Error(t('photoUnsupported'));
  if (file.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
  const url = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise((resolve, reject) => {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(file).then(bitmap => {
          resolve([bitmap.width, bitmap.height]);
          bitmap.close?.();
        }).catch(() => {
          const image = new Image();
          image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
          image.onerror = () => reject(new Error(t('photoUnsupported')));
          image.src = url;
        });
      } else {
        const image = new Image();
        image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
        image.onerror = () => reject(new Error(t('photoUnsupported')));
        image.src = url;
      }
    });
    if (!dimensions[0] || !dimensions[1]) throw new Error(t('photoUnsupported'));
    if (dimensions[0] * dimensions[1] > PROFILE_PHOTO_MAX_PIXELS) throw new Error(t('photoTooLarge'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

class ProfileCropSheet {
  constructor() {
    this.sheet = new Sheet({ title: t('cropProfileImage'), className: 'profile-crop-sheet', autoFocus: false, onClose: () => this.#finish(null) });
    this.mode = 'avatar';
    this.imageUrl = '';
    this.resolve = null;
    this.pointers = new Map();
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.frame = h('div', { class: 'profile-crop-frame', 'data-no-swipe': true });
    this.image = h('img', { class: 'profile-crop-image', alt: '', draggable: 'false' });
    this.frame.append(this.image);
    this.message = h('p', { class: 'muted profile-crop-hint' }, t('cropProfileHint'));
    this.zoomOut = h('button', { class: 'profile-crop-control', type: 'button', 'aria-label': t('zoomOut'), title: t('zoomOut'), onclick: () => this.#setZoom(this.zoom - 0.15) }, '−');
    this.zoomSlider = h('input', {
      class: 'profile-crop-slider', type: 'range', min: '1', max: '4', step: '0.01', value: '1',
      'aria-label': t('zoomProfileImage'), oninput: () => this.#setZoom(Number(this.zoomSlider.value)),
    });
    this.zoomIn = h('button', { class: 'profile-crop-control', type: 'button', 'aria-label': t('zoomIn'), title: t('zoomIn'), onclick: () => this.#setZoom(this.zoom + 0.15) }, '+');
    this.resetButton = h('button', { class: 'profile-crop-reset', type: 'button', onclick: () => this.#reset() }, t('resetCrop'));
    this.cancelButton = h('button', { class: 'pill-btn profile-crop-cancel', type: 'button', onclick: () => this.sheet.close() }, t('cancel'));
    this.applyButton = h('button', { class: 'pill-btn hot profile-crop-apply', type: 'button', onclick: () => { void this.#crop(); } }, t('applyCrop'));
    this.actions = h('div', { class: 'profile-crop-actions' }, this.cancelButton, this.applyButton);
    this.sheet.body.replaceChildren(
      this.frame,
      this.message,
      h('div', { class: 'profile-crop-zoom' }, this.zoomOut, this.zoomSlider, this.zoomIn, this.resetButton),
      this.actions);
    this.frame.addEventListener('pointerdown', event => this.#pointerDown(event));
    this.frame.addEventListener('pointermove', event => this.#pointerMove(event));
    this.frame.addEventListener('pointerup', event => this.#pointerEnd(event));
    this.frame.addEventListener('pointercancel', event => this.#pointerEnd(event));
    this.frame.addEventListener('lostpointercapture', event => this.#pointerEnd(event));
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.#paint()) : null;
    this.resizeObserver?.observe(this.frame);
  }

  async open(file, mode) {
    this.mode = mode;
    this.sheet.title = t(mode === 'cover' ? 'cropCoverPhoto' : 'cropProfileImage');
    this.frame.dataset.mode = mode;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.zoomSlider.value = '1';
    this.message.textContent = t('cropProfileHint');
    this.applyButton.disabled = false;
    this.imageUrl = URL.createObjectURL(file);
    this.image.src = this.imageUrl;
    const finished = new Promise(resolve => { this.resolve = resolve; });
    this.sheet.open();
    try {
      await new Promise((resolve, reject) => {
        if (this.image.complete && this.image.naturalWidth) resolve();
        else {
          this.image.addEventListener('load', resolve, { once: true });
          this.image.addEventListener('error', () => reject(new Error(t('photoUnsupported'))), { once: true });
        }
      });
    } catch (error) {
      this.sheet.close();
      throw error;
    }
    this.#paint();
    return finished;
  }

  #frameSize() {
    const rect = this.frame.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  #scale() {
    const { width, height } = this.#frameSize();
    if (!width || !height || !this.image.naturalWidth || !this.image.naturalHeight) return 1;
    return Math.max(width / this.image.naturalWidth, height / this.image.naturalHeight) * this.zoom;
  }

  #paint() {
    const { width, height } = this.#frameSize();
    if (!width || !height || !this.image.naturalWidth || !this.image.naturalHeight) return;
    const baseScale = Math.max(width / this.image.naturalWidth, height / this.image.naturalHeight);
    const imageWidth = this.image.naturalWidth * baseScale;
    const imageHeight = this.image.naturalHeight * baseScale;
    const maxX = Math.max(0, (imageWidth * this.zoom - width) / 2);
    const maxY = Math.max(0, (imageHeight * this.zoom - height) / 2);
    this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
    this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
    this.image.style.width = `${imageWidth}px`;
    this.image.style.height = `${imageHeight}px`;
    this.image.style.setProperty('--crop-x', `${this.panX}px`);
    this.image.style.setProperty('--crop-y', `${this.panY}px`);
    this.image.style.setProperty('--crop-zoom', this.zoom);
  }

  #setZoom(value, anchor = null) {
    const next = Math.max(1, Math.min(4, value));
    if (anchor && this.zoom > 0) {
      const rect = this.frame.getBoundingClientRect();
      const x = anchor.x - rect.left - rect.width / 2;
      const y = anchor.y - rect.top - rect.height / 2;
      const ratio = next / this.zoom;
      this.panX = x - (x - this.panX) * ratio;
      this.panY = y - (y - this.panY) * ratio;
    }
    this.zoom = next;
    this.zoomSlider.value = String(next);
    this.#paint();
  }

  #reset() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.zoomSlider.value = '1';
    this.#paint();
  }

  #pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    this.frame.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.#snapshotGesture();
  }

  #snapshotGesture() {
    const points = [...this.pointers.values()];
    this.gesture = {
      points,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      distance: points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
      center: points.length > 1 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : null,
    };
  }

  #pointerMove(event) {
    if (!this.pointers.has(event.pointerId) || !this.gesture) return;
    event.preventDefault();
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...this.pointers.values()];
    if (points.length > 1 && this.gesture.distance > 0) {
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      this.zoom = Math.max(1, Math.min(4, this.gesture.zoom * distance / this.gesture.distance));
      this.panX = this.gesture.panX + center.x - this.gesture.center.x;
      this.panY = this.gesture.panY + center.y - this.gesture.center.y;
      this.zoomSlider.value = String(this.zoom);
    } else if (points.length === 1 && this.gesture.points.length === 1) {
      this.panX = this.gesture.panX + points[0].x - this.gesture.points[0].x;
      this.panY = this.gesture.panY + points[0].y - this.gesture.points[0].y;
    }
    this.#paint();
  }

  #pointerEnd(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    this.#snapshotGesture();
  }

  async #crop() {
    if (this.applyButton.disabled) return;
    this.applyButton.disabled = true;
    try {
      const { width, height } = this.#frameSize();
      const scale = this.#scale();
      if (!width || !height || !scale) throw new Error(t('photoCropFailed'));
      const sourceX = Math.max(0, Math.min(this.image.naturalWidth, this.image.naturalWidth / 2 - this.panX / scale));
      const sourceY = Math.max(0, Math.min(this.image.naturalHeight, this.image.naturalHeight / 2 - this.panY / scale));
      const sourceWidth = Math.min(this.image.naturalWidth - sourceX, width / scale);
      const sourceHeight = Math.min(this.image.naturalHeight - sourceY, height / scale);
      const outputWidth = this.mode === 'cover' ? 1600 : 1024;
      const outputHeight = Math.round(outputWidth * height / width);
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('photoCropFailed'));
      context.drawImage(this.image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error(t('photoCropFailed'));
      const file = new File([blob], `${this.mode}-photo.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      this.#finish(file);
      this.sheet.close();
    } catch (error) {
      this.message.textContent = error instanceof Error && error.message === t('photoCropFailed')
        ? error.message : t('photoCropFailed');
      this.applyButton.disabled = false;
    }
  }

  #finish(value) {
    const resolve = this.resolve;
    this.resolve = null;
    this.pointers.clear();
    this.gesture = null;
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = '';
    this.image.removeAttribute('src');
    resolve?.(value);
  }
}

function missingProfileColumn(error, columns) {
  const message = String(error?.message || '');
  if (!['PGRST204', '42703'].includes(String(error?.code || ''))
    && !/schema cache|column .* does not exist|could not find the .*column/i.test(message)) return null;
  return columns.find(column => new RegExp(`\\b${column}\\b`, 'i').test(message)) || null;
}

const postOwnerId = post => String(post?.author_id || post?.user_id || post?.author?.id || post?.authorId || '');
const postUsername = post => String(post?.username || post?.author_username || post?.author?.username || '').replace(/^@/, '').toLowerCase();
const profileOwnsPost = (post, id, username) => {
  const ownerId = postOwnerId(post);
  const handle = String(username || '').replace(/^@/, '').toLowerCase();
  return ownerId === String(id) || Boolean(handle && (postUsername(post) === handle || ownerId.replace(/^@/, '').toLowerCase() === handle));
};

function cachedProfilePosts(id, username, sb = null) {
  const cached = ['foryou', 'following'].flatMap(scope => {
    const posts = feed(scope).source.value?.posts;
    return Array.isArray(posts) ? posts : [];
  });
  return cached.filter(post => post?.id && (profileOwnsPost(post, id, username)
    || (post.public_post === true && String(id) === String(auth.userId || ''))))
    .map(post => normalizeProfilePost(post, id, sb));
}

async function loadProfilePosts(sb, id, username = '') {
  const optional = [...PROFILE_POST_OPTIONAL];
  const ownerFilters = [
    ['author_id', id],
    ['user_id', id],
    ...(username ? [['username', username], ['author_username', username]] : []),
  ];
  const results = [];
  let lastError = null;
  let publicPostsError = null;
  for (const [column, value] of ownerFilters) {
    const availableOptional = [...optional];
    let offset = 0;
    while (true) {
      const fields = [...PROFILE_POST_REQUIRED, ...availableOptional].join(',');
      let result;
      try {
        result = await sb.from('mw_posts').select(fields).eq(column, value)
          .order('created_at', { ascending: false }).range(offset, offset + PROFILE_POST_PAGE_SIZE - 1);
      } catch (error) {
        lastError = error;
        break;
      }
      if (!result.error) {
        const rows = Array.isArray(result.data) ? result.data : [];
        results.push(...rows.filter(row => row && typeof row === 'object').map(row => normalizeProfilePost(row, id, sb)));
        if (rows.length === PROFILE_POST_PAGE_SIZE) {
          offset += PROFILE_POST_PAGE_SIZE;
          continue;
        }
        break;
      }
      const missing = missingProfileColumn(result.error, [...availableOptional, ...PROFILE_POST_REQUIRED]);
      if (!missing || !availableOptional.includes(missing)) {
        lastError = result.error;
        break;
      }
      availableOptional.splice(availableOptional.indexOf(missing), 1);
    }
  }
  try {
    results.push(...await loadPublicPosts(sb, { publishedOnly: true }));
  } catch (error) {
    publicPostsError = error;
    console.warn('[profile] public posts could not be loaded.', error);
  }
  const merged = new Map(cachedProfilePosts(id, username, sb).map(post => [String(post.id), post]));
  for (const post of results) merged.set(String(post.id), post);
  const data = [...merged.values()].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
  return { data, error: data.length ? null : lastError || publicPostsError };
}

function normalizeProfilePost(row, ownerId = '', sb = null) {
  const media = row.media && typeof row.media === 'object' ? row.media : {};
  const normalizeMediaPath = value => {
    const path = profileText(value);
    return sb ? portfolioMediaUrl(sb, { storage_path: path }) || path : path;
  };
  const mediaItems = (Array.isArray(row.media_items) ? row.media_items.filter(item => typeof item === 'string')
    : Array.isArray(media.items) ? media.items.filter(item => typeof item === 'string') : []);
  const previews = (Array.isArray(row.media_preview_items) ? row.media_preview_items.filter(item => typeof item === 'string')
    : Array.isArray(media.previewItems) ? media.previewItems.filter(item => typeof item === 'string') : []);
  const normalizedMediaItems = mediaItems.map(normalizeMediaPath);
  const normalizedPreviews = previews.map(normalizeMediaPath);
  const rowMediaUrl = profileText(row.media_url);
  const objectMediaUrl = profileText(media.url);
  const mediaUrl = (sb ? portfolioMediaUrl(sb, { ...row, media_url: rowMediaUrl || objectMediaUrl || normalizedMediaItems[0] || '' }) : '')
    || rowMediaUrl || objectMediaUrl || normalizedMediaItems[0] || '';
  const mediaTypeValue = profileText(row.media_type) || profileText(media.type);
  const mediaType = mediaTypeValue
    || (/\.(mp4|m4v|mov|webm|ogv|3gp)(\?|#|$)/i.test(mediaUrl) ? 'video' : mediaUrl ? 'image' : null);
  return {
    ...row,
    author_id: row.public_post ? '' : row.author_id || row.user_id || row.author?.id || row.authorId || ownerId,
    audience: row.public_post ? 'everyone' : row.audience,
    username: row.username || row.author_username || row.author?.username || '',
    created_at: row.created_at || row.createdAt || '',
    media_url: mediaUrl,
    media_type: mediaType,
    media_items: normalizedMediaItems,
    media_preview_items: normalizedPreviews,
  };
}

export class ProfileView {
  constructor({ requireLogin, openCreate, openComments, openMenu, openChat, openFollowers, openActivity, openNotifications }) {
    this.hooks = { requireLogin, openCreate, openComments, openMenu, openChat, openFollowers, openActivity, openNotifications };
    this.sheet = new Sheet({ title: t('me'), className: 'profile-sheet', onClose: () => this.#sheetClosed() });
    this.content = h('div', { class: 'profile' });
    this.sheet.body.append(this.content);
    this.token = 0;
    this.posts = [];
    this.postAudiences = {};
    this.audienceLoadError = false;
    this.viewer = null;
    this.cropper = new ProfileCropSheet();
    this.historyEntry = null;
    this.historyPopPending = null;
    this.handlingProfilePop = false;
    addEventListener('popstate', () => this.#historyChanged());
    // Delete confirmation for a post picked from the grid's "⋯" button.
    this.menu = new Sheet({ title: t('post'), className: 'post-menu-sheet' });
  }

  #viewer() {
    return this.viewer ||= new PostViewer({
      requireLogin: () => this.hooks.requireLogin(),
      openComments: post => this.hooks.openComments?.(post),
      onDeleted: post => this.#removed(post),
    });
  }

  #openPost(post) {
    const source = this.displayPosts || this.posts;
    const index = source.indexOf(post);
    if (index >= 0) this.#viewer().open(source, index, { own: post.author_id === auth.userId });
  }

  #removed(post) {
    const postId = String(post.id);
    const at = this.posts.findIndex(item => String(item.id) === postId);
    if (at >= 0) this.posts.splice(at, 1);
    this.displayPosts = (this.displayPosts || []).filter(item => String(item.id) !== postId);
    this.grid?.querySelector(`[data-post="${CSS.escape(postId)}"]`)?.remove();
    if (at >= 0 && this.postCount) this.postCount.textContent = count(this.posts.filter(isPostsTabPost).length);
    if (this.grid && !this.displayPosts.length) {
      const message = this.activeTab === 'saved' ? t('noSaved')
        : this.activeTab === 'liked' ? t('empty')
          : this.own ? t('noPostsYet') : t('empty');
      this.#renderGrid([], { message });
    }
  }

  #pushProfileHistory() {
    if (this.historyEntry) return;
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    const entry = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    history.pushState({ ...state, mwProfileSheet: entry }, '', location.href);
    this.historyEntry = entry;
  }

  #sheetClosed() {
    clearInterval(this.usernameCooldownTimer);
    const entry = this.historyEntry;
    if (!entry || this.handlingProfilePop) return;
    this.historyEntry = null;
    if (history.state?.mwProfileSheet === entry) {
      this.historyPopPending = entry;
      history.back();
    }
  }

  #historyChanged() {
    const currentEntry = history.state?.mwProfileSheet;
    if (this.historyPopPending && currentEntry !== this.historyPopPending) {
      this.historyPopPending = null;
      return;
    }
    if (!this.historyEntry || currentEntry === this.historyEntry) return;
    const topLayer = [...document.querySelectorAll('.sheet-layer.open, .pv-layer.open')].at(-1);
    if (topLayer && topLayer !== this.sheet.root) {
      this.historyEntry = null;
      if (topLayer.matches('.pv-layer')) topLayer.querySelector('.pv-close')?.click();
      else topLayer.querySelector('.sheet-backdrop')?.click();
      this.#pushProfileHistory();
      return;
    }
    this.historyEntry = null;
    this.handlingProfilePop = true;
    this.sheet.close();
    this.handlingProfilePop = false;
  }

  close() {
    if (this.historyEntry && history.state?.mwProfileSheet === this.historyEntry) {
      history.back();
      return;
    }
    this.sheet.close();
  }

  #renderGrid(posts = this.posts, { loading = false, message = '' } = {}) {
    if (!this.grid) return;
    this.displayPosts = posts;
    if (loading) {
      this.grid.replaceChildren(h('p', { class: 'muted center', role: 'status' }, t('loading')));
    } else if (message) {
      this.grid.replaceChildren(h('p', { class: 'muted center', role: 'status' }, profileText(message)));
    } else if (!posts.length) {
      this.grid.replaceChildren(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
    } else {
      this.grid.replaceChildren(...posts.map(post => tile(post, {
        open: () => this.#openPost(post),
        menu: () => this.#postMenu(post),
      })));
    }
  }

  async #selectTab(tab) {
    this.activeTab = tab;
    this.tabs?.setAttribute('data-active-tab', tab);
    this.tabs?.querySelectorAll('[data-profile-tab]').forEach(button => {
      const selected = button.dataset.profileTab === tab;
      button.setAttribute('aria-selected', String(selected));
      if (selected) this.grid?.setAttribute('aria-labelledby', button.id);
    });
    if (this.grid) this.grid.dataset.profilePanel = tab;
    const token = this.token;
    if (tab === 'posts' || tab === 'private') {
      if (!this.own && tab === 'private') {
        this.#renderGrid([], { message: t('privateActivity') });
        return;
      }
      if (this.own && tab === 'private' && this.audienceLoadError) {
        this.#renderGrid([], { message: t('retry') });
        return;
      }
      const posts = this.posts.filter(tab === 'private' ? isPrivateProfilePost : isPostsTabPost);
      this.#renderGrid(posts, {
        message: posts.length ? '' : tab === 'private' ? t('noPrivatePosts') : this.own ? t('noPostsYet') : t('empty'),
      });
      return;
    }
    if (!this.own) { this.#renderGrid([], { message: t('privateActivity') }); return; }

    this.#renderGrid([], { loading: true });
    try {
      const sb = await supabase();
      let ids = [];
      if (tab === 'saved') {
        const result = await api(`${config.api.feed}?action=saved`, { timeout: 12000 });
        ids = (Array.isArray(result?.saved) ? result.saved : [])
          .map(item => String(item?.postId || '')).filter(Boolean).slice(0, 100);
      } else {
        const { data, error } = await sb.from('mw_signals').select('post_id')
          .eq('user_id', this.id).eq('kind', 'light').limit(100);
        if (error) throw error;
        ids = [...new Set((Array.isArray(data) ? data : []).map(row => String(row?.post_id || '')).filter(Boolean))];
      }
      if (token !== this.token || tab !== this.activeTab) return;
      if (!ids.length) { this.#renderGrid([], { message: tab === 'saved' ? t('noSaved') : t('empty') }); return; }
      let result = await sb.from('mw_posts').select([...PROFILE_POST_REQUIRED, 'author_id', 'storage_path'].join(',')).in('id', ids);
      if (result.error && missingProfileColumn(result.error, ['storage_path']) === 'storage_path') {
        result = await sb.from('mw_posts').select([...PROFILE_POST_REQUIRED, 'author_id'].join(',')).in('id', ids);
      }
      const { data, error } = result;
      if (error) throw error;
      if (token !== this.token || tab !== this.activeTab) return;
      const byId = new Map((Array.isArray(data) ? data : []).map(row => [String(row.id), normalizeProfilePost(row, '', sb)]));
      const posts = ids.map(id => byId.get(id)).filter(Boolean).map(post => ({
        ...post,
        audience: this.postAudiences[post.id] || 'everyone',
        ...(tab === 'saved' ? { saved: true } : { liked: true }),
      }));
      this.#renderGrid(posts, { message: posts.length ? '' : tab === 'saved' ? t('noSaved') : t('empty') });
    } catch (error) {
      if (token === this.token && tab === this.activeTab) this.#renderGrid([], { message: profileText(error?.message) || t('retry') });
    }
  }

  #postMenu(post) {
    const message = h('p', { class: 'muted center', role: 'status' });
    const ownPost = String(post.author_id || post.author?.id || '') === String(auth.userId || '');
    const busy = button => { button.disabled = true; };
    const recover = (button, error) => {
      console.error('[profile] post action failed.', error);
      button.disabled = false;
      message.textContent = t('retry');
    };
    const save = h('button', { class: 'pill-btn wide', type: 'button' }, post.saved ? t('unsave') : t('save'));
    save.onclick = async () => {
      if (!this.hooks.requireLogin()) return;
      busy(save); message.textContent = '';
      try {
        await actions.save(post, !post.saved);
        post.saved = !post.saved;
        if (this.activeTab === 'saved' && !post.saved) {
          this.displayPosts = (this.displayPosts || []).filter(item => item.id !== post.id);
          this.#renderGrid(this.displayPosts, { message: this.displayPosts.length ? '' : t('noSaved') });
        }
        save.textContent = post.saved ? t('unsave') : t('save');
        save.disabled = false;
      } catch (error) { recover(save, error); }
    };
    const items = [
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => { this.menu.close(); this.#openPost(post); } }, t('openPost')),
    ];
    if (ownPost) {
      const postId = String(post.id);
      const audienceKnown = Object.prototype.hasOwnProperty.call(this.postAudiences, postId);
      const visibility = h('button', { class: 'pill-btn wide', type: 'button' },
        audienceKnown ? (post.audience === 'everyone' ? t('makePrivate') : t('makePublic')) : t('loading'));
      visibility.disabled = !audienceKnown;
      visibility.onclick = async () => {
        busy(visibility); message.textContent = '';
        try {
          const audience = post.audience === 'everyone' ? 'only_me' : 'everyone';
          await actions.setAudience(post, audience);
          post.audience = audience;
          this.postAudiences[post.id] = audience;
          visibility.textContent = audience === 'everyone' ? t('makePrivate') : t('makePublic');
          visibility.disabled = false;
          if (this.activeTab === 'posts' && audience !== 'everyone'
            || this.activeTab === 'private' && audience === 'everyone') {
            this.#selectTab(this.activeTab);
          }
          toast(t('postVisibilityUpdated'));
        } catch (error) { recover(visibility, error); }
      };
      if (!audienceKnown) {
        api(`/api/milkyway-gallery?action=audiences&ids=${encodeURIComponent(postId)}`, { timeout: 12000 }).then(result => {
          post.audience = result?.own?.[postId] || 'everyone';
          this.postAudiences[postId] = post.audience;
          visibility.textContent = post.audience === 'everyone' ? t('makePrivate') : t('makePublic');
          visibility.disabled = false;
        }).catch(error => {
          console.error('[profile] post audience could not be loaded.', error);
          message.textContent = t('retry');
        });
      }
      items.push(visibility);
    }
    items.push(save, h('button', {
      class: 'pill-btn wide', type: 'button', onclick: () => {
        this.menu.close();
        openShare({
          title: profileText(post.author_name || this.profile?.name) || 'MilkyWay',
          text: profileText(post.caption).slice(0, 120),
          url: `${location.origin}/share/${encodeURIComponent(post.id)}`,
        });
      },
    }, t('shareLink')));
    const remove = h('button', { class: 'pill-btn danger wide', type: 'button' }, t('deletePost'));
    let armed = 0;
    if (ownPost) {
      remove.onclick = async () => {
        if (!armed) {
          remove.textContent = t('tapAgainDelete'); remove.classList.add('armed');
          armed = setTimeout(() => { armed = 0; remove.textContent = t('deletePost'); remove.classList.remove('armed'); }, 3000);
          return;
        }
        clearTimeout(armed);
        remove.disabled = true; remove.textContent = t('deleting'); message.textContent = '';
        try {
          await actions.remove(post);
          this.#removed(post);
          this.menu.close();
          toast(t('postDeleted'));
        } catch (error) {
          console.error('[profile] post deletion failed.', error);
          armed = 0; remove.disabled = false; remove.textContent = t('deletePost'); remove.classList.remove('armed');
          message.textContent = t('deleteFailed');
        }
      };
      items.push(remove);
    }
    if (auth.signedIn() && typeof post.saved !== 'boolean') {
      busy(save);
      api(`${config.api.feed}?action=saved`, { timeout: 12000 }).then(result => {
        post.saved = (Array.isArray(result?.saved) ? result.saved : []).some(item => String(item?.postId) === String(post.id));
        save.textContent = post.saved ? t('unsave') : t('save');
        save.disabled = false;
      }).catch(error => recover(save, error));
    }
    this.menu.title = t('postOptions');
    this.menu.body.replaceChildren(h('div', { class: 'stack post-menu-actions' },
      ...items, message,
      h('button', { class: 'link center', type: 'button', onclick: () => this.menu.close() }, t('cancel'))));
    this.menu.open();
  }

  /** person: { id, name, username, avatar } or null for the signed-in user. */
  open(person = null, { photo = null, fullscreen = false } = {}) {
    const id = String(person?.id || auth.userId || '');
    if (!id) return;
    this.pendingPhoto = photo;
    this.id = id;
    this.own = id === auth.userId;
    this.activeTab = 'posts';
    this.postAudiences = {};
    this.audienceLoadError = false;
    this.sheet.panel.classList.toggle('profile-sheet-fullscreen', fullscreen);
    this.sheet.title = this.own ? t('me') : (profileText(person?.name || profiles.peek(id)?.name) || t('profile'));
    this.sheet.panel.setAttribute('aria-label', this.sheet.title);
    this.#render({ profile: person || profiles.peek(id) || { id, name: this.own ? auth.name : '' }, loading: true });
    this.#pushProfileHistory();
    this.sheet.open();
    this.#load(id);
  }

  openForPhoto(file) {
    if (!auth.userId || !file) return;
    this.open(null, { photo: file });
  }

  #quickPickImage(mode) {
    if (!this.own || !auth.userId) return;
    const input = h('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    document.body.append(input);
    let handled = false;
    const cleanup = () => {
      if (handled) return;
      handled = true;
      input.remove();
    };
    input.addEventListener('cancel', cleanup, { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0] || null;
      cleanup();
      if (file) void this.#frameAndSaveImage(file, mode);
    }, { once: true });
    try { openFilePicker(input); }
    catch (error) {
      cleanup();
      console.warn('[profile] image picker could not be opened.', error);
      toast(t('mediaPickerUnavailable'));
    }
  }

  async #frameAndSaveImage(file, mode) {
    try {
      await validateProfilePhoto(file);
      const optimized = await optimizeImage(file);
      const framed = await this.cropper.open(optimized.full, mode);
      if (framed) await this.#saveQuickImage(framed, mode);
    } catch (error) {
      console.warn('[profile] image framing failed.', error);
      const message = profileText(error?.message);
      toast(message === t('photoTooLarge') || message === t('photoUnsupported') ? message : t('photoCropFailed'));
    }
  }

  async #saveQuickImage(file, mode) {
    let uploadedPath = '';
    try {
      const sb = await supabase();
      const info = await identifyMediaFile(file);
      if (info.kind !== 'image' || !['image/jpeg', 'image/png', 'image/webp'].includes(info.type)) {
        throw new Error(t('photoUnsupported'));
      }
      if (file.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
      const folder = mode === 'cover' ? 'covers' : 'avatars';
      uploadedPath = `milkyway/${auth.userId}/${folder}/${crypto.randomUUID()}.${info.extension}`;
      const { error: uploadError } = await sb.storage.from('portfolio').upload(uploadedPath, file, {
        contentType: info.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploadError) throw uploadError;
      const url = sb.storage.from('portfolio').getPublicUrl(uploadedPath)?.data?.publicUrl;
      if (!url) throw new Error(t('photoUploadFailed'));

      let saved;
      if (mode === 'cover') {
        const result = await sb.from('mw_profiles').update({ cover_url: url }).eq('id', auth.userId)
          .select('id,cover_url').maybeSingle();
        if (result.error && missingProfileColumn(result.error, ['cover_url']) === 'cover_url') {
          cacheCover(auth.userId, url);
          saved = { id: auth.userId, cover_url: url };
        } else {
          if (result.error) throw result.error;
          if (!result.data) throw new Error(t('profileSettingsUnavailable'));
          saved = result.data;
          cacheCover(auth.userId, '');
        }
      } else {
        const result = await sb.from('mw_profiles').update({ avatar_url: url }).eq('id', auth.userId)
          .select('id,avatar_url').maybeSingle();
        if (result.error) throw result.error;
        if (!result.data || result.data.avatar_url !== url) throw new Error(t('profileSettingsUnavailable'));
        saved = result.data;
      }
      const current = profiles.peek(auth.userId) || {};
      profiles.update({
        ...current,
        id: auth.userId,
        avatar: mode === 'avatar' ? saved.avatar_url : current.avatar || '',
        cover: mode === 'cover' ? saved.cover_url || cachedCover(auth.userId) : current.cover || cachedCover(auth.userId),
      });
      this.#load(this.id);
      toast('✓');
    } catch (error) {
      if (uploadedPath) {
        try {
          const client = await supabase();
          const { error: cleanupError } = await client.storage.from('portfolio').remove([uploadedPath]);
          if (cleanupError) console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
        } catch (cleanupError) {
          console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
        }
      }
      console.error('[profile] quick image update failed.', error);
      const message = profileText(error?.message);
      toast([t('photoUnsupported'), t('photoTooLarge'), t('photoUploadFailed'), t('profileSettingsUnavailable')].includes(message)
        ? message : t('profileSettingsUnavailable'));
    }
  }

  async #load(id) {
    const token = ++this.token;
    this.mode = 'profile';
    this.audienceLoadError = false;
    try {
      const sb = await supabase();
      const head = { count: 'exact', head: true };
      const profile = await quiet(sb.from('mw_profiles').select('*').eq('id', id).maybeSingle());
      if (token !== this.token) return;
      const row = profile.data || {};
      const username = profileText(row.username) || profileText(profiles.peek(id)?.username);
      const [followers, following, posts, followingRows, followerRows, requests] = await Promise.all([
        quiet(sb.from('mw_follows').select('follower_id', head).eq('following_id', id)),
        quiet(sb.from('mw_follows').select('following_id', head).eq('follower_id', id)),
        loadProfilePosts(sb, id, username),
        quiet(sb.from('mw_follows').select('following_id').eq('follower_id', id).limit(2000)),
        quiet(sb.from('mw_follows').select('follower_id').eq('following_id', id).limit(2000)),
        this.own ? quiet(sb.from('mw_follow_requests').select('requester_id', head).eq('target_id', id)) : Promise.resolve({ count: 0 }),
      ]);
      if (token !== this.token) return;
      const person = {
        id,
        name: profileText(row.display_name) || profileText(profiles.peek(id)?.name) || profileText(this.own ? auth.name : 'MilkyWay'),
        username,
        usernameAutoGenerated: Boolean(row.username_auto_generated),
        usernameUpdatedAt: profileText(row.username_updated_at),
        avatar: profileText(row.avatar_url),
        cover: profileText(row.cover_url) || profileText(cachedCover(id)),
        bio: profileText(row.bio),
        role: profileText(row.role) || profileText(row.status),
        interests: Array.isArray(row.interests) ? row.interests.map(profileText).filter(Boolean) : profileText(row.interests),
        private: Boolean(row.is_private),
      };
      profiles.prime([{ id, name: person.name, username: person.username, avatar: person.avatar, private: person.private }]);
      if (!this.own) this.sheet.title = profileText(person.name) || t('profile');
      const { data: pin } = await quiet(sb.from('mw_creator_pins').select('post_id').eq('creator_id', id).maybeSingle());
      const profilePosts = Array.isArray(posts.data) ? posts.data : [];
      if (pin?.post_id) profilePosts.sort((a, b) => Number(b.id === pin.post_id) - Number(a.id === pin.post_id));
      let audienceMap = {};
      const ownedPosts = profilePosts.filter(post => !post.public_post);
      if (this.own && ownedPosts.length) {
        try {
          const result = await api(`/api/milkyway-gallery?action=audiences&ids=${ownedPosts.map(post => encodeURIComponent(post.id)).join(',')}`, { timeout: 12000 });
          if (!result?.own || typeof result.own !== 'object') throw new Error(t('retry'));
          audienceMap = result.own;
        } catch (apiError) {
          try {
            const result = await sb.from('mw_post_audience').select('post_id,audience')
              .eq('owner_id', id).in('post_id', ownedPosts.map(post => post.id));
            if (result.error) throw result.error;
            audienceMap = Object.fromEntries((result.data || []).map(item => [String(item.post_id), item.audience]));
          } catch (fallbackError) {
            this.audienceLoadError = true;
            console.warn('[profile] post audiences could not be loaded through the API or direct query.', { apiError, fallbackError });
          }
        }
      }
      this.postAudiences = audienceMap;
      const postsWithAudience = profilePosts.map(post => ({
        ...post,
        audience: post.public_post ? 'everyone' : this.own ? audienceMap[post.id] || 'everyone' : 'everyone',
      }));
      const followingIds = new Set((followingRows.data || []).map(item => String(item.following_id)));
      const friends = (followerRows.data || []).reduce((total, item) => total + Number(followingIds.has(String(item.follower_id))), 0);
      const renderData = {
        profile: person,
        followers: followers.count || 0,
        following: following.count || 0,
        friends,
        requests: requests.count || 0,
        posts: postsWithAudience,
        postsError: profileText(posts.error?.message),
      };
      this.#render(renderData);
      if (this.own && this.pendingPhoto) {
        const selected = this.pendingPhoto;
        this.pendingPhoto = null;
        this.#edit(person, { photo: selected });
      }
      this.#loadBusiness(person, token);
    } catch (error) {
      if (token === this.token) {
        console.error('[profile] profile data could not be loaded.', error);
        this.#render({ profile: profiles.peek(id) || { id }, error: true });
      }
    }
  }

  async #loadBusiness(profile, token) {
    let section;
    try {
      const sb = await supabase();
      const { data, error } = await sb.from('mw_creator_services')
        .select('id,title,category,description')
        .eq('creator_id', profile.id).eq('is_published', true).order('created_at', { ascending: false });
      if (error) throw error;
      if (token !== this.token || this.mode !== 'profile' || !data?.length) return;
      section = h('section', { class: 'mw-profile-services' },
        h('h3', {}, t('studioPortfolio')),
        h('div', { class: 'mw-studio-service-list' }, ...data.map(service => this.#profileService(service, profile))));
    } catch (error) {
      if (token !== this.token || this.mode !== 'profile') return;
      console.warn('[profile] creator portfolio could not be loaded.', error);
      return;
    }
    if (token === this.token && this.mode === 'profile' && section) this.content.append(section);
  }

  #profileService(service, profile) {
    const card = h('article', { class: 'mw-studio-service-card' },
      h('div', {}, h('small', { class: 'mw-studio-eyebrow' }, profileText(service.category)),
        h('h4', {}, profileText(service.title)), h('p', { class: 'muted' }, profileText(service.description))));
    if (this.own || !auth.signedIn()) return card;
    const button = h('button', { class: 'pill-btn hot', type: 'button', onclick: () => {
      const note = h('p', { class: 'muted', role: 'status' });
      const preferredAt = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('studioPreferredDate') });
      const inquiryText = h('textarea', { class: 'field area', maxlength: '2000', minlength: '10', required: true, placeholder: t('studioInquiryMessage') });
      const submit = h('button', { class: 'pill-btn hot', type: 'submit' }, t('studioSendInquiry'));
      const form = h('form', { class: 'mw-studio-service-request', onsubmit: async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const sb = await supabase();
          const { error } = await sb.from('mw_service_inquiries').insert({
            service_id: service.id,
            creator_id: profile.id,
            requester_id: auth.userId,
            client_name: auth.name.slice(0, 80),
            message: inquiryText.value.trim(),
            preferred_at: preferredAt.value ? new Date(preferredAt.value).toISOString() : null,
          });
          if (error) throw error;
          note.textContent = t('studioInquirySent');
          submit.remove();
          toast(t('studioInquirySent'));
        } catch (error) {
          note.textContent = profileText(error?.message) || t('retry');
          submit.disabled = false;
        }
      } }, preferredAt, inquiryText, submit, note);
      card.replaceChildren(card.firstElementChild, form);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } }, t('studioRequestService'));
    card.append(button);
    return card;
  }

  #render({ profile, followers = 0, following = 0, friends = 0, requests = 0, posts = [], loading = false, error = false, postsError = '' }) {
    profile = profile && typeof profile === 'object' ? profile : { id: this.id || auth.userId || '' };
    profile = {
      ...profile,
      id: profileText(profile.id),
      name: profileText(profile.name) || 'MilkyWay',
      username: profileText(profile.username),
      role: profileText(profile.role),
      status: profileText(profile.status),
      bio: profileText(profile.bio),
      avatar: profileText(profile.avatar),
      cover: profileText(profile.cover),
      private: profile.private === true || profile.private === 'true',
      usernameUpdatedAt: profileText(profile.usernameUpdatedAt),
      interests: Array.isArray(profile.interests)
        ? profile.interests.map(profileText).filter(Boolean)
        : profileText(profile.interests),
    };
    this.profile = profile;
    this.content.classList.toggle('has-cover-shortcut', this.own);
    this.profilePrivate = Boolean(profile.private);
    this.posts = Array.isArray(posts) ? posts.filter(post => post && typeof post === 'object') : [];
    this.postCount = h('b', {}, count(this.posts.filter(isPostsTabPost).length));
    const stats = h('div', { class: 'profile-stats' },
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'following' }) }, h('b', {}, count(following)), t('followingCount')),
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'followers' }) }, h('b', {}, count(followers)), t('followers')),
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'friends' }) }, h('b', {}, count(friends)), t('friends')),
      h('button', { type: 'button', onclick: () => {
        this.#selectTab('posts');
        requestAnimationFrame(() => this.grid?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      } }, this.postCount, t('posts')));
    const actionsRow = h('div', { class: 'profile-actions' });
    if (this.own) {
      actionsRow.append(
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#edit(profile) }, t('editProfile')),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openCreate(); } }, t('create')));
      // Owner-only gold Admin button (shown at once for the owner email; the server checks again on every action).
      if (isOwnerAccount() && !actionsRow.querySelector('.nova-admin-btn')) {
        actionsRow.append(h('button', { class: 'pill-btn nova-admin-btn', type: 'button', onclick: () => {
          this.sheet.close();
          import('./admin-view.js').then(m => (ProfileView.admin ||= new m.AdminView()).open());
        } }, '🛡 Admin'));
      }
    } else if (auth.signedIn()) {
      const button = h('button', { class: 'pill-btn hot', type: 'button' });
      const paint = () => {
        const on = profiles.isFollowing(profile.id);
        const requested = profiles.isRequested(profile.id);
        button.textContent = on ? t('following') : requested ? t('requested') : t('follow');
        button.classList.toggle('hot', !on && !requested);
        button.setAttribute('aria-pressed', String(on || requested));
      };
      button.onclick = () => {
        const on = !profiles.isFollowing(profile.id) && !profiles.isRequested(profile.id);
        actions.follow(profile.id, on).then(paint).catch(() => toast(t('queued')));
        paint();
      };
      paint();
      actionsRow.append(button,
        h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openChat?.(profile); } }, h('span', { html: icon.inbox }), t('inbox')));
    } else {
      actionsRow.append(h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.hooks.requireLogin() }, t('follow')));
    }

    const grid = this.grid = h('div', { class: 'profile-grid', role: 'tabpanel', tabindex: '0' });
    grid.id = 'profileMediaGrid';
    const tabItems = [
      ['posts', t('posts'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>'],
      ['private', t('privatePosts'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm2 0h8V7a4 4 0 0 0-8 0zm4 4a2 2 0 0 0-1 3.73V19h2v-1.27A2 2 0 0 0 12 14z"/></svg>'],
      ['saved', t('savedPosts'), icon.bookmark],
      ['liked', t('likedPosts'), icon.heart],
    ];
    const tabs = this.tabs = h('div', { class: 'profile-tabs', role: 'tablist', 'aria-label': t('profileContent') },
      ...tabItems.map(([key, label, glyph]) => h('button', {
        class: 'profile-tab', type: 'button', role: 'tab', 'data-profile-tab': key,
        id: `profile-${key}-tab`, 'aria-label': label, title: label, 'aria-controls': grid.id,
        'aria-selected': String(this.activeTab === key), html: glyph,
      })));
    tabs.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-profile-tab]');
      if (button && tabs.contains(button)) void this.#selectTab(button.dataset.profileTab);
    });
    if (loading) this.#renderGrid([], { loading: true });
    else if (error || postsError) this.#renderGrid([], { message: profileText(postsError) || t('retry') });
    else void this.#selectTab(this.activeTab || 'posts');

    const coverUrl = profileText(profile.cover);
    const profileCover = h('div', { class: 'profile-cover', 'aria-hidden': 'true' },
      coverUrl ? h('img', { src: coverUrl, alt: '', loading: 'lazy', decoding: 'async' }) : null);
    const coverControl = this.own
      ? h('button', {
        class: 'profile-cover-shortcut', type: 'button',
        'aria-label': t('changeCoverPhoto'), title: t('changeCoverPhoto'),
        onclick: event => {
          event.preventDefault();
          event.stopPropagation();
          this.#quickPickImage('cover');
        },
      }, h('span', { 'aria-hidden': 'true' }, '+'))
      : null;
    const profileAvatar = avatar({ ...profile, name: profileText(profile.name) }, 84);
    const avatarControl = this.own
      ? h('button', {
        class: 'profile-avatar-shortcut', type: 'button', 'aria-label': t('changeProfilePhoto'),
        onclick: event => {
          event.preventDefault();
          event.stopPropagation();
          this.#quickPickImage('avatar');
        },
      },
        h('span', { class: `presence-avatar${presence.isOnline(profile.id) || presence.visible ? ' online' : ''}`, 'data-presence': profile.id },
          profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' })))
      : h('span', { class: `presence-avatar${presence.isOnline(profile.id) ? ' online' : ''}`, 'data-presence': profile.id },
        profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' }));
    const toolbar = h('div', { class: 'profile-toolbar', 'data-no-swipe': true },
      h('div', { class: 'profile-toolbar-group' },
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('back'), title: t('back'), onclick: () => this.close() }, '‹'),
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('suggestedAccounts'), title: t('suggestedAccounts'), html: icon.guests, onclick: () => this.hooks.openFollowers?.(profile, { tab: 'suggested' }) })),
      h('div', { class: 'profile-toolbar-group' },
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('share'), title: t('share'), html: icon.share, onclick: () => openShare({
          title: profileText(profile.name) || t('profile'),
          text: profileText(profile.bio),
          url: (() => { const url = new URL(location.pathname, location.origin); url.searchParams.set('profile', profile.id); return url.href; })(),
        }) }),
        this.own ? h('button', {
          class: 'profile-icon-btn profile-activity-btn', type: 'button',
          'aria-label': t('notifications'), title: t('notifications'),
          onclick: () => this.hooks.openNotifications?.(profile),
        }, h('span', {
          class: 'profile-icon-glyph profile-activity-glyph', 'aria-hidden': 'true',
          html: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 3a7 7 0 0 0-7 7v4.2L3.6 17v1.5h16.8V17L19 14.2V10a7 7 0 0 0-7-7Zm0 18a2.5 2.5 0 0 0 2.4-1.8h-4.8A2.5 2.5 0 0 0 12 21Z"/><path d="M12 1v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        }),
        Number(requests) > 0 ? h('span', { class: 'profile-activity-count', 'aria-label': `${count(requests)} ${t('followRequests')}` }, count(requests)) : null) : null,
        this.own ? h('button', { class: 'profile-icon-btn nova-menu-btn', type: 'button', 'aria-label': t('menu'), title: t('menu'), html: icon.gear, onclick: () => this.hooks.openMenu?.(profile) }) : null,
        h('button', { class: 'profile-icon-btn profile-close-btn', type: 'button', 'aria-label': t('close'), title: t('close'), html: icon.close, onclick: () => this.close() })));
    const interests = Array.isArray(profile.interests)
      ? profile.interests.map(profileText).filter(Boolean)
      : profileText(profile.interests).split(/[,\n]/).map(value => value.trim()).filter(Boolean);
    const displayName = profileText(profile.name) || 'MilkyWay';
    const username = profileText(profile.username).replace(/^@+/, '');
    const profileHead = h('header', { class: 'profile-head' },
      avatarControl,
      h('div', { class: 'profile-names' },
        h('b', {}, displayName),
        username ? h('span', { class: 'muted' }, `@${username}`) : null,
        (profileText(profile.role) || profileText(profile.status))
          ? h('small', { class: 'profile-role' }, profileText(profile.role) || profileText(profile.status))
          : null,
        profile.private ? h('small', { class: 'muted' }, `🔒 ${t('privateAccount')}`) : null,
        presence.isOnline(profile.id) || (this.own && presence.visible)
          ? h('small', { class: 'presence-label' }, t('activeNow'))
          : null));
    const bio = profileText(profile.bio)
      ? h('p', { class: 'profile-bio' }, profileText(profile.bio))
      : null;
    const interestTags = interests.length
      ? h('div', { class: 'profile-interests', 'aria-label': t('profileContent') }, ...interests.map(value => h('span', {}, value)))
      : null;
    const profileHeader = h('section', { class: 'profile-header', 'aria-label': t('profile') },
      profileCover, coverControl, toolbar, profileHead, bio, interestTags, stats, actionsRow);
    this.content.replaceChildren(
      profileHeader, tabs, grid);
  }

  #edit(profile, { openPicker = false, openCoverPicker = false, photo: initialPhoto = null } = {}) {
    this.mode = 'edit';
    clearInterval(this.usernameCooldownTimer);
    const name = h('input', { class: 'field', maxlength: '60', value: profileText(profile.name), placeholder: t('displayName'), required: true });
    const username = h('input', { class: 'field', maxlength: '20', value: profileText(profile.username), placeholder: t('username'), autocapitalize: 'off', spellcheck: 'false', required: true });
    const usernameStatus = h('small', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    const usernameOriginal = profileText(profile.username).replace(/^@/, '').toLowerCase();
    const updatedAt = Date.parse(profile.usernameUpdatedAt || '');
    const cooldownExpiry = !profile.usernameAutoGenerated && Number.isFinite(updatedAt)
      ? updatedAt + USERNAME_COOLDOWN_MS : 0;
    const paintUsernameCooldown = () => {
      const remaining = Math.max(0, cooldownExpiry - Date.now());
      username.disabled = remaining > 0;
      if (remaining > 0) {
        const totalMinutes = Math.ceil(remaining / 60_000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        usernameStatus.textContent = `${t('usernameCooldown')} ${hours}h ${minutes}m.`;
      } else {
        usernameStatus.textContent = '';
        clearInterval(this.usernameCooldownTimer);
      }
    };
    paintUsernameCooldown();
    if (cooldownExpiry > Date.now()) this.usernameCooldownTimer = setInterval(paintUsernameCooldown, 1000);
    const bio = h('textarea', { class: 'field area', maxlength: '300', placeholder: t('bio') });
    bio.value = profileText(profile.bio);
    const message = h('p', { class: 'muted', role: 'status' });
    const photoInput = h('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    const coverInput = h('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    const photoPreview = h('div', { class: 'profile-photo-preview' }, avatar(profile, 72));
    const coverPreview = h('div', { class: 'profile-cover-preview' },
      profileText(profile.cover)
        ? h('img', { src: profileText(profile.cover), alt: '', loading: 'lazy', decoding: 'async' })
        : h('span', {}, t('noCoverPhoto')));
    let selectedPhoto = null;
    let selectedCover = null;
    let previewUrl = '';
    let coverPreviewUrl = '';
    let selectionVersion = 0;
    const choosePhoto = h('button', { class: 'pill-btn', type: 'button', onclick: () => {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    } }, t('choosePhoto'));
    const chooseCover = h('button', { class: 'pill-btn', type: 'button', onclick: () => {
      try { openFilePicker(coverInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    } }, t('chooseCoverPhoto'));
    const clearPreview = () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = '';
      photoPreview.replaceChildren(avatar(profile, 72));
    };
    const selectPhoto = async file => {
      if (!file) return;
      const version = ++selectionVersion;
      selectedPhoto = null;
      submit.disabled = true;
      choosePhoto.disabled = true;
      chooseCover.disabled = true;
      clearPreview();
      try {
        await validateProfilePhoto(file);
        if (version !== selectionVersion) return;
        previewUrl = URL.createObjectURL(file);
        selectedPhoto = file;
        photoPreview.replaceChildren(avatar({ ...profile, avatar: previewUrl }, 72));
        message.textContent = '';
      } catch (error) {
        if (version !== selectionVersion) return;
        photoInput.value = '';
        message.textContent = profileText(error?.message) || t('photoUnsupported');
      } finally {
        if (version === selectionVersion) {
          submit.disabled = false;
          choosePhoto.disabled = false;
          chooseCover.disabled = false;
        }
      }
    };
    const clearCoverPreview = () => {
      if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
      coverPreviewUrl = '';
      coverPreview.replaceChildren(profileText(profile.cover)
        ? h('img', { src: profileText(profile.cover), alt: '', loading: 'lazy', decoding: 'async' })
        : h('span', {}, t('noCoverPhoto')));
    };
    const selectCover = async file => {
      if (!file) return;
      const version = ++selectionVersion;
      selectedCover = null;
      submit.disabled = true;
      choosePhoto.disabled = true;
      chooseCover.disabled = true;
      clearCoverPreview();
      try {
        await validateProfilePhoto(file);
        if (version !== selectionVersion) return;
        coverPreviewUrl = URL.createObjectURL(file);
        selectedCover = file;
        coverPreview.replaceChildren(h('img', { src: coverPreviewUrl, alt: '', decoding: 'async' }));
        message.textContent = '';
      } catch (error) {
        if (version !== selectionVersion) return;
        coverInput.value = '';
        message.textContent = profileText(error?.message) || t('photoUnsupported');
      } finally {
        if (version === selectionVersion) {
          submit.disabled = false;
          choosePhoto.disabled = false;
          chooseCover.disabled = false;
        }
      }
    };
    photoInput.addEventListener('change', event => { void selectPhoto(event.currentTarget.files?.[0] || null); });
    coverInput.addEventListener('change', event => { void selectCover(event.currentTarget.files?.[0] || null); });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('save'));
    this.content.replaceChildren(h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      const handle = username.value.trim().replace(/^@/, '');
      const normalizedHandle = handle.toLowerCase();
      const usernameChanged = normalizedHandle !== usernameOriginal;
      if (!handle || (usernameChanged && usernameValidationMessage(normalizedHandle))) {
        message.textContent = usernameValidationMessage(normalizedHandle) || t('usernameRule');
        return;
      }
      if (usernameChanged && cooldownExpiry > Date.now()) {
        paintUsernameCooldown();
        message.textContent = usernameStatus.textContent;
        return;
      }
      if (!auth.userId) { message.textContent = t('signInToContinue'); return; }
      if (submit.disabled) return;
      submit.disabled = true; choosePhoto.disabled = true; chooseCover.disabled = true; photoInput.disabled = true; coverInput.disabled = true;
      message.textContent = selectedPhoto || selectedCover ? t('uploading') : t('loading');
      const uploadedPaths = [];
      try {
        const sb = await supabase();
        if (usernameChanged && !(await usernameAvailable(sb, normalizedHandle, auth.userId))) {
          message.textContent = t('usernameTaken');
          submit.disabled = false; choosePhoto.disabled = false; chooseCover.disabled = false; photoInput.disabled = false; coverInput.disabled = false;
          return;
        }
        let avatarUrl;
        let coverUrl;
        if (selectedPhoto) {
          const optimized = await optimizeImage(selectedPhoto);
          selectedPhoto = optimized.full;
          const photoInfo = await identifyMediaFile(selectedPhoto);
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(photoInfo.type)) throw new Error(t('photoUnsupported'));
          if (selectedPhoto.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
          const extension = photoInfo.extension;
          const uploadedPath = `milkyway/${auth.userId}/avatars/${crypto.randomUUID()}.${extension}`;
          const { error: uploadError } = await sb.storage.from('portfolio').upload(uploadedPath, selectedPhoto, {
            contentType: photoInfo.type,
            cacheControl: '3600',
            upsert: false,
          });
          if (uploadError) throw uploadError;
          uploadedPaths.push(uploadedPath);
          const result = sb.storage.from('portfolio').getPublicUrl(uploadedPath);
          avatarUrl = result?.data?.publicUrl;
          if (!avatarUrl) throw new Error(t('photoUploadFailed'));
        }
        if (selectedCover) {
          const optimized = await optimizeImage(selectedCover);
          selectedCover = optimized.full;
          const coverInfo = await identifyMediaFile(selectedCover);
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(coverInfo.type)) throw new Error(t('photoUnsupported'));
          if (selectedCover.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
          const coverPath = `milkyway/${auth.userId}/covers/${crypto.randomUUID()}.${coverInfo.extension}`;
          const { error: uploadError } = await sb.storage.from('portfolio').upload(coverPath, selectedCover, {
            contentType: coverInfo.type,
            cacheControl: '3600',
            upsert: false,
          });
          if (uploadError) throw uploadError;
          uploadedPaths.push(coverPath);
          const result = sb.storage.from('portfolio').getPublicUrl(coverPath);
          coverUrl = result?.data?.publicUrl;
          if (!coverUrl) throw new Error(t('photoUploadFailed'));
        }
        const changes = { display_name: name.value.trim(), username: normalizedHandle, bio: bio.value.trim() || null };
        if (avatarUrl) changes.avatar_url = avatarUrl;
        if (coverUrl) changes.cover_url = coverUrl;
        let coverColumnAvailable = true;
        let saveResult = await sb.from('mw_profiles').update(changes).eq('id', auth.userId)
          .select('id,display_name,username,avatar_url,cover_url').maybeSingle();
        if (saveResult.error && missingProfileColumn(saveResult.error, ['cover_url']) === 'cover_url') {
          coverColumnAvailable = false;
          const compatibleChanges = { ...changes };
          delete compatibleChanges.cover_url;
          saveResult = await sb.from('mw_profiles').update(compatibleChanges).eq('id', auth.userId)
            .select('id,display_name,username,avatar_url').maybeSingle();
          if (!saveResult.error) cacheCover(auth.userId, coverUrl || profileText(profile.cover));
        }
        const { data: saved, error } = saveResult;
        if (error) throw error;
        if (!saved) throw new Error(t('profileSettingsUnavailable'));
        if (avatarUrl && saved.avatar_url !== avatarUrl) throw new Error(t('profileSettingsUnavailable'));
        if (coverUrl && coverColumnAvailable && saved.cover_url !== coverUrl) throw new Error(t('profileSettingsUnavailable'));
        if (coverUrl && coverColumnAvailable) cacheCover(auth.userId, '');
        const updatedProfile = {
          id: saved.id,
          name: saved.display_name || name.value.trim(),
          username: saved.username || '',
          avatar: saved.avatar_url || '',
          cover: saved.cover_url || cachedCover(auth.userId),
        };
        profiles.update(updatedProfile);
        clearInterval(this.usernameCooldownTimer);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
        coverPreviewUrl = '';
        toast('✓');
        this.#load(this.id);
      } catch (error) {
        if (uploadedPaths.length) {
          try {
            const client = await supabase();
            const { error: cleanupError } = await client.storage.from('portfolio').remove(uploadedPaths);
            if (cleanupError) console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
          } catch (cleanupError) {
            console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
          }
        }
        const errorText = profileText(error?.message);
        if (/username.*reserved|reserved.*username/i.test(errorText)) message.textContent = t('usernameReserved');
        else if (/username.*72 hours|change.*72 hours/i.test(errorText)) message.textContent = `${t('usernameCooldownActive')}.`;
        else if (/username.*(duplicate|already exists)|duplicate key/i.test(errorText)) message.textContent = t('usernameTaken');
        else if ([
          t('photoUnsupported'),
          t('photoTooLarge'),
          t('photoUploadFailed'),
          t('profileSettingsUnavailable'),
        ].includes(errorText)) message.textContent = errorText;
        else message.textContent = t('profileSettingsUnavailable');
        submit.disabled = false; choosePhoto.disabled = false; chooseCover.disabled = false; photoInput.disabled = false; coverInput.disabled = false;
      }
    } }, name, username, usernameStatus, bio,
    h('div', { class: 'stack profile-photo-edit' },
      h('label', { class: 'muted' }, t('profilePhoto')),
      photoPreview,
      choosePhoto,
      photoInput,
      h('label', { class: 'muted' }, t('coverPhoto')),
      coverPreview,
      chooseCover,
      coverInput),
    submit, message,
    h('button', { class: 'link center', type: 'button', onclick: () => { clearInterval(this.usernameCooldownTimer); selectionVersion++; selectedPhoto = null; selectedCover = null; clearPreview(); clearCoverPreview(); this.#load(this.id); } }, t('cancel'))));
    if (initialPhoto) void selectPhoto(initialPhoto);
    else if (openPicker) {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    } else if (openCoverPicker) {
      try { openFilePicker(coverInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    }
  }

}

function tile(post, { open, menu }) {
  const kind = postKind(post);
  const url = typeof post?.media_url === 'string' ? post.media_url : '';
  const caption = profileText(post?.caption) || profileText(post?.title) || profileText(post?.category) || t('post');
  const node = h('div', { class: `profile-tile ${kind}`, role: 'button', tabindex: '0', 'data-post': String(post?.id || ''), 'aria-label': caption || t('post') });
  if (kind === 'video') {
    const still = /\/storage\/v1\/object\/public\//i.test(url) ? `${url}.poster.jpg` : '';
    if (still) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      setProfileTileImage(img, still, () => { img.remove(); node.classList.add('missing'); });
      node.append(img);
    } else {
      node.classList.add('missing');
      node.append(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '▶'));
    }
    node.append(h('span', { class: 'tile-badge', html: icon.play, 'aria-hidden': 'true' }));
  } else if (kind === 'image') {
    const img = h('img', { alt: caption, loading: 'lazy', decoding: 'async', draggable: 'false' });
    const preview = post.public_post ? url : Array.isArray(post.media_preview_items) ? post.media_preview_items[0] || url : url;
    setProfileTileImage(img, preview, () => { node.classList.add('missing'); img.remove(); node.prepend(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '🖼')); });
    node.append(img);
  } else {
    node.append(h('p', {}, caption.slice(0, 140)));
  }
  const rawViews = post?.view_count ?? post?.viewCount ?? post?.views;
  const views = Number(rawViews);
  if (rawViews !== undefined && rawViews !== null && rawViews !== '' && Number.isFinite(views) && views >= 0) {
    node.append(h('span', { class: 'tile-badge tile-views', 'aria-label': `${count(views)} ${t('viewCount')}` },
      h('span', { html: icon.eye }), count(views)));
  }
  if (post.scheduled_at && Date.parse(post.scheduled_at) > Date.now()) {
    node.append(h('span', { class: 'mw-profile-scheduled' }, t('studioScheduled')));
  }
  if (menu) {
    if (!post.public_post) node.append(h('button', { class: 'tile-more', type: 'button', 'aria-label': t('postOptions'), onclick: event => { event.stopPropagation(); menu(); } }, '⋯'));
  }
  node.addEventListener('click', open);
  node.addEventListener('keydown', event => {
    if (event.target !== node) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
  return node;
}

function setProfileTileImage(img, url, onFail) {
  if (!url) { onFail?.(); return; }
  img.onerror = () => {
    img.onerror = null;
    onFail?.();
  };
  img.src = url;
}
