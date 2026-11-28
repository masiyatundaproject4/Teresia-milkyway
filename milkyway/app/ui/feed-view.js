// Feed view: full-screen vertical short-video feed on top of VerticalPager + playback manager.
//  - 3–5 slides in the DOM, recycled; video sources only on the active slide and its neighbours.
//  - Renders the device copy instantly, then merges background refreshes without moving the user.
//  - Double-tap to like (with burst), tap to pause / unmute (videos) or open full size (photos),
//    rail: profile+follow, like, comments, save, gift, share.
import { config } from '../config.js';
import { auth, supabase } from '../core/net.js';
import { bus, idle } from '../core/events.js';
import { device } from '../core/device.js';
import { setImage, poster, mediaKind, TRANSPARENT_VIDEO_POSTER } from '../core/media.js';
import { t } from '../core/i18n.js';
import { feed, actions, deletedPosts, watchPosts } from '../data/feed.js';
import { profiles } from '../data/profiles.js';
import { VerticalPager } from './pager.js';
import { playback } from './playback.js';
import { h, icon, count, toast, paintAvatar, brandMark, avatar, mediaPlaceholder } from './dom.js';
import { loadAds, loadSuggestions, weave, adImpression, adClick, dismissAd } from '../data/promoted.js';
import { openShare } from './share-sheet.js';

const DOUBLE_TAP_MS = 260;
const displayText = value => {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (/^(?:null|undefined)$/i.test(cleaned)) return '';
  return cleaned.replace(/\b(?:null|undefined)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
};

export class FeedView {
  constructor(root, { requireLogin, openComments, openGifts, openProfile, openFollowers, openPost }) {
    this.root = root;
    this.hooks = { requireLogin, openComments, openGifts, openProfile, openFollowers, openPost };
    this.scope = null;
    this.unsubscribe = null;
    this.interacted = false;
    this.status = h('div', { class: 'feed-status', hidden: true });
    this.surface = h('div', { class: 'feed-pager', tabindex: '0', 'aria-roledescription': 'carousel', 'aria-label': 'Feed' });
    root.append(this.surface, this.status);

    this.pager = new VerticalPager(this.surface, {
      radius: device.windowRadius,
      keyOf: post => post.id,
      create: () => this.#createSlide(),
      bind: (slide, post) => this.#bind(slide, post),
      update: (slide, post) => this.#paintCounts(slide, post),
      release: slide => this.#release(slide),
      afterRender: mounted => this.#sources(mounted),
      onChange: index => {
        if (index > 0) this.interacted = true;
        const item = this.pager.items[index];
        this.#trackView(item);
        if (item?.kind === 'ad') adImpression(item.ad);
      },
      onNearEnd: () => this.source?.more(),
      onHorizontalSwipe: (direction, post) => {
        if (post?.kind || !post?.author?.id) return;
        if (direction === 'left') this.hooks.openProfile(post.author, { fullscreen: true });
        else this.hooks.openFollowers?.(post.author);
      },
    });
    this.#bindEvents();
    playback.onMute(muted => {
      this.root.classList.toggle('is-muted', muted);
      this.pager.mounted.forEach(slide => this.#paintMute(slide, muted));
    });
    this.root.classList.toggle('is-muted', playback.muted);
    bus.on('follow', () => this.pager.mounted.forEach(slide => { this.#paintFollow(slide, slide._post); if (slide._post?.kind === 'suggest') this.#paintSuggest(slide); }));
    this.promo = { ads: [], people: [] };
    this.#loadPromoted();
    bus.on('auth', () => this.#loadPromoted());
  }

  /** Switches feed scope. Cached posts paint immediately. */
  show(scope) {
    idle(() => watchPosts(() => this.scope).catch(error => console.warn('[feed] realtime setup failed', error)), 1800);
    if (scope === this.scope) { this.reload(); return; }
    this.scope = scope;
    this.unsubscribe?.();
    this.interacted = false;
    this.source = feed(scope);
    this.pager.setItems([], { keepKey: false });
    this.#setStatus('loading');
    this.unsubscribe = this.source.source.subscribe(value => this.#apply(value));
    const source = this.source;
    source.load().then(() => source.refresh()).then(() => this.#emptyCheck(source));
  }

  reload() {
    this.interacted = false;
    const source = this.source;
    if (!source) return Promise.resolve();
    this.#setStatus('loading');
    return source.refresh().then(() => this.#emptyCheck(source));
  }
  focus() { this.surface.focus({ preventScroll: true }); }

  // Sponsored ads and friend suggestions load in the background and are woven in once they arrive.
  #loadPromoted() {
    Promise.all([loadAds(), loadSuggestions()]).then(([ads, people]) => {
      this.promo = { ads, people };
      if (this.lastValue) this.#apply(this.lastValue);
    });
  }

  #apply(value) {
    this.lastValue = value;
    const live = post => !post.kind && !deletedPosts.has(post.id);
    const incoming = (value?.posts || []).filter(live);
    const current = this.pager.items.filter(live);
    let items = incoming;
    if (current.length && (this.interacted || this.pager.index > 0)) {
      // The user is mid-feed: update what they have, append what's new at the end — never jump.
      const byId = new Map(incoming.map(post => [post.id, post]));
      const kept = current.map(post => byId.get(post.id) || post);
      const known = new Set(kept.map(post => post.id));
      items = [...kept, ...incoming.filter(post => !known.has(post.id))];
    }
    if (this.scope === 'foryou') items = weave(items, this.promo);
    this.pager.setItems(items);
    if (items.length) this.#setStatus(null);
  }

  #emptyCheck(source = this.source) {
    if (source !== this.source) return;
    if (this.pager.items.length) return this.#setStatus(null);
    if (navigator.onLine === false) return this.#setStatus('offline');
    this.#setStatus(source?.source.error ? 'feedLoadFailed' : this.scope === 'following' ? 'emptyFollowing' : 'empty');
  }

  #trackView(post) {
    const viewerId = auth.userId;
    if (!viewerId || !post?.id || post.kind || post.public_post) return;
    const key = `${viewerId}:${post.id}`;
    this.viewedPosts ||= new Set();
    if (this.viewedPosts.has(key)) return;
    this.viewedPosts.add(key);
    supabase().then(sb => sb.from('mw_post_views')
      .upsert({ post_id: post.id, viewer_id: viewerId }, { onConflict: 'post_id,viewer_id', ignoreDuplicates: true }))
      .then(({ error }) => {
        if (!error) return;
        this.viewedPosts.delete(key);
        console.warn('[feed] post view could not be recorded', error);
      })
      .catch(error => {
        this.viewedPosts.delete(key);
        console.warn('[feed] post view could not be recorded', error);
      });
  }

  #setStatus(kind) {
    this.status.hidden = !kind;
    if (!kind) return;
    if (kind === 'loading') { this.status.replaceChildren(h('div', { class: 'skeleton-slide', 'aria-busy': 'true', 'aria-label': t('loading') }, h('i'), h('b'), h('span'))); return; }
    this.status.replaceChildren(h('div', { class: 'empty-card' },
      h('p', {}, kind === 'offline' ? t('offline') : t(kind)),
      h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.#setStatus('loading'); this.reload(); } }, t('retry'))));
  }

  // ---- Slides ----------------------------------------------------------------------------------------------
  #createSlide() {
    const video = h('video', { poster: TRANSPARENT_VIDEO_POSTER, playsinline: true, 'webkit-playsinline': true, loop: true, muted: true, preload: 'none', disablepictureinpicture: true, disableremoteplayback: true });
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    const slideshowBadge = h('span', { class: 'slideshow-badge', hidden: true, 'aria-hidden': 'true' }, '▧');
    const text = h('div', { class: 'text-card' });
    const paused = h('span', { class: 'paused-badge', html: icon.play, hidden: true });
    const missing = mediaPlaceholder(t('imageUnavailable'));
    missing.hidden = true;
    const media = h('div', { class: 'media', 'data-act': 'media' }, video, img, text, missing, paused, slideshowBadge);
    const avatarNode = h('span', { class: 'avatar' });
    const follow = h('span', { class: 'follow-plus', 'data-act': 'follow', role: 'button', 'aria-label': t('follow'), html: icon.plus });
    const rail = (act, svg, label) => h('button', { class: `rail-btn rail-${act}`, type: 'button', 'data-act': act, 'aria-label': label }, h('span', { class: 'rail-icon', html: svg }), h('b', {}, ''));
    const like = rail('like', icon.heart, 'Like');
    const comment = rail('comment', icon.comment, t('comments'));
    const save = rail('save', icon.bookmark, t('save'));
    const gift = rail('gift', icon.gift, t('gift'));
    const share = rail('share', icon.share, t('share'));
    const name = h('button', { class: 'meta-name', type: 'button', 'data-act': 'profile' });
    const caption = h('p', { class: 'meta-caption', 'data-act': 'caption' });
    const seek = h('input', { class: 'video-seek', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Seek video' });
    const currentTime = h('span', { class: 'video-time', 'aria-live': 'off' }, '0:00');
    const durationTime = h('span', { class: 'video-time', 'aria-live': 'off' }, '0:00');
    const mute = h('button', { class: 'video-mute', type: 'button', 'aria-label': 'Toggle video sound', 'aria-pressed': String(!playback.muted), onclick: event => {
      event.stopPropagation();
      playback.setMuted(!playback.muted);
    } },
    h('span', { class: 'i-muted', html: icon.muted }),
    h('span', { class: 'i-sound', html: icon.sound }));
    const videoControls = h('div', { class: 'video-controls', 'data-act': 'video-controls', 'data-no-swipe': true }, mute, currentTime, seek, durationTime);
    const stopSeekPropagation = event => event.stopPropagation();
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) videoControls.addEventListener(type, stopSeekPropagation);
    seek.addEventListener('input', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration * Number(seek.value) / 1000;
    });
    const seeking = event => {
      if (event.type === 'pointerdown') {
        slide.classList.add('controls-seeking', 'controls-visible');
        clearTimeout(slide._controlsTimer);
      } else {
        slide.classList.remove('controls-seeking');
        this.#showVideoControls(slide);
      }
    };
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'change', 'blur']) seek.addEventListener(type, seeking);
    const formatTime = seconds => {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
      const whole = Math.floor(seconds);
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    };
    const updateSeek = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (document.activeElement !== seek) seek.value = duration ? String(Math.round(video.currentTime / duration * 1000)) : '0';
      currentTime.textContent = formatTime(video.currentTime);
      durationTime.textContent = formatTime(duration);
      seek.setAttribute('aria-valuetext', `${formatTime(video.currentTime)} of ${formatTime(duration)}`);
      seek.style.setProperty('--seek-progress', `${duration ? video.currentTime / duration * 100 : 0}%`);
      seek.disabled = !duration;
    };
    for (const type of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked']) video.addEventListener(type, updateSeek);
    // Sponsored label + call to action (ads) and the "Suggested for you" card; hidden on normal posts.
    const adBar = h('div', { class: 'ad-bar', hidden: true },
      h('div', { class: 'ad-line' }, h('span', { class: 'ad-tag' }, t('sponsored') || 'Sponsored'),
        h('button', { class: 'ad-hide', type: 'button', 'data-act': 'ad-hide', 'aria-label': 'Not interested' }, '✕')),
      h('button', { class: 'ad-cta', type: 'button', 'data-act': 'ad-cta' }, ''));
    const suggest = h('div', { class: 'suggest-card', hidden: true });
    const slide = h('section', { class: 'slide', 'aria-roledescription': 'slide' },
      media, brandMark(), h('div', { class: 'shade', 'aria-hidden': 'true' }),
      h('aside', { class: 'rail' }, h('div', { class: 'rail-author', 'data-act': 'profile' }, avatarNode, follow), like, comment, save, gift, share),
      h('div', { class: 'meta' }, name, caption, adBar), suggest,
      videoControls);
    slide._refs = { video, img, text, paused, missing, slideshowBadge, avatarNode, follow, like, comment, save, gift, share, name, caption, videoControls, mute, seek, currentTime, durationTime, adBar, suggest };
    const imagePointers = new Map();
    let imagePinch = null, imageScale = 1, imageX = 0, imageY = 0, suppressImageClickUntil = 0;
    const paintImageZoom = () => {
      const bounds = media.getBoundingClientRect();
      const fit = slide.dataset.fit === 'cover'
        ? Math.max(bounds.width / (img.naturalWidth || bounds.width), bounds.height / (img.naturalHeight || bounds.height))
        : Math.min(bounds.width / (img.naturalWidth || bounds.width), bounds.height / (img.naturalHeight || bounds.height));
      const maxX = Math.max(0, ((img.naturalWidth || bounds.width) * fit * imageScale - bounds.width) / 2);
      const maxY = Math.max(0, ((img.naturalHeight || bounds.height) * fit * imageScale - bounds.height) / 2);
      imageX = Math.max(-maxX, Math.min(maxX, imageX));
      imageY = Math.max(-maxY, Math.min(maxY, imageY));
      img.style.translate = `${imageX}px ${imageY}px`;
      img.style.scale = String(imageScale);
      media.classList.toggle('image-zoomed', imageScale > 1);
    };
    const resetImageZoom = () => {
      imagePointers.clear();
      imagePinch = null;
      imageScale = 1;
      imageX = imageY = 0;
      img.style.translate = '';
      img.style.scale = '';
      media.classList.remove('image-zoomed');
    };
    media.addEventListener('pointerdown', event => {
      if (event.target !== img || img.hidden || !slide._post || mediaKind(slide._post) !== 'image') return;
      imagePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, prevX: event.clientX, prevY: event.clientY });
      media.setPointerCapture?.(event.pointerId);
      if (imagePointers.size > 1) {
        const points = [...imagePointers.values()];
        imagePinch = {
          distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
          scale: imageScale, x: imageX, y: imageY,
          centerX: (points[0].x + points[1].x) / 2,
          centerY: (points[0].y + points[1].y) / 2,
        };
        suppressImageClickUntil = performance.now() + 500;
        event.preventDefault();
      }
    });
    media.addEventListener('pointermove', event => {
      const point = imagePointers.get(event.pointerId);
      if (!point) return;
      point.x = event.clientX;
      point.y = event.clientY;
      if (imagePinch) {
        const points = [...imagePointers.values()];
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const scale = Math.max(1, Math.min(4, imagePinch.scale * distance / Math.max(1, imagePinch.distance)));
        const centerX = (points[0].x + points[1].x) / 2;
        const centerY = (points[0].y + points[1].y) / 2;
        const bounds = media.getBoundingClientRect();
        const ratio = scale / imagePinch.scale;
        imageScale = scale;
        imageX = imagePinch.x + centerX - imagePinch.centerX + (imagePinch.centerX - bounds.left - bounds.width / 2) * (1 - ratio);
        imageY = imagePinch.y + centerY - imagePinch.centerY + (imagePinch.centerY - bounds.top - bounds.height / 2) * (1 - ratio);
        suppressImageClickUntil = performance.now() + 500;
        paintImageZoom();
        event.preventDefault();
      } else if (imagePointers.size === 1 && imageScale > 1) {
        imageX += point.x - point.prevX;
        imageY += point.y - point.prevY;
        point.prevX = point.x;
        point.prevY = point.y;
        suppressImageClickUntil = performance.now() + 500;
        paintImageZoom();
        event.preventDefault();
      } else {
        point.prevX = point.x;
        point.prevY = point.y;
      }
    });
    const endImagePointer = event => {
      if (!imagePointers.has(event.pointerId)) return;
      if (imagePinch) suppressImageClickUntil = performance.now() + 500;
      imagePointers.delete(event.pointerId);
      if (imagePointers.size < 2) imagePinch = null;
      for (const point of imagePointers.values()) { point.prevX = point.x; point.prevY = point.y; }
    };
    media.addEventListener('pointerup', endImagePointer);
    media.addEventListener('pointercancel', endImagePointer);
    media.addEventListener('click', event => {
      if (performance.now() >= suppressImageClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    slide._refs.resetImageZoom = resetImageZoom;
    // Portrait media fills the screen; landscape media is letterboxed instead of cropped.
    const fit = (w, h) => { if (w && h) slide.dataset.fit = h >= w * 1.2 ? 'cover' : 'contain'; };
    video.addEventListener('loadedmetadata', () => fit(video.videoWidth, video.videoHeight));
    video.addEventListener('error', () => {
      const post = slide._post;
      if (!post || mediaKind(post) !== 'video' || video.getAttribute('src') !== post.media.url) return;
      video.hidden = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      slide._refs.missing.hidden = false;
    });
    img.addEventListener('load', () => fit(img.naturalWidth, img.naturalHeight));
    playback.observe(video);
    return slide;
  }

  #bind(slide, post, index = this.pager.index) {
    slide._post = post;
    const r = slide._refs;
    const type = mediaKind(post);
    slide.dataset.type = type;
    if (post.kind) slide.dataset.kind = post.kind; else delete slide.dataset.kind;
    r.adBar.hidden = post.kind !== 'ad';
    r.suggest.hidden = post.kind !== 'suggest';
    for (const action of [r.like, r.comment, r.save, r.gift, r.share, r.follow]) action.hidden = Boolean(post.public_post);
    r.video.hidden = type !== 'video';
    r.img.hidden = type !== 'image';
    r.text.hidden = type !== 'text';
    r.paused.hidden = true;
    r.videoControls.hidden = type !== 'video';
    slide.classList.remove('controls-visible', 'controls-seeking');
    clearTimeout(slide._controlsTimer);
    r.seek.value = '0';
    r.seek.disabled = true;
    r.currentTime.textContent = '0:00';
    r.durationTime.textContent = '0:00';
    r.seek.style.setProperty('--seek-progress', '0%');
    this.#paintMute(slide, playback.muted);
    r.resetImageZoom();
    r.missing.hidden = true;
    r.slideshowBadge.hidden = (post.media?.items?.length || post.media_items?.length || 0) < 2;
    r.slideshowBadge.textContent = `▧ ${post.media?.items?.length || post.media_items?.length || 0}`;
    delete slide.dataset.fit;
    if (type === 'video') {
      const still = poster(post.media.url, device.mediaWidth);
      r.video.poster = still || TRANSPARENT_VIDEO_POSTER;
    } else r.video.poster = TRANSPARENT_VIDEO_POSTER;
    if (type === 'image') {
      r.img.hidden = false;
      r.img.alt = displayText(post.caption);
      r.img.loading = index === this.pager.index ? 'eager' : 'lazy';
      r.img.decoding = 'async';
      r.img.fetchPriority = index === this.pager.index ? 'high' : 'low';
      const preview = post.media.previewItems?.[0] || post.media.url;
      setImage(r.img, preview, Math.min(720, device.mediaWidth), { quality: device.saveData ? 55 : 66, onFail: () => { if (slide._post !== post) return; r.img.hidden = true; r.missing.hidden = false; } });
    }
    else { r.img.onerror = null; r.img.removeAttribute('src'); }
    r.text.textContent = type === 'text' ? displayText(post.caption) : '';
    paintAvatar(r.avatarNode, post.author, 40);
    const authorName = displayText(post.author.username) || displayText(post.author.name);
    r.name.textContent = authorName ? `@${authorName}` : t('profile');
    r.caption.textContent = type === 'text' ? '' : displayText(post.caption);
    r.caption.classList.remove('open');
    this.#paintCounts(slide, post);
    this.#paintFollow(slide, post);
    if (post.kind === 'ad') {
      r.name.textContent = displayText(post.ad.business) || displayText(post.ad.title);
      r.caption.textContent = [post.ad.title && post.ad.business ? displayText(post.ad.title) : '', displayText(post.ad.description)].filter(Boolean).join(' — ');
      r.adBar.querySelector('.ad-cta').textContent = `${displayText(post.ad.ctaLabel) || t('learnMore') || 'Learn more'} ›`;
      r.adBar.querySelector('.ad-cta').hidden = !post.ad.destination;
    }
    if (post.kind === 'suggest') { r.name.textContent = ''; r.caption.textContent = ''; this.#paintSuggest(slide); }
  }

  #paintSuggest(slide) {
    const people = this.promo.people.filter(person => !profiles.isFollowing(person.id) && !profiles.isRequested(person.id)).slice(0, 6);
    const title = t('suggestedForYou') || 'Suggested for you';
    slide._refs.suggest.replaceChildren(h('b', { class: 'suggest-title' }, title),
      people.length ? h('div', { class: 'suggest-grid' }, ...people.map(person => h('div', { class: 'suggest-person' },
        h('button', { class: 'suggest-face', type: 'button', 'data-act': 'suggest-profile', 'data-uid': person.id }, avatar(person, 64)),
        h('b', {}, displayText(person.name)), h('small', { class: 'muted' }, person.mutual ? `${count(person.mutual)} ${t('followers').toLowerCase()}` : displayText(person.username) ? `@${displayText(person.username)}` : ''),
        h('button', { class: 'pill-btn hot', type: 'button', 'data-act': 'suggest-follow', 'data-uid': person.id }, t('follow')))))
        : h('p', { class: 'muted center' }, '✓'));
  }

  #paintMute(slide, muted) {
    const button = slide._refs?.mute;
    if (!button) return;
    button.classList.toggle('is-muted', muted);
    button.setAttribute('aria-pressed', String(!muted));
  }

  #paintCounts(slide, post) {
    slide._post = post;
    const r = slide._refs;
    r.like.classList.toggle('on', !!post.liked);
    r.like.setAttribute('aria-pressed', String(!!post.liked));
    r.like.querySelector('b').textContent = count(post.likes);
    r.comment.querySelector('b').textContent = count(post.comments);
    r.save.classList.toggle('on', !!post.saved);
    r.save.setAttribute('aria-pressed', String(!!post.saved));
    r.save.querySelector('b').textContent = '';
    r.gift.querySelector('b').textContent = '';
    r.share.querySelector('b').textContent = '';
  }

  #paintFollow(slide, post) {
    if (!post) return;
    if (post.kind) { slide._refs.follow.hidden = true; return; }
    if (post.public_post) { slide._refs.follow.hidden = true; return; }
    const own = post.author.id === auth.userId;
    slide._refs.follow.hidden = own || profiles.isFollowing(post.author.id) || profiles.isRequested(post.author.id);
  }

  #release(slide) {
    clearTimeout(slide._controlsTimer);
    slide.classList.remove('controls-visible', 'controls-seeking');
    playback.source(slide._refs.video, null, 99);
    if (device.lowEnd) slide._refs.img.removeAttribute('src');
  }

  /** Attaches video sources only around the active slide. */
  #sources(mounted) {
    const active = this.pager.index;
    mounted.forEach((slide, index) => {
      const post = slide._post;
      const url = post && mediaKind(post) === 'video' ? post.media.url : null;
      playback.source(slide._refs.video, url, index - active, { saveData: device.saveData || device.slowNetwork });
    });
  }

  #showVideoControls(slide) {
    slide.classList.add('controls-visible');
    clearTimeout(slide._controlsTimer);
    slide._controlsTimer = setTimeout(() => {
      if (!slide._refs.videoControls.contains(document.activeElement) && !slide.classList.contains('controls-seeking')) {
        slide.classList.remove('controls-visible');
      }
    }, 2600);
  }

  // ---- Interaction -----------------------------------------------------------------------------------------
  #bindEvents() {
    let lastTap = 0, tapTimer = 0;
    this.surface.addEventListener('click', event => {
      const target = event.target.closest('[data-act]');
      const slide = event.target.closest('.slide');
      const post = slide?._post;
      if (!target || !post) return;
      const act = target.dataset.act;
      if (post.public_post) {
        if (act === 'media') {
          if (mediaKind(post) === 'video') this.#tap(slide);
          else this.hooks.openPost?.(post);
        }
        return;
      }
      if (post.kind) {
        if (act === 'ad-cta' || (act === 'media' && post.kind === 'ad' && mediaKind(post) !== 'video' && post.ad.destination)) {
          event.stopPropagation();
          adClick(post.ad);
          if (/^https?:\/\//i.test(post.ad.destination || '')) window.open(post.ad.destination, '_blank', 'noopener');
          return;
        }
        if (act === 'ad-hide') {
          event.stopPropagation();
          dismissAd(post.ad);
          this.promo = { ...this.promo, ads: this.promo.ads.filter(ad => ad.id !== post.ad.id) };
          this.pager.next?.();
          setTimeout(() => this.lastValue && this.#apply(this.lastValue), 350);
          return;
        }
        const uid = target.dataset.uid;
        if (act === 'suggest-follow' && uid) { event.stopPropagation(); if (this.hooks.requireLogin()) actions.follow(uid, true).catch(error => toast(displayText(error?.message) || t('retry'))); return; }
        if (act === 'suggest-profile' && uid) { event.stopPropagation(); const person = this.promo.people.find(p => p.id === uid); this.hooks.openProfile(person || { id: uid }); return; }
        if (act === 'media' && mediaKind(post) === 'video') this.#tap(slide);
        return;
      }
      if (act === 'media') {
        const now = event.timeStamp;
        if (now - lastTap < DOUBLE_TAP_MS) {
          clearTimeout(tapTimer); lastTap = 0;
          this.#burst(slide, event.clientX, event.clientY);
          if (!post.liked) this.#like(post, true);
          return;
        }
        lastTap = now;
        tapTimer = setTimeout(() => this.#tap(slide), DOUBLE_TAP_MS);
        return;
      }
      event.stopPropagation();
      if (act === 'like') this.#like(post, !post.liked);
      else if (act === 'save') { if (this.hooks.requireLogin()) actions.save(post, !post.saved).catch(error => this.#actionFailed(error)); }
      else if (act === 'follow') { if (this.hooks.requireLogin()) actions.follow(post.author.id, true).catch(error => toast(displayText(error?.message) || t('retry'))); }
      else if (act === 'comment') this.hooks.openComments(post);
      else if (act === 'gift') { if (this.hooks.requireLogin()) this.hooks.openGifts({ postId: post.id, to: post.author }); }
      else if (act === 'share') this.#share(post);
      else if (act === 'profile') this.hooks.openProfile(post.author);
      else if (act === 'caption') target.classList.toggle('open');
    });
  }

  #tap(slide) {
    const post = slide._post;
    if (!post) return;
    const kind = mediaKind(post);
    // Photos open full size in the post popup with pinch zoom, comments and likes.
    if (kind === 'image') { if (slide._refs.missing.hidden) this.hooks.openPost?.(post); return; }
    if (kind !== 'video') return;
    const video = slide._refs.video;
    this.#showVideoControls(slide);
    if (playback.muted) { playback.setMuted(false); if (video.paused) playback.toggle(video); return; }
    const playing = playback.toggle(video);
    slide._refs.paused.hidden = playing;
  }

  #like(post, on) {
    if (!this.hooks.requireLogin()) return;
    if (navigator.vibrate && on) navigator.vibrate(8);
    actions.like(post, on).then(result => { if (result === 'queued') toast(t('queued')); }).catch(error => this.#actionFailed(error));
  }

  #actionFailed(error) {
    if (error?.status === 401 || !auth.signedIn()) { this.hooks.requireLogin(true); return; }
    toast(displayText(error?.message) || t('retry'));
  }

  #burst(slide, x, y) {
    const rect = slide.getBoundingClientRect();
    const heart = h('span', { class: 'burst', html: icon.heart, style: `left:${x - rect.left}px;top:${y - rect.top}px;--r:${Math.round(Math.random() * 30 - 15)}deg` });
    heart.addEventListener('animationend', () => heart.remove(), { once: true });
    slide.append(heart);
  }

  async #share(post) {
    const url = `${location.origin}/share/${encodeURIComponent(post.id)}`;
    openShare({ title: displayText(post.author?.name) || 'MilkyWay', text: displayText(post.caption).slice(0, 120), url });
  }
}
