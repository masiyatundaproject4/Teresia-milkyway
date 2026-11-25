// Live view: swipe vertically between ongoing Lives (TikTok LIVE feed) and broadcast your own.
//  - VerticalPager virtualizes the list; only the settled slide holds a LiveSession (one WebRTC connection total).
//  - Swiping away disconnects instantly; joining waits ~200 ms of stillness so fast flicks don't open rooms.
//  - Comments, gifts, likes and viewer counts render from LiveSession events; DOM stays capped (40 comments, 24 hearts).
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { config } from '../config.js';
import { lives, watchLives, createSession, endSession } from '../data/live.js';
import { profiles } from '../data/profiles.js';
import { actions } from '../data/feed.js';
import { catalog, giftIcon } from '../data/gifts.js';
import { VerticalPager } from './pager.js';
import { LiveSession } from './live-session.js';
import { loadLiveKit } from '../core/sdk.js';
import { HostControls, InvitePrompt } from './live-controls.js';
import { Sheet } from './sheet.js';
import { openShare } from './share-sheet.js';
import { h, icon, count, toast, paintAvatar, brandMark, avatar, WaitIndicator } from './dom.js';
import { VOICE_PRESETS } from './voice-effects.js';

const JOIN_DELAY = 200;
const MAX_COMMENTS = 40;
const MAX_HEARTS = 24;
const VIEWER_HIDDEN_GRACE_MS = configuredGrace(config.live?.viewerHiddenGraceMs, 60_000);
const HOST_HIDDEN_GRACE_MS = configuredGrace(config.live?.hostHiddenGraceMs, 60_000);
const HOST_IDLE_GRACE_MS = configuredGrace(config.live?.hostIdleGraceMs, 300_000);

function configuredGrace(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1000 ? duration : fallback;
}

const roomMembers = status => Array.isArray(status?.members)
  ? status.members.filter(member => member && typeof member === 'object' && member.userId)
  : [];
const displayName = name => typeof name === 'string' && name.trim() && !/^(null|undefined)$/i.test(name.trim())
  ? name
  : 'MilkyWay';

/** Builds the chrome shared by viewer slides and the host stage. */
function liveChrome({ host = false } = {}) {
  const avatarNode = h('span', { class: 'avatar', style: '--s:34px' });
  const name = h('b', { class: 'live-host-name' });
  const follow = h('button', { class: 'live-follow', type: 'button', 'data-act': 'follow' }, t('follow'));
  const viewers = h(host ? 'button' : 'span', {
    class: 'live-viewers', 'aria-label': t('viewersTitle'), title: t('viewersTitle'),
    ...(host ? { type: 'button', 'data-act': 'viewers' } : { role: 'status', 'aria-live': 'polite' }),
  }, h('span', { html: icon.eye }), h('b', {}, '0'));
  const close = h('button', { class: 'icon-btn live-close', type: 'button', 'data-act': host ? 'end' : 'close', 'aria-label': host ? t('end') : t('close'), html: host ? icon.power : icon.close });
  const cover = h('div', { class: 'live-cover' }, h('span', { class: 'avatar live-cover-avatar', style: '--s:96px' }), h('p', { class: 'live-cover-title' }), h('span', { class: 'live-badge' }, t('live')));
  const background = h('div', { class: 'live-host-background', hidden: true, 'aria-hidden': 'true' },
    h('img', { class: 'live-host-background-image', alt: '', hidden: true }),
    h('video', { class: 'live-host-background-video', muted: true, loop: true, playsinline: true, preload: 'metadata', hidden: true }));
  const stage = h('div', { class: 'live-stage' });
  const guests = h('div', { class: 'live-guests' });
  // Host cell + allocated guest seats share one grid, including seats that have not been filled yet.
  const hostLabel = h('span', { class: 'live-cell-name' });
  if (host) hostLabel.dataset.role = t('host');
  const hostCell = h('div', { class: 'live-host-cell' }, background, cover, stage, hostLabel);
  const grid = h('div', { class: 'live-grid', 'data-tiles': '1' }, hostCell, guests);
  // Host only: real-time list of viewers asking to join, with one-tap Approve / Reject.
  const requests = h('div', { class: 'live-requests', hidden: true, 'data-no-swipe': true, 'aria-live': 'polite' });
  const pinned = h('div', { class: 'live-pinned', hidden: true });
  const comments = h('div', { class: 'live-comments', 'aria-live': 'polite' });
  const hearts = h('div', { class: 'live-hearts', 'aria-hidden': 'true' });
  const banner = h('div', { class: 'live-gift-banner', 'aria-live': 'polite' });
  const state = h('div', { class: 'live-state', hidden: true });
  const resting = h('div', { class: 'live-resting', hidden: true, role: 'status', 'aria-live': 'polite' },
    h('div', {
      class: 'live-resting-art',
      'aria-hidden': 'true',
      html: '<svg viewBox="0 0 240 180" focusable="false"><defs><radialGradient id="live-rest-glow"><stop stop-color="#c4b5fd" stop-opacity=".85"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient><linearGradient id="live-rest-planet" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#c4b5fd"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><circle cx="120" cy="89" r="67" fill="url(#live-rest-glow)"/><g fill="none" stroke="#c4b5fd" stroke-opacity=".72"><ellipse cx="120" cy="88" rx="91" ry="31" transform="rotate(-20 120 88)"/><ellipse cx="120" cy="88" rx="73" ry="23" transform="rotate(32 120 88)"/></g><circle cx="120" cy="83" r="30" fill="url(#live-rest-planet)"/><path d="M92 88c15 8 40 8 56 0M101 69c13 7 27 7 39 0" fill="none" stroke="#ede9fe" stroke-opacity=".6" stroke-width="3"/><g fill="#fff"><circle cx="35" cy="48" r="2"/><circle cx="197" cy="40" r="2"/><circle cx="207" cy="125" r="1.8"/><circle cx="53" cy="134" r="1.5"/><circle cx="160" cy="20" r="1.5"/><circle cx="82" cy="25" r="1.2"/></g><g fill="none" stroke="#67e8f9" stroke-linecap="round" stroke-width="3"><path d="M37 89c5-11 11-11 16 0s11 11 16 0"/><path d="M171 89c5-11 11-11 16 0s11 11 16 0"/></g><path d="M107 126v9a13 13 0 0 0 26 0v-9" fill="none" stroke="#a5f3fc" stroke-linecap="round" stroke-width="4"/></svg>',
    }),
    h('b', { class: 'live-resting-title' }, t('liveResting')),
    h('span', { class: 'live-resting-message' }, t('liveRadioContinues')));
  const input = h('input', { class: 'live-input', type: 'text', maxlength: '300', placeholder: t('sayHi'), enterkeyhint: 'send', 'aria-label': t('sayHi') });
  const form = h('form', { class: 'live-form', 'data-no-swipe': true }, input);
  // Stream controls: always visible for the host, shown to a viewer while they are a guest on stage.
  const micBtn = h('button', { class: 'icon-btn', type: 'button', 'data-act': 'mic', 'aria-label': t('microphone'), title: t('microphone'), html: icon.mic });
  const voiceBtn = h('button', { class: 'icon-btn live-voice-btn', type: 'button', 'data-act': 'voice', 'aria-label': t('voiceChanger'), title: t('voiceChanger'), html: '♫' });
  const camBtn = h('button', { class: 'icon-btn live-video-only', type: 'button', 'data-act': 'cam', 'aria-label': t('camera'), title: t('camera'), html: icon.camera });
  const tools = h('div', { class: `live-tools${host ? ' live-bottom-tools' : ''}`, 'data-no-swipe': true },
    h('button', { class: 'icon-btn live-video-only', type: 'button', 'data-act': 'flip', 'aria-label': t('flipCamera'), title: t('flipCamera'), html: icon.flip }),
    voiceBtn, micBtn, camBtn,
    host ? null : h('button', { class: 'icon-btn leave', type: 'button', 'data-act': 'leave-stage', 'aria-label': t('leaveStage'), title: t('leaveStage'), html: icon.leave }));
  const guestsBadge = h('span', { class: 'live-badge-count', hidden: true });
  const seatCount = h('span', { class: 'live-seat-count', hidden: true, 'aria-live': 'polite' });
  // Viewers: a labelled pill in the bottom bar so joining as a guest is always obvious
  // (Request to join → Requested → on stage). It is never replaced by a view-only layout.
  const stageLabel = h('span', { class: 'stage-label' }, t('requestJoin'));
  const stageBtn = h('button', { class: 'live-join-btn', type: 'button', 'data-act': 'stage', 'data-no-swipe': true, 'aria-label': t('requestJoin'), title: t('requestJoin') },
    h('span', { class: 'stage-icon', html: icon.guests, 'aria-hidden': 'true' }), stageLabel);
  const entryChoice = host ? null : h('aside', { class: 'live-entry-choice', hidden: true, 'data-no-swipe': true },
    h('div', {}, h('strong', {}, t('liveWatchChoice')), h('small', {}, t('viewers'), ': ', h('b', { class: 'live-entry-choice-count' }, '–'))),
    h('button', { class: 'live-entry-choice-request', type: 'button', 'data-act': 'stage' }, t('requestJoin')),
    h('button', { class: 'live-entry-choice-watch', type: 'button', 'data-act': 'watch' }, t('liveContinueWatching')));
  const giftBtn = h('button', { class: 'icon-btn gift', type: 'button', 'data-act': 'gift', 'data-no-swipe': true, 'aria-label': t('gift'), title: t('gift'), html: icon.gift });
  const likeBtn = h('button', { class: 'icon-btn like', type: 'button', 'data-act': 'like', 'aria-label': 'Like', html: icon.heart });
  const bar = h('div', { class: 'live-bar' }, ...(host ? [tools, form] : [form]),
    ...(host ? [] : [stageBtn, giftBtn, likeBtn,
      h('button', { class: 'icon-btn', type: 'button', 'data-act': 'share', 'aria-label': t('share'), html: icon.share })]));
  const hostAction = (act, label, symbol, attributes = {}) => h('button', {
    class: 'live-host-action', type: 'button', 'data-act': act, 'aria-label': label, ...attributes,
  }, h('span', { 'aria-hidden': 'true', ...(symbol.startsWith('<svg') ? { html: symbol } : {}) }, symbol.startsWith('<svg') ? '' : symbol),
  h('small', {}, label));
  const hostActions = host ? h('nav', { class: 'live-host-actions', 'data-no-swipe': true, 'aria-label': t('liveControls') },
    hostAction('voice', t('effects'), '✦'),
    h('div', { class: 'live-host-guests-action' }, hostAction('multi-guest', t('multiGuest'), icon.guests), seatCount, guestsBadge),
    hostAction('comments-toggle', t('comments2'), '▤', { 'aria-pressed': 'false' }),
    hostAction('share', t('share'), icon.share),
    hostAction('beautify', t('beautify'), '✧', { 'aria-pressed': 'false' }),
    hostAction('settings', t('moreOptions'), '···')) : null;
  const hostNotices = host ? h('aside', { class: 'live-host-notices' },
    h('button', { class: 'live-guideline', type: 'button', 'data-act': 'moderation' }, 'ⓘ ', t('liveGuidelines')),
    h('div', { class: 'live-viewer-notice' }, h('span', {}, t('liveViewerNotice')),
      h('button', { type: 'button', 'aria-label': t('dismiss'), onclick: event => event.currentTarget.parentElement.remove() }, '×'))) : null;
  const top = h('div', { class: 'live-top' },
    h('div', { class: 'live-host', 'data-act': 'profile' }, avatarNode, h('div', {}, name, h('small', { class: 'live-tag' }, t('live'))), host ? null : follow),
    viewers, close);
  const node = h('section', { class: 'slide live-slide' }, grid, brandMark('live'), h('div', { class: 'shade' }), resting, top, host ? null : tools, entryChoice, pinned, comments, hearts, banner, state, host ? requests : null, hostNotices, hostActions, bar);
  node._refs = { avatarNode, name, follow, viewers: viewers.querySelector('b'), viewersWrap: viewers, cover, background, stage, guests, grid, hostLabel, requests, pinned, comments, hearts, banner, state, resting, input, form, tools, micBtn, voiceBtn, camBtn, stageBtn, stageLabel, entryChoice, choiceCount: entryChoice?.querySelector('.live-entry-choice-count'), giftBtn, likeBtn, guestsBadge, seatCount };
  // Re-arrange the grid whenever a guest tile appears or leaves (tiles come from both room status and video tracks).
  new MutationObserver(() => layoutGrid(node)).observe(guests, { childList: true });
  return node;
}

/** Sizes the video grid to the number of people on stage: 1 = full screen, 2 = side by side, 3 = host + 2 stacked,
 *  4 = 2×2, 5–6 = 3×2, 7–9 = 3×3, 10+ = 4 columns. Audio LIVEs keep their avatar seats.
 *  The slide carries the same count so the comments and pinned comment sit below the grid instead of over faces. */
function layoutGrid(slide) {
  const r = slide._refs;
  const tiles = String(Math.min(1 + r.guests.childElementCount, 10));
  if (r.grid.dataset.tiles !== tiles) r.grid.dataset.tiles = tiles;
  if (slide.dataset.tiles !== tiles) slide.dataset.tiles = tiles;
  r.grid.style.setProperty('--side-tiles', String(Math.max(4, r.guests.childElementCount)));
  slide.classList.toggle('has-guests', tiles !== '1');
}

function paintLive(slide, live) {
  const r = slide._refs;
  slide._live = live;
  paintAvatar(r.avatarNode, live.host, 34);
  paintAvatar(r.cover.querySelector('.live-cover-avatar'), live.host, 96);
  const hostName = displayName(live.host.name);
  r.name.textContent = hostName;
  r.hostLabel.textContent = hostName;
  r.cover.querySelector('.live-cover-title').textContent = live.title || '';
  r.follow.hidden = live.host.id === auth.userId || profiles.isFollowing(live.host.id);
  r.viewers.textContent = '–';
  slide.classList.toggle('audio-live', live.mode === 'audio');
}

function resetStage(slide) {
  const r = slide._refs;
  r.stage.replaceChildren(); r.guests.replaceChildren(); r.comments.replaceChildren(); r.hearts.replaceChildren(); r.banner.replaceChildren();
  r.background.querySelector('img').removeAttribute('src');
  r.background.querySelector('video').pause();
  r.background.querySelector('video').removeAttribute('src');
  r.background.querySelector('video').load();
  r.background.hidden = true;
  r.background.querySelectorAll('img,video').forEach(element => { element.hidden = true; });
  r.state.hidden = true;
  r.cover.hidden = false;
  r.pinned.hidden = true;
  r.stageBtn.hidden = false;
  r.stageBtn.disabled = false;
  r.stageBtn.className = 'live-join-btn';
  r.stageLabel.textContent = t('requestJoin');
  r.stageBtn.setAttribute('aria-label', t('requestJoin'));
  r.stageBtn.title = t('requestJoin');
  if (r.entryChoice) {
    r.entryChoice.hidden = true;
    r.choiceCount.textContent = '–';
  }
  r.grid.dataset.tiles = '1';
  r.grid.dataset.layout = 'fullscreen';
  slide.dataset.layout = 'fullscreen';
  slide.dataset.tiles = '1';
  slide.classList.remove('has-guests');
  r.requests.hidden = true;
  r.requests.replaceChildren();
  slide._lastSelf = null;
  slide._selfCancelled = false;
  r.input.disabled = false;
  r.input.placeholder = t('sayHi');
  r.viewersWrap.hidden = false;
  slide.classList.remove('has-video', 'has-host-background', 'on-stage');
  slide.classList.toggle('can-request', !slide.classList.contains('host-stage'));
}

const cssId = value => String(value).replace(/[^a-z0-9-]/gi, '');

/** One box per guest on stage: their video (or avatar in audio Lives / camera off) with name and mic state. */
function guestTile(slide, userId, name = '') {
  const r = slide._refs;
  let tile = r.guests.querySelector(`[data-uid="${cssId(userId)}"]`);
  if (!tile) {
    // The host gets one-tap controls on every guest box: mute / allow mic, move back to the audience, remove from LIVE.
    const hostTools = slide.classList.contains('host-stage')
      ? h('div', { class: 'live-guest-tools', 'data-no-swipe': true },
          h('button', { class: 'live-guest-btn', type: 'button', 'data-act': 'guest-mute', 'data-uid': userId, 'aria-label': t('muteMic'), title: t('muteMic'), html: icon.mic }),
          h('button', { class: 'live-guest-btn', type: 'button', 'data-act': 'guest-remove', 'data-uid': userId, 'aria-label': t('removeFromStage'), title: t('removeFromStage'), html: icon.leave }),
          h('button', { class: 'live-guest-btn danger', type: 'button', 'data-act': 'guest-kick', 'data-uid': userId, 'aria-label': t('removeFromLive'), title: t('removeFromLive'), html: icon.close }))
      : null;
    tile = h('div', { class: 'live-guest', 'data-uid': cssId(userId), 'data-act': 'guest' },
      h('span', { class: 'avatar live-guest-avatar', style: '--s:44px' }),
      h('span', { class: 'live-guest-name' }, displayName(name)),
      h('span', { class: 'live-guest-mic', html: icon.muted, hidden: true }),
      hostTools);
    paintAvatar(tile.querySelector('.avatar'), { name }, 44);
    r.guests.append(tile);
  }
  return tile;
}

/** Applies a room status (settings, stage, self) to a slide. */
function applyRoom(slide, session, status) {
  const r = slide._refs;
  const settings = status.settings || {};
  const self = status.self || {};
  const host = session.host;
  const layoutStyle = settings.layoutStyle === 'featured' ? 'featured' : 'fullscreen';
  r.grid.dataset.layout = layoutStyle;
  slide.dataset.layout = layoutStyle;
  paintHostBackground(slide, settings);

  // Pinned comment
  r.pinned.hidden = !settings.pinned;
  if (settings.pinned) {
    r.pinned.replaceChildren(h('span', { html: icon.pin }), h('b', {}, settings.pinned.name || 'MilkyWay'), ' ', settings.pinned.body,
      host ? h('button', { class: 'live-unpin', type: 'button', 'data-act': 'unpin', 'aria-label': t('unpinComment'), html: icon.close }) : null);
  }

  function paintHostBackground(slide, settings) {
    const layer = slide._refs.background;
    const image = layer.querySelector('img');
    const video = layer.querySelector('video');
    const url = typeof settings.hostBackground === 'string' ? settings.hostBackground : '';
    const kind = settings.hostBackgroundKind === 'video' ? 'video' : 'image';
    layer.hidden = !url;
    image.hidden = !url || kind !== 'image';
    video.hidden = !url || kind !== 'video';
    slide.classList.toggle('has-host-background', !!url);
    if (!url) {
      image.removeAttribute('src');
      video.pause();
      video.removeAttribute('src');
      video.load();
      return;
    }
    if (kind === 'image' && image.src !== url) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      image.src = url;
      image.onerror = () => { if (slide.classList.contains('host-stage')) toast(t('backgroundUnavailable')); };
    }
    if (kind === 'video' && video.src !== url) {
      image.removeAttribute('src');
      video.src = url;
      video.onerror = () => { if (slide.classList.contains('host-stage')) toast(t('backgroundUnavailable')); };
      video.play().catch(error => {
        if (error?.name !== 'NotAllowedError' && slide.classList.contains('host-stage')) toast(t('backgroundUnavailable'));
      });
    }
  }

  // Audience controls
  if (!host) {
    r.viewersWrap.hidden = settings.showViewerCount === false;
    r.giftBtn.hidden = settings.giftsEnabled === false;
    r.likeBtn.hidden = settings.likesEnabled === false;
    const blockedNote = settings.comments === 'off' ? t('commentsOffNote') : self.commentMuted ? t('mutedNote') : '';
    r.input.disabled = !!blockedNote;
    r.input.placeholder = blockedNote || (settings.slowMode ? `${t('sayHi')} · ${t('slowMode')} ${settings.slowMode}${t('seconds')}` : t('sayHi'));
    paintStageButton(slide, session);
    // Host decisions about this viewer, read from the server record.
    const was = slide._lastSelf;
    if (was?.state === 'pending' && self.state === 'viewer' && !slide._selfCancelled) toast(t('requestDeclined'));
    if (was?.state === 'speaker' && self.state === 'viewer' && !slide._selfCancelled) toast(t('movedToAudience'));
    if (was?.state === 'speaker' && self.state === 'speaker' && !was.hostMuted && self.hostMuted) toast(t('guestMutedByHost'));
    if (was?.state === 'speaker' && self.state === 'speaker' && was.hostMuted && !self.hostMuted) toast(t('hostAllowedMic'));
    if (self.state !== 'pending' && self.state !== 'speaker') slide._selfCancelled = false;
    slide._lastSelf = { state: self.state, hostMuted: !!self.hostMuted };
    paintMedia(slide, session.media);
  } else {
    const members = roomMembers(status);
    const waiting = members.filter(member => member.state === 'pending' && !member.invited).length;
    r.guestsBadge.hidden = !waiting;
    r.guestsBadge.textContent = String(waiting);
    renderRequests(slide, session, status);
  }

  // Guest boxes
  const speakers = roomMembers(status).filter(member => member.state === 'speaker');
  const guestSeats = settings.showGuestSlots ? Math.max(0, Math.min(8, Number(settings.layout || 9) - 1)) : 0;
  r.seatCount.hidden = !host || !settings.showGuestSlots;
  r.seatCount.textContent = `${speakers.length}/${guestSeats}`;
  const orderedTiles = [];
  for (const member of speakers) {
    const tile = guestTile(slide, member.userId, member.name);
    tile.querySelector('.live-guest-name').textContent = member.userId === auth.userId ? t('youAreOnStage') : displayName(member.name);
    paintAvatar(tile.querySelector('.avatar'), member, 44);
    tile.querySelector('.live-guest-mic').hidden = !member.hostMuted;
    const muteBtn = tile.querySelector('[data-act="guest-mute"]');
    if (muteBtn) {
      const label = member.hostMuted ? t('unmuteMic') : t('muteMic');
      muteBtn.innerHTML = member.hostMuted ? icon.muted : icon.mic;
      muteBtn.classList.toggle('off', !!member.hostMuted);
      muteBtn.setAttribute('aria-label', label); muteBtn.title = label;
    }
    tile._member = member;
    orderedTiles.push(tile);
  }
  for (let seat = 1; seat <= guestSeats; seat++) {
    if (speakers[seat - 1]) continue;
    let placeholder = r.guests.querySelector(`[data-seat="${seat}"]`);
    if (!placeholder) {
      const label = host ? t('invite') : t('requestJoin');
      const unavailable = !host && (session.stage === 'joining' || session.stage === 'guest'
        || session.settings.admission === 'broadcast' || session.settings.allowRequests === false);
      placeholder = h('button', {
        class: 'live-guest live-guest-slot', type: 'button', role: 'listitem', 'data-seat': seat,
        'data-act': host ? 'guests' : 'stage', 'data-no-swipe': true, 'aria-label': `${label} · ${t('seats')} ${seat}`,
        title: label, disabled: unavailable,
      }, h('span', { class: 'live-slot-plus', 'aria-hidden': 'true' }, '+'),
      h('span', { class: 'live-guest-name' }, label));
    }
    if (!host) placeholder.disabled = session.stage === 'joining' || session.stage === 'guest'
      || session.settings.admission === 'broadcast' || session.settings.allowRequests === false;
    orderedTiles.push(placeholder);
  }
  for (const tile of [...r.guests.children]) {
    if (!orderedTiles.includes(tile)) tile.remove();
  }
  orderedTiles.forEach((tile, index) => {
    if (r.guests.children[index] !== tile) r.guests.insertBefore(tile, r.guests.children[index] || null);
  });
  layoutGrid(slide);
}

/** Viewer's join button, from the session's stage state:
 *  audience → "Request to join", requested → "Requested · tap to cancel", invited → "Join as guest",
 *  joining → "Joining…" (approved, rights arriving), guest → hidden (the guest controls take over). */
function paintStageButton(slide, session) {
  const r = slide._refs;
  if (session.host) return;
  const stage = session.stage;
  const label = stage === 'requested' ? t('requested') : stage === 'invited' ? t('joinAsGuest') : stage === 'joining' ? t('joiningStage') : t('requestJoin');
  r.stageBtn.hidden = stage === 'guest';
  r.stageBtn.disabled = stage === 'joining' || !!session.stageAction;
  r.stageBtn.classList.toggle('pending', stage === 'requested' || stage === 'joining');
  r.stageBtn.classList.toggle('invited', stage === 'invited');
  r.stageBtn.classList.remove('closed');
  r.stageBtn.setAttribute('aria-pressed', String(stage === 'requested'));
  r.stageLabel.textContent = label;
  r.stageBtn.setAttribute('aria-label', label);
  r.stageBtn.title = label;
  if (r.entryChoice && stage !== 'audience') r.entryChoice.hidden = true;
  slide.classList.toggle('can-request', !r.stageBtn.hidden);
  slide.classList.toggle('on-stage', stage === 'guest');
}

/** Mic / camera buttons of the host or a guest on stage, from the real LiveKit track state. */
function paintMedia(slide, media) {
  const r = slide._refs;
  if (!media) return;
  const micLabel = media.hostMuted ? t('guestMutedByHost') : media.mic ? t('muteMyMic') : t('unmuteMyMic');
  r.micBtn.classList.toggle('off', !media.mic);
  r.micBtn.classList.toggle('locked', !!media.hostMuted);
  r.micBtn.innerHTML = media.mic ? icon.mic : icon.muted;
  r.micBtn.setAttribute('aria-pressed', String(!media.mic));
  r.micBtn.setAttribute('aria-label', micLabel); r.micBtn.title = micLabel;
  const camLabel = media.camera ? t('cameraOffAction') : t('cameraOnAction');
  r.camBtn.classList.toggle('off', !media.camera);
  r.camBtn.setAttribute('aria-pressed', String(!media.camera));
  r.camBtn.setAttribute('aria-label', camLabel); r.camBtn.title = camLabel;
}

const REQUESTS_SHOWN = 3;
function handleRequestAction(slide, session, action, userId, button) {
  const busy = slide._approving ||= new Set();
  if (!userId || busy.has(userId)) return;
  busy.add(userId);
  button.closest('.live-request')?.querySelectorAll('button').forEach(node => { node.disabled = true; });
  session.control(action, { target: userId })
    .then(() => { if (action === 'approve') toast(t('guestApproved')); })
    .catch(error => toast(error?.message || t('liveUnavailable')))
    .finally(() => { busy.delete(userId); if (session.status) applyRoom(slide, session, session.status); });
}

/** Host: the waiting list on screen. Each row has Approve (promotes the viewer to publisher) and Reject. */
function renderRequests(slide, session, status) {
  const r = slide._refs;
  const settings = status?.settings || {};
  const members = roomMembers(status);
  const pending = members.filter(member => member.state === 'pending' && !member.invited && !member.blocked);
  r.requests.hidden = !pending.length;
  if (!pending.length) { r.requests.replaceChildren(); return; }
  const busy = slide._approving || new Set();
  const seats = Math.max(1, (settings.layout || 9) - 1);
  const onStage = members.filter(member => member.state === 'speaker').length;
  const full = onStage >= seats;
  r.requests.replaceChildren(
    h('div', { class: 'live-requests-head' },
      h('span', { html: icon.guests, 'aria-hidden': 'true' }),
      h('b', {}, `${t('requestsToJoin')} (${pending.length})`),
      h('small', {}, `${onStage}/${seats}`)),
    ...pending.slice(0, REQUESTS_SHOWN).map(member => {
      const approve = h('button', { class: 'live-req-btn approve', type: 'button', disabled: busy.has(member.userId),
        title: full ? t('seatsFull') : t('approve'), 'aria-label': `${t('approve')} ${displayName(member.name)}` }, t('approve'));
      approve.addEventListener('click', event => {
        event.stopPropagation();
        handleRequestAction(slide, session, 'approve', member.userId, approve);
      });
      const reject = h('button', { class: 'live-req-btn reject', type: 'button', disabled: busy.has(member.userId),
        'aria-label': `${t('reject')} ${displayName(member.name)}`, html: icon.close });
      reject.addEventListener('click', event => {
        event.stopPropagation();
        handleRequestAction(slide, session, 'reject', member.userId, reject);
      });
      return h('div', { class: 'live-request', 'data-uid': cssId(member.userId) },
        avatar(member, 30), h('span', { class: 'live-request-name' }, displayName(member.name)), approve, reject);
    }),
    pending.length > REQUESTS_SHOWN
      ? h('button', { class: 'live-requests-more', type: 'button', 'data-act': 'guests' }, `+${pending.length - REQUESTS_SHOWN} · ${t('requests')}`)
      : null,
  );
}

/** Wires a LiveSession's events into a slide. Returns an unbind function. */
function connectUi(slide, session) {
  const r = slide._refs;
  const audio = h('div', { class: 'live-audio', 'aria-hidden': 'true' });
  slide.append(audio);
  const giftQueue = [];
  let showingGift = false;
  const offs = [
    session.on('state', state => {
      r.state.hidden = state === 'connected';
      if (state === 'disconnected') { showRetry(slide, session.host ? t('liveUnavailable') : t('connectionLost')); return; }
      r.state.textContent = state === 'reconnecting' ? t('reconnecting') : state === 'connecting' ? t('joining') : '';
    }),
    // A guest (or the host) switched their camera off/on: show their avatar instead of a frozen frame.
    session.on('camera', ({ participant, on }) => {
      if (!participant) return;
      if (participant === session.live.host.id) { if (!session.host) { r.cover.hidden = on; slide.classList.toggle('has-video', on); } return; }
      r.guests.querySelector(`[data-uid="${cssId(participant)}"]`)?.classList.toggle('cam-off', !on);
    }),
    session.on('video', ({ element, isHost, participant, name }) => {
      if (isHost) {
        r.stage.replaceChildren(element);
        r.cover.hidden = true; slide.classList.add('has-video');
        return;
      }
      const tile = guestTile(slide, participant, name);
      tile.querySelector('video')?.remove();
      tile.prepend(element);
      tile.classList.add('has-video');
      tile.classList.remove('cam-off');
    }),
    session.on('video-gone', participant => {
      if (participant === session.live.host.id) { r.stage.replaceChildren(); r.cover.hidden = false; slide.classList.remove('has-video'); return; }
      const tile = r.guests.querySelector(`[data-uid="${cssId(participant)}"]`);
      if (!tile) return;
      tile.querySelector('video')?.remove();
      tile.classList.remove('has-video');
      if (!tile._member) tile.remove();
    }),
    session.on('track-muted', ({ participant, kind, muted }) => {
      if (kind !== 'video') return;
      if (participant === session.live.host.id) { r.cover.hidden = !muted; slide.classList.toggle('has-video', !muted); }
      else r.guests.querySelector(`[data-uid="${cssId(participant)}"]`)?.classList.toggle('cam-off', muted);
    }),
    session.on('facing', facing => slide.querySelectorAll('.live-track.local').forEach(element => element.classList.toggle('mirror', facing !== 'environment'))),
    session.on('audio', element => audio.append(element)),
    session.on('viewers', n => {
      r.viewers.textContent = count(n);
      if (r.choiceCount) r.choiceCount.textContent = count(n);
    }),
    session.on('comment', event => {
      if (r.comments.querySelector(`[data-id="${cssId(event.id)}"]`)) return;
      const line = h('p', { class: event.uid === auth.userId ? 'mine' : '', 'data-id': cssId(event.id), 'data-uid': event.uid || '' },
        h('b', {}, event.name || 'MilkyWay'), ' ', event.body);
      line._event = event;
      if (session.host && event.uid && event.uid !== auth.userId) { line.dataset.act = 'comment'; line.classList.add('tappable'); }
      r.comments.append(line);
      while (r.comments.childElementCount > MAX_COMMENTS) r.comments.firstElementChild.remove();
      r.comments.scrollTop = r.comments.scrollHeight;
    }),
    session.on('comment-rejected', ({ id, error }) => {
      r.comments.querySelector(`[data-id="${cssId(id)}"]`)?.remove();
      toast(error?.message || t('liveUnavailable'));
    }),
    session.on('comment-deleted', id => r.comments.querySelector(`[data-id="${cssId(id)}"]`)?.remove()),
    session.on('room', status => applyRoom(slide, session, status)),
    session.on('stage-state', () => paintStageButton(slide, session)),
    session.on('stage-action', () => paintStageButton(slide, session)),
    session.on('media', media => paintMedia(slide, media)),
    session.on('voice-preset', preset => {
      const option = VOICE_PRESETS.find(item => item.id === preset);
      r.voiceBtn.classList.toggle('active', preset !== 'normal');
      r.voiceBtn.title = `${t('voiceChanger')}: ${t(option?.key || 'voicePresetNormal')}`;
      r.voiceBtn.setAttribute('aria-label', r.voiceBtn.title);
    }),
    session.on('stage', ({ onStage }) => { slide.classList.toggle('on-stage', onStage); if (onStage) toast(t('youAreOnStage')); }),
    session.on('error', error => { if (error?.message) toast(error.message); }),
    session.on('like', ({ n }) => {
      for (let i = 0; i < Math.min(n, 4); i++) {
        if (r.hearts.childElementCount >= MAX_HEARTS) break;
        const heart = h('span', { class: 'float-heart', html: icon.heart, style: `--x:${Math.round(Math.random() * 40 - 20)}px;--d:${(1.6 + Math.random()).toFixed(2)}s;--hue:${Math.round(Math.random() * 60 + 320)}` });
        heart.addEventListener('animationend', () => heart.remove(), { once: true });
        r.hearts.append(heart);
      }
    }),
    session.on('gift', event => {
      giftQueue.push(event);
      const next = () => {
        const gift = giftQueue.shift();
        if (!gift) { showingGift = false; return; }
        showingGift = true;
        const item = catalog.value?.find(entry => entry.key === gift.gift);
        const card = h('div', { class: 'gift-card' }, h('span', { class: 'gift-card-icon' }, giftIcon(gift.gift)), h('div', {}, h('b', {}, gift.name || 'MilkyWay'), h('small', {}, `${t('sent')} ${item?.name || gift.gift}`)));
        r.banner.replaceChildren(card);
        setTimeout(() => { card.classList.add('out'); setTimeout(next, 250); }, 2200);
      };
      if (!showingGift) next();
    }),
    session.on('audio-blocked', blocked => slide.classList.toggle('audio-blocked', !!blocked)),
  ];
  return () => { offs.forEach(off => off()); audio.remove(); };
}

/** Shows a message with a Retry button in the slide's status pill. */
function showRetry(slide, message) {
  const r = slide._refs;
  r.state.hidden = false;
  r.state.replaceChildren(h('span', {}, message), ' ', h('button', { class: 'pill-btn live-retry', type: 'button', 'data-act': 'retry' }, t('retry')));
}

/** Stream controls shared by the host and guests on stage (flip, mic, camera). Returns true when handled.
 *  Buttons repaint from the session's 'media' event, i.e. from the real track state. */
function streamControl(act, session, _button, slide) {
  if (act === 'flip') { session.flipCamera().catch(error => toast(error.message)); return true; }
  if (act === 'mic') { session.toggleMic().catch(error => toast(error.message || t('guestMutedByHost'))).finally(() => paintMedia(slide, session.media)); return true; }
  if (act === 'cam') {
    session.toggleCamera().then(on => {
      if (session.host) { slide._refs.cover.hidden = on; slide.classList.toggle('has-video', on); }
    }).catch(error => toast(error.message)).finally(() => paintMedia(slide, session.media));
    return true;
  }
  return false;
}

async function copyLivePromotion(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; }
    catch { /* Continue with the selection-based fallback. */ }
  }
  const field = h('textarea', { readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
  field.value = value;
  field.style.cssText = 'position:fixed;inset:auto auto 0 0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.append(field);
  let copied = false;
  try { field.focus({ preventScroll: true }); field.select(); copied = document.execCommand('copy'); }
  finally { field.remove(); }
  if (!copied) throw new Error(t('copyUnavailable'));
}

function voicePicker(session) {
  const sheet = new Sheet({ title: t('voiceChanger'), className: 'lc-sheet voice-picker-sheet' });
  const buttons = VOICE_PRESETS.map(preset => h('button', {
    class: 'lc-action voice-preset-option', type: 'button', role: 'radio', 'data-preset': preset.id,
    onclick: async () => {
      try { await session.setVoicePreset(preset.id); sheet.close(); }
      catch (error) { toast(error?.message || t('voicePresetUnavailable')); }
    },
  }, t(preset.key)));
  const paint = selected => buttons.forEach(button => {
    const active = button.dataset.preset === selected;
    button.classList.toggle('on', active);
    button.setAttribute('aria-checked', String(active));
  });
  const off = session.on('voice-preset', paint);
  sheet.body.append(h('section', { class: 'lc-section', role: 'radiogroup', 'aria-label': t('voiceChanger') }, ...buttons));
  paint(session.voicePreset);
  return {
    open() { paint(session.voicePreset); sheet.open(); },
    destroy() { off(); sheet.root.remove(); },
  };
}

export class LiveView {
  constructor(root, { requireLogin, openGifts, openProfile, onClose, openRoom, listenLive, takeAmbientSession, openServiceStudio }) {
    this.root = root;
    this.hooks = { requireLogin, openGifts, openProfile, onClose, openRoom, listenLive, takeAmbientSession, openServiceStudio };
    this.session = null;
    this.unbind = null;
    this.pending = null; // room to focus when the list arrives
    this.viewerWindowBlurred = false;
    this.viewerGraceTimer = 0;
    this.viewerRestingSlide = null;
    this.viewerGraceExpired = false;
    this.goPreviewStream = null;
    this.goPreviewRequest = 0;
    this.goPreviewVideo = null;
    this.goPreviewError = null;
    this.goWait = null;
    this.directoryLoading = false;
    this.directoryRequest = 0;
    this.directorySheet = new Sheet({ title: t('liveDirectory'), className: 'live-directory-sheet', autoFocus: false });
    this.directoryStatus = h('p', { class: 'live-directory-status', role: 'status', 'aria-live': 'polite' });
    this.directoryRows = h('div', { class: 'live-directory-rows' });
    this.directoryRetry = h('button', { class: 'live-directory-retry', type: 'button', hidden: true, onclick: () => { void this.#refreshDirectory(); } }, t('retry'));
    this.directoryEmptyMessage = h('h1', { class: 'live-directory-empty-message' }, t('loading'));
    this.directoryEmptyRetry = h('button', { class: 'live-directory-empty-retry', type: 'button', hidden: true, onclick: () => { void this.#refreshDirectory(); } }, t('retry'));
    this.directoryEmpty = h('section', { class: 'live-directory-empty', hidden: true },
      h('button', { class: 'live-directory-close', type: 'button', 'aria-label': t('close'), onclick: () => this.directorySheet.close() }, '×'),
      h('div', { class: 'live-directory-brand' }, brandMark('directory'), h('strong', {}, 'MilkyWay')),
      this.directoryEmptyMessage, this.directoryEmptyRetry);
    this.directorySheet.body.append(this.directoryStatus, this.directoryRows, this.directoryRetry, this.directoryEmpty);
    this.surface = h('div', { class: 'live-pager', tabindex: '0', 'aria-label': 'LIVE' });
    this.empty = h('div', { class: 'live-empty', hidden: true },
      h('p', {}, t('noLives')),
      h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.openGoLive() }, t('goLive')));
    this.goLiveBtn = h('button', { class: 'pill-btn hot go-live-fab', type: 'button', onclick: () => this.openGoLive() }, t('goLive'));
    root.append(this.surface, this.empty, this.goLiveBtn);

    this.pager = new VerticalPager(this.surface, {
      radius: 1,
      keyOf: live => live.room,
      create: () => liveChrome(),
      bind: (slide, live) => { resetStage(slide); paintLive(slide, live); },
      update: (slide, live) => { slide._live = live; },
      release: slide => { if (slide === this.activeSlide) this.#leave(); resetStage(slide); },
      onChange: () => { this.#leave(); clearTimeout(this.joinTimer); this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY); },
    });
    this.#bindEvents();
    document.addEventListener('visibilitychange', () => this.#syncViewerLifecycle());
    window.addEventListener('blur', () => { this.viewerWindowBlurred = true; this.#syncViewerLifecycle(); });
    window.addEventListener('focus', () => { this.viewerWindowBlurred = false; this.#syncViewerLifecycle(); });
    lives.subscribe(list => { this.#apply(list); this.#renderDirectory(list); });
  }

  openDirectory() {
    this.directoryLoading = true;
    this.#renderDirectory(lives.value);
    this.directorySheet.open();
    watchLives().catch(error => console.warn('[live] directory realtime unavailable', error));
    void this.#refreshDirectory();
  }

  async #refreshDirectory() {
    const request = ++this.directoryRequest;
    this.directoryLoading = true;
    this.#renderDirectory(lives.value);
    try {
      const list = await lives.refresh();
      if (request !== this.directoryRequest) return;
      this.directoryLoading = false;
      this.#renderDirectory(list);
    } catch (error) {
      if (request !== this.directoryRequest) return;
      console.warn('[live] directory refresh failed', error);
      this.directoryLoading = false;
      this.#renderDirectory(null);
    }
  }

  #renderDirectory(list) {
    if (!Array.isArray(list)) {
      this.directoryStatus.textContent = this.directoryLoading ? t('loading') : t('liveLoadFailed');
      this.directoryRows.replaceChildren();
      this.directoryRetry.hidden = true;
      this.directoryEmptyMessage.textContent = this.directoryLoading ? t('loading') : t('liveLoadFailed');
      this.directoryEmptyRetry.hidden = this.directoryLoading;
      this.directoryEmpty.hidden = false;
      this.directoryStatus.hidden = true;
      this.directoryRows.hidden = true;
      this.directorySheet.panel.classList.add('is-empty');
      return;
    }
    if (!list.length) {
      const empty = !this.directoryLoading && !lives.error && navigator.onLine !== false;
      this.directoryStatus.textContent = this.directoryLoading ? t('loading') : t('liveLoadFailed');
      this.directoryRows.replaceChildren();
      this.directoryRetry.hidden = true;
      this.directoryEmptyMessage.textContent = this.directoryLoading ? t('loading') : empty ? t('noLives') : t('liveLoadFailed');
      this.directoryEmptyRetry.hidden = this.directoryLoading;
      this.directoryStatus.hidden = true;
      this.directoryRows.hidden = true;
      this.directoryEmpty.hidden = false;
      this.directorySheet.panel.classList.add('is-empty');
      return;
    }
    this.directoryStatus.textContent = `${list.length} ${t('liveRoomsNow')}`;
    this.directoryStatus.hidden = false;
    this.directoryRows.hidden = false;
    this.directoryRetry.hidden = true;
    this.directoryEmptyRetry.hidden = true;
    this.directoryEmpty.hidden = true;
    this.directorySheet.panel.classList.remove('is-empty');
    this.directoryRows.replaceChildren(...list.map(live => {
      const face = h('span', { class: 'avatar', style: '--s:38px' });
      paintAvatar(face, live.host, 38);
      const viewers = live.viewerCount == null ? '–' : count(live.viewerCount);
      const watch = h('button', { class: 'live-directory-watch', type: 'button', onclick: () => {
        this.directorySheet.close();
        this.hooks.openRoom?.(live.room);
      } }, t('liveWatch'));
      const listen = h('button', { class: 'live-directory-listen', type: 'button', onclick: async () => {
        listen.disabled = true;
        try {
          await this.hooks.listenLive?.(live);
          this.directorySheet.close();
        } catch (error) {
          const message = String(error?.message || '').replace(/\b(?:null|undefined)\b/gi, '').trim();
          toast(message || t('liveUnavailable'));
        } finally {
          listen.disabled = false;
        }
      } }, t('liveListenWhileBrowsing'));
      return h('article', { class: 'live-directory-room' }, face,
        h('div', { class: 'live-directory-copy' },
          h('strong', {}, displayName(live.host?.name)),
          h('small', {}, live.title || t('live')),
          h('span', { class: 'live-directory-status-tag' }, `${t('liveNow')} · ${viewers} ${t('viewers')}`)),
        h('div', { class: 'live-directory-actions' }, watch, listen));
    }));
  }

  open(room = null) {
    this.root.hidden = false;
    this.pending = room;
    if (auth.signedIn()) loadLiveKit().catch(error => console.warn('[live] media warm-up failed', error));
    watchLives();
    lives.load().then(list => { if (!list) lives.refresh(); });
    if (this.pager.items.length && !room) { clearTimeout(this.joinTimer); this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY); }
    else this.#apply(lives.value);
    this.surface.focus({ preventScroll: true });
  }

  close() {
    clearTimeout(this.joinTimer);
    this.#leave();
    this.root.hidden = true;
  }

  #apply(list) {
    if (!list) return;
    this.empty.hidden = list.length > 0;
    this.goLiveBtn.hidden = list.length === 0;
    const before = this.pager.current?.room;
    this.pager.setItems(list);
    if (this.pending) {
      const index = list.findIndex(live => live.room === this.pending);
      if (index >= 0) { this.pending = null; this.pager.goTo(index, { animate: false }); }
    }
    if (!this.root.hidden && auth.signedIn()) {
      const current = this.pager.current;
      if (current) LiveSession.warm(current).catch(error => console.warn('[live] room warm-up failed', error));
    }
    if (!this.root.hidden && list.length && (this.pager.current?.room !== before || !this.session)) {
      clearTimeout(this.joinTimer);
      this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY);
    }
  }

  async #join() {
    if (this.root.hidden) return;
    const live = this.pager.current;
    const slide = this.pager.slideAt(this.pager.index);
    if (!live || !slide || this.session?.live.room === live.room) return;
    this.#leave();
    if (!auth.signedIn()) {
      slide._refs.state.hidden = false;
      slide._refs.state.replaceChildren(h('button', { class: 'pill-btn', type: 'button', onclick: () => this.hooks.requireLogin() }, t('signInToContinue')));
      return;
    }
    const session = this.hooks.takeAmbientSession?.(live.room) || new LiveSession(live);
    this.session = session;
    this.voicePicker = voicePicker(session);
    this.activeSlide = slide;
    resetStage(slide);
    this.unbind = connectUi(slide, session);
    slide._wait ||= new WaitIndicator(slide);
    slide._wait.start('join', t('connectingLive'));
    session.on('ended', () => {
      if (this.session !== session) return;
      slide._refs.state.hidden = false;
      slide._refs.state.textContent = t('liveEnded');
      setTimeout(() => { if (this.session === session) { this.#leave(); lives.refresh(); this.pager.next(); } }, 2200);
    });
    session.on('removed', () => {
      if (this.session !== session) return;
      slide._refs.state.hidden = false;
      slide._refs.state.textContent = t('removedYou');
      setTimeout(() => { if (this.session === session) { this.#leave(); this.pager.next(); } }, 2600);
    });
    session.on('invited', () => {
      if (this.session !== session) return;
      this.invite?.destroy();
      this.invite = new InvitePrompt(session, live.host.name);
      this.invite.open();
    });
    try {
      if (session.room?.state === 'connected') {
        const audio = slide.querySelector('.live-audio');
        session.audioElements?.forEach(element => audio?.append(element));
        if (session.status) applyRoom(slide, session, session.status);
        slide._refs.viewers.textContent = count(session.viewers);
        if (slide._refs.choiceCount) slide._refs.choiceCount.textContent = count(session.viewers);
      } else await session.join();
      session.setAudioOnly(false);
      if (slide._refs.entryChoice) slide._refs.entryChoice.hidden = session.host || session.stage !== 'audience';
      this.#syncViewerLifecycle();
    }
    catch (error) {
      if (this.session !== session) return;
      console.warn('[live] join failed', error);
      if (error.status === 404) {
        slide._refs.state.hidden = false;
        slide._refs.state.textContent = t('liveEnded');
        setTimeout(() => { if (this.session === session) { this.#leave(); lives.refresh(); } }, 2200);
      } else if (error.status === 401) {
        slide._refs.state.hidden = false;
        slide._refs.state.replaceChildren(h('button', { class: 'pill-btn', type: 'button', onclick: () => this.hooks.requireLogin() }, t('signInToContinue')));
      } else if (error.status === 403) {
        slide._refs.state.hidden = false;
        slide._refs.state.textContent = error.message || t('liveUnavailable');
      } else showRetry(slide, error?.name === 'NotAllowedError' ? t('cameraNeeded') : t('liveUnavailable'));
    } finally { slide._wait.stop('join'); }
  }

  #leave() {
    this.activeSlide?._wait?.stop('join');
    clearTimeout(this.viewerGraceTimer);
    this.viewerGraceTimer = 0;
    if (this.viewerRestingSlide) {
      this.viewerRestingSlide.classList.remove('resting', 'resting-expired');
      this.viewerRestingSlide._refs.resting.hidden = true;
    }
    this.viewerRestingSlide = null;
    this.viewerGraceExpired = false;
    this.invite?.destroy(); this.invite = null;
    this.voicePicker?.destroy(); this.voicePicker = null;
    this.unbind?.(); this.unbind = null;
    this.session?.leave(); this.session = null;
    this.activeSlide = null;
  }

  #syncViewerLifecycle() {
    if (this.root.hidden) return;
    const inactive = document.visibilityState === 'hidden' || this.viewerWindowBlurred;
    if (!this.session) {
      if (inactive || !this.viewerGraceExpired) return;
      const slide = this.viewerRestingSlide;
      if (slide) {
        slide.classList.remove('resting', 'resting-expired');
        slide._refs.resting.hidden = true;
        slide._refs.resting.querySelector('.live-resting-message').textContent = t('liveRadioContinues');
      }
      this.viewerGraceExpired = false;
      this.viewerRestingSlide = null;
      if (this.pager.current) {
        clearTimeout(this.joinTimer);
        this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY);
      }
      return;
    }
    if (this.session.host) return;
    if (inactive) {
      if (this.viewerGraceTimer || this.viewerGraceExpired) return;
      const session = this.session;
      const slide = this.activeSlide;
      if (!slide) return;
      this.viewerRestingSlide = slide;
      slide.classList.add('resting');
      slide._refs.resting.hidden = false;
      this.viewerGraceTimer = setTimeout(() => {
        this.viewerGraceTimer = 0;
        if (this.session !== session || this.root.hidden) return;
        if (document.visibilityState !== 'hidden' && !this.viewerWindowBlurred) {
          this.#syncViewerLifecycle();
          return;
        }
        this.#leave();
        this.viewerGraceExpired = true;
        this.viewerRestingSlide = slide;
        slide.classList.add('resting', 'resting-expired');
        slide._refs.resting.hidden = false;
        slide._refs.resting.querySelector('.live-resting-message').textContent = t('liveRestingDisconnected');
      }, VIEWER_HIDDEN_GRACE_MS);
      return;
    }
    clearTimeout(this.viewerGraceTimer);
    this.viewerGraceTimer = 0;
    if (this.viewerGraceExpired) {
      const slide = this.viewerRestingSlide;
      if (slide) {
        slide.classList.remove('resting', 'resting-expired');
        slide._refs.resting.hidden = true;
        slide._refs.resting.querySelector('.live-resting-message').textContent = t('liveRadioContinues');
      }
      this.viewerGraceExpired = false;
      this.viewerRestingSlide = null;
      if (!this.session && this.pager.current && !this.root.hidden) {
        clearTimeout(this.joinTimer);
        this.joinTimer = setTimeout(() => this.#join(), JOIN_DELAY);
      }
    } else if (this.viewerRestingSlide) {
      this.viewerRestingSlide.classList.remove('resting');
      this.viewerRestingSlide._refs.resting.hidden = true;
      this.viewerRestingSlide = null;
    }
  }

  #bindEvents() {
    this.surface.addEventListener('click', event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      const slide = event.target.closest('.live-slide');
      const live = slide?._live;
      this.session?.resumeAudio()?.catch?.(() => {});
      if (!act || !live) {
        // Tap on the stage: like (TikTok taps), only for the active, connected session.
        if (slide && this.session && slide === this.activeSlide && !event.target.closest('.live-bar, .live-top, .live-tools, .live-pinned')) this.session.like();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (this.session && slide === this.activeSlide && streamControl(act, this.session, button, slide)) return;
      if (act === 'voice') this.voicePicker?.open();
      else if (act === 'retry') { if (slide === this.pager.slideAt(this.pager.index)) { this.#leave(); this.#join(); } }
      else if (act === 'close') this.hooks.onClose();
      else if (act === 'stage') {
        // The button is in the bar from the first frame; until the room is connected a tap just says so.
        if (!this.hooks.requireLogin()) return;
        if (this.session && slide === this.activeSlide) {
          if (slide._refs.entryChoice) slide._refs.entryChoice.hidden = true;
          this.#stageRequest();
        } else toast(t('joining'));
      }
      else if (act === 'watch') {
        if (slide === this.activeSlide && slide._refs.entryChoice) slide._refs.entryChoice.hidden = true;
      }
      else if (act === 'leave-stage') {
        if (this.activeSlide) this.activeSlide._selfCancelled = true;
        this.session?.leaveStage().then(() => toast(t('leftStage'))).catch(error => toast(error.message));
      }
      else if (act === 'guest') {
        // Viewers: a guest box opens that guest's profile.
        const member = event.target.closest('.live-guest')?._member;
        if (member?.userId && member.userId !== auth.userId) this.hooks.openProfile({ id: member.userId, name: member.name, avatar: member.avatar });
      }
      else if (act === 'comment' || act === 'unpin') { /* host-only actions */ }
      else if (act === 'like') { if (this.session) this.session.like(); }
      else if (act === 'gift') {
        if (!this.hooks.requireLogin() || !this.session) return;
        Promise.resolve(this.hooks.openGifts({ room: live.room, to: live.host, session: this.session }))
          .catch(error => toast(error?.message || t('giftFailed')));
      }
      else if (act === 'share') openShare({ title: live.title || 'MilkyWay LIVE', url: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#live=${encodeURIComponent(live.room)}` });
      else if (act === 'profile') this.hooks.openProfile(live.host);
      else if (act === 'follow') { if (this.hooks.requireLogin()) actions.follow(live.host.id, true).then(() => { slide._refs.follow.hidden = true; }).catch(error => toast(error.message)); }
    });
    this.surface.addEventListener('submit', event => {
      event.preventDefault();
      const input = event.target.querySelector('input');
      if (!input?.value.trim() || !this.session) return;
      if (!this.hooks.requireLogin()) return;
      this.session.comment(input.value);
      input.value = '';
    });
  }

  async #stageRequest() {
    const session = this.session;
    const slide = this.activeSlide;
    if (session.stageAction) return;
    try {
      if (session.stage === 'requested') {
        if (slide) slide._selfCancelled = true;
        await session.cancelRequest();
        toast(t('requestCancelled'));
        return;
      }
      if (session.stage === 'joining' || session.stage === 'guest') return;
      if (session.stage === 'invited') { await session.acceptInvite(); return; }
      if (slide) slide._selfCancelled = false;
      const state = await session.requestStage();
      toast(state === 'speaker' ? t('joinedStage') : t('requestSent'));
    } catch (error) { toast(error?.message || t('liveUnavailable')); }
  }

  // ---- Broadcasting ----------------------------------------------------------------------------------------
  openGoLive() {
    if (!this.hooks.requireLogin()) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast(t('cameraNeeded')); return; }
    this.goSheet ||= this.#buildGoLiveSheet();
    this.goSheet.open();
    void this.#startGoLivePreview('camera');
  }

  async #startGoLivePreview(waitKey = '') {
    if (!this.goPreviewVideo || this.goPreviewStream || !this.goSheet?.isOpen || this.goMode === 'audio') return;
    const request = ++this.goPreviewRequest;
    if (waitKey) {
      this.goWait.start(waitKey, waitKey === 'camera' ? t('preparingCamera') : t('switchingLiveMode'), {
        onCancel: () => this.goSheet.close(),
      });
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: this.goFacing || 'user' } });
      if (request !== this.goPreviewRequest || !this.goSheet?.isOpen || this.goMode === 'audio') {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.goPreviewStream = stream;
      this.goPreviewVideo.srcObject = stream;
      await this.goPreviewVideo.play();
      this.goPreviewError.textContent = '';
    } catch (error) {
      if (request === this.goPreviewRequest) {
        this.goPreviewError.textContent = String(error?.message || t('cameraNeeded')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('cameraNeeded');
      }
    } finally {
      if (waitKey && request === this.goPreviewRequest) this.goWait.stop(waitKey);
    }
  }

  #stopGoLivePreview() {
    this.goPreviewRequest++;
    this.goWait?.clear();
    this.goPreviewStream?.getTracks().forEach(track => track.stop());
    this.goPreviewStream = null;
    if (this.goPreviewVideo) this.goPreviewVideo.srcObject = null;
  }

  async #flipGoLivePreview() {
    this.goFacing = this.goFacing === 'user' ? 'environment' : 'user';
    this.#stopGoLivePreview();
    await this.#startGoLivePreview('camera-switch');
  }

  #buildGoLiveSheet() {
    const sheet = new Sheet({
      title: t('goLive'), className: 'go-live-sheet',
      onClose: () => {
        this.#stopGoLivePreview();
        if (!this.broadcastStarting) this.hooks.onPreliveClose?.();
      },
      autoFocus: false,
    });
    sheet.panel.setAttribute('aria-label', t('goLive'));
    this.goWait = new WaitIndicator(sheet.panel);
    this.goFacing = 'user';
    this.goMode = 'video';
    let admission = 'approval';
    let comments = 'everyone';
    let layout = 8;
    let layoutStyle = 'featured';
    let scope = 'public';
    this.goPreviewVideo = h('video', { class: 'gl-preview-video', autoplay: true, muted: true, playsinline: true, 'aria-label': t('camera') });
    this.goPreviewError = h('p', { class: 'gl-preview-error', role: 'status', 'aria-live': 'polite' });
    const close = h('button', { class: 'gl-close', type: 'button', 'aria-label': t('close'), onclick: () => sheet.close() }, '×');
    const rewardsSheet = new Sheet({ title: t('liveRewards'), className: 'lc-sheet gl-rewards-sheet', autoFocus: false });
    const readinessSheet = new Sheet({ title: t('liveRoomCheck'), className: 'lc-sheet gl-readiness-sheet', autoFocus: false });
    const fanClubSheet = new Sheet({ title: t('fanClub'), className: 'lc-sheet gl-fan-club-sheet', autoFocus: false });
    const interactSheet = new Sheet({ title: t('interact'), className: 'lc-sheet gl-interact-sheet', autoFocus: false });
    const promoteSheet = new Sheet({ title: t('promote'), className: 'lc-sheet gl-promote-sheet', autoFocus: false });
    const gamingSheet = new Sheet({ title: t('mobileGaming'), className: 'lc-sheet gl-gaming-sheet', autoFocus: false });
    gamingSheet.body.append(h('section', { class: 'gl-panel-section' },
      h('p', { class: 'gl-panel-note' }, t('liveFeatureUnavailable'))));
    const rewards = h('button', { class: 'gl-rewards', type: 'button', onclick: () => openRewards() }, '✦ ', t('liveRewards'));
    const readiness = h('button', { class: 'gl-readiness-button', type: 'button', 'aria-label': t('liveRoomCheck'), title: t('liveRoomCheck'), onclick: () => openReadiness() },
      h('span', { html: icon.live, 'aria-hidden': 'true' }));
    const statusIcons = h('div', { class: 'gl-status-actions' },
      h('button', { type: 'button', 'aria-label': t('liveSettings'), title: t('liveSettings'), onclick: () => preliveSettings.open() },
        h('span', { html: icon.gear, 'aria-hidden': 'true' })));
    const mission = h('aside', { class: 'gl-mission' },
      h('span', { 'aria-hidden': 'true' }, '✦'), h('span', {}, t('liveMissionHint')),
      h('button', { type: 'button', 'aria-label': t('dismiss'), onclick: () => mission.remove() }, '×'));
    const togglePreviewEffect = (button, className) => {
      const active = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(active));
      sheet.panel.classList.toggle(className, active);
    };
    const tool = (label, symbol, handler) => h('button', {
      class: 'gl-tool', type: 'button', 'aria-label': label, onclick: handler,
    }, h('span', { 'aria-hidden': 'true', ...(symbol.trimStart().startsWith('<svg') ? { html: symbol } : {}) },
      symbol.trimStart().startsWith('<svg') ? '' : symbol), h('small', {}, label));
    const toolRows = h('div', { class: 'gl-tool-grid' },
      tool(t('flipCamera'), '↻', () => { void this.#flipGoLivePreview(); }),
      tool(t('beautify'), '✧', event => togglePreviewEffect(event.currentTarget, 'beautified')),
      tool(t('effects'), '✦', event => togglePreviewEffect(event.currentTarget, 'effects-on')),
      tool(t('liveSettings'), '⚙', () => preliveSettings.open()),
      tool(t('multiGuest'), '♧', () => guestSheet.open()),
      tool(t('servicePlus'), '✚', async () => {
        sheet.close();
        try {
          if (!this.hooks.openServiceStudio) throw new Error(t('studioServiceUnavailable'));
          await this.hooks.openServiceStudio();
        } catch (error) { toast(error?.message || t('studioServiceUnavailable')); }
      }),
      tool(t('fanClub'), '♕', () => openFanClub()),
      tool(t('interact'), '♡', () => openInteract()),
      tool(t('share'), '↗', () => openPreliveShare()),
      tool(t('promote'), '↟', () => openPromotion()));
    const title = h('input', { class: 'gl-title', type: 'text', maxlength: '80', placeholder: t('liveTitle'), 'aria-label': t('liveTitle'), enterkeyhint: 'go' });
    const goalInput = h('input', { class: 'gl-goal-input', type: 'text', maxlength: '80', placeholder: t('liveGoalPlaceholder'), 'aria-label': t('liveGoalPlaceholder'), hidden: true });
    const goal = h('button', { class: 'gl-goal-button', type: 'button', onclick: () => {
      goalInput.hidden = !goalInput.hidden;
      if (!goalInput.hidden) goalInput.focus({ preventScroll: true });
    } }, '◎ ', t('liveGoal'));
    const titleRow = h('div', { class: 'gl-title-row' }, title, goal);
    const start = h('button', { class: 'gl-start', type: 'submit' }, h('i', { class: 'gl-dot', 'aria-hidden': 'true' }), t('goLive'));
    const modes = [
      ['audio', t('voiceChat'), icon.mic],
      ['camera', t('deviceCamera'), icon.camera],
      ['gaming', t('mobileGaming'), '▣'],
      ['video', t('live'), '●'],
    ];
    const modeButtons = [];
    const modeRow = h('div', { class: 'gl-mode-row', role: 'group', 'aria-label': t('goLive') },
      ...modes.map(([value, label, symbol], index) => {
        const button = h('button', { class: `gl-mode${index === 3 ? ' is-selected' : ''}`, type: 'button', 'aria-pressed': String(index === 3), onclick: () => {
          if (value === 'gaming') { gamingSheet.open(); return; }
          this.goMode = value;
          modeButtons.forEach(item => {
            const selected = item === button;
            item.classList.toggle('is-selected', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
          if (value === 'audio') this.#stopGoLivePreview();
          else void this.#startGoLivePreview('mode');
        } }, h('span', { 'aria-hidden': 'true', ...(typeof symbol === 'string' && symbol.trimStart().startsWith('<svg') ? { html: symbol } : {}) },
          typeof symbol === 'string' && symbol.trimStart().startsWith('<svg') ? '' : symbol), label);
        modeButtons.push(button);
        return button;
      }));
    const scopeSelect = h('select', { class: 'field', onchange: event => { scope = event.target.value; } },
      h('option', { value: 'public' }, t('everyone')),
      h('option', { value: 'followers' }, t('followersOnly')));
    const commentsSelect = h('select', { class: 'field', onchange: event => { comments = event.target.value; } },
      h('option', { value: 'everyone' }, t('commentsEveryone')),
      h('option', { value: 'followers' }, t('commentsFollowers')),
      h('option', { value: 'off' }, t('commentsOff')));
    const details = h('div', { class: 'gl-prelive-details', hidden: true },
      h('p', {}, t('livePreflightSettingsHint')),
      h('label', {}, t('liveWhoCanWatch'), scopeSelect),
      h('label', {}, t('admission'), h('select', { class: 'field', onchange: event => { admission = event.target.value; } },
        h('option', { value: 'approval' }, t('admissionApproval')),
        h('option', { value: 'open' }, t('admissionDirect')),
        h('option', { value: 'broadcast' }, t('admissionOff')))),
      h('label', {}, t('comments2'), commentsSelect));
    const preliveSettings = new Sheet({ title: t('liveSettings'), className: 'lc-sheet gl-prelive-settings', autoFocus: false });
    preliveSettings.body.append(details);
    details.hidden = false;
    const readinessRow = (label, value, ready = false) => h('div', { class: 'gl-check-row' },
      h('span', {}, label), h('b', { class: ready ? 'is-ready' : 'is-pending' }, value));
    const hasCameraPreview = () => this.goPreviewStream?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled) || false;
    const openReadiness = () => {
      const videoMode = this.goMode !== 'audio';
      const cameraReady = !videoMode || hasCameraPreview();
      readinessSheet.body.replaceChildren(
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('liveReadiness')),
          readinessRow(t('camera'), !videoMode ? t('liveCameraNotUsed') : cameraReady ? t('liveCameraReady') : t('liveCameraPreparing'), cameraReady),
          readinessRow(t('microphone'), t('liveMicStandby')),
          readinessRow(t('live'), t('liveNotStarted')),
          readinessRow(t('streamMode'), t(videoMode ? 'liveVideoMode' : 'liveAudioMode'), true),
          readinessRow(t('liveAudience'), scope === 'followers' ? t('followersOnly') : t('everyone'), true)),
        h('p', { class: 'gl-panel-note' }, t('liveMicReadinessNote')));
      readinessSheet.open();
    };
    const openFanClub = () => {
      const followersOnly = h('button', {
        class: 'gl-panel-action', type: 'button', onclick: () => {
          scope = 'followers';
          scopeSelect.value = scope;
          fanClubSheet.close();
          toast(t('liveSettingsUpdated'));
        },
      }, t('liveFanClubFollowersOnly'));
      fanClubSheet.body.replaceChildren(
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('fanClub')),
          h('p', { class: 'gl-panel-note' }, t('liveFanClubHint')),
          followersOnly));
      fanClubSheet.open();
    };
    const openInteract = () => {
      const choices = [
        ['everyone', t('commentsEveryone')],
        ['followers', t('commentsFollowers')],
        ['off', t('commentsOff')],
      ];
      interactSheet.body.replaceChildren(
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('interact')),
          h('p', { class: 'gl-panel-note' }, t('liveInteractHint')),
          ...choices.map(([value, label]) => h('button', {
            class: 'gl-panel-action', type: 'button', 'aria-pressed': String(comments === value),
            onclick: () => {
              comments = value;
              commentsSelect.value = value;
              interactSheet.close();
              toast(t('liveSettingsUpdated'));
            },
          }, label))));
      interactSheet.open();
    };
    const openPromotion = () => {
      const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
      const promo = h('textarea', { class: 'field area', readonly: '', 'aria-label': t('promote') });
      promo.value = [t('livePromotionCopy'), title.value.trim(), link].filter(Boolean).join('\n');
      const copy = h('button', { class: 'gl-panel-action', type: 'button', onclick: async () => {
        copy.disabled = true;
        try {
          await copyLivePromotion(promo.value);
          toast(t('linkCopied'));
          promoteSheet.close();
        } catch (error) { toast(error?.message || t('copyUnavailable')); }
        finally { copy.disabled = false; }
      } }, t('copyLink'));
      promoteSheet.body.replaceChildren(
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('promote')),
          h('p', { class: 'gl-panel-note' }, t('livePromotionHint')),
          promo, copy));
      promoteSheet.open();
    };
    const openRewards = () => {
      const videoReady = this.goMode === 'audio' || hasCameraPreview();
      const missions = [
        [t('liveTitleMission'), !!title.value.trim()],
        [t('liveGoalMission'), !!goalInput.value.trim()],
        [t(this.goMode === 'audio' ? 'liveCameraNotUsed' : 'liveCameraMission'), videoReady],
      ];
      const completed = missions.filter(([, done]) => done).length;
      const goalAction = h('button', { class: 'gl-panel-action', type: 'button', onclick: () => {
        rewardsSheet.close();
        goalInput.hidden = false;
        requestAnimationFrame(() => goalInput.focus({ preventScroll: true }));
      } }, t('setLiveGoal'));
      const layoutAction = h('button', { class: 'gl-panel-action', type: 'button', onclick: () => { rewardsSheet.close(); guestSheet.open(); } }, t('multiGuest'));
      rewardsSheet.body.replaceChildren(
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('liveMissions')),
          ...missions.map(([label, done]) => readinessRow(label, t(done ? 'missionReady' : 'missionPending'), done)),
          h('div', { class: 'gl-progress-track', role: 'progressbar', 'aria-label': t('liveMissions'), 'aria-valuemin': '0', 'aria-valuemax': String(missions.length), 'aria-valuenow': String(completed) },
            h('span', { style: `width:${Math.round(completed / missions.length * 100)}%` }))),
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('viewerEngagementGoals')),
          h('p', { class: 'gl-panel-note' }, t('engagementStartsLive')),
          goalAction, layoutAction),
        h('section', { class: 'gl-panel-section' },
          h('h3', {}, t('creatorRewardProgress')),
          h('p', { class: 'gl-panel-note' }, t('rewardProgressHint'))));
      rewardsSheet.open();
    };
    const openPreliveShare = () => openShare({
      title: title.value.trim() || t('live'),
      text: t('shareLiveInvite'),
      url: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`,
    });
    const guestSheet = new Sheet({ title: t('multiGuestSettings'), className: 'lc-sheet gl-multi-sheet' });
    const guestLayoutCards = [
      ['fullscreen', 2, t('layoutFullScreen')], ['featured', 3, t('layoutFluidPanel')],
      ['fullscreen', 5, t('layoutFluidGrid')], ['fullscreen', 9, t('layoutFixedGrid')],
      ['featured', 2, t('layoutSideBySide')], ['featured', 4, t('layoutSpotlight')],
      ['fullscreen', 5, t('layoutRoundtableOne')], ['featured', 8, t('layoutRoundtableTwo')],
    ];
    let selectedLayout = 7;
    let acceptRequests = false;
    let guestAudience = '';
    let guestAudienceChoice = 'followers';
    const layoutCards = h('div', { class: 'gl-layout-cards' }, ...guestLayoutCards.map(([style, count, label], index) => h('button', {
      class: `gl-layout-card${index === selectedLayout ? ' is-selected' : ''}`, type: 'button', 'aria-pressed': String(index === selectedLayout),
      onclick: () => {
        selectedLayout = index;
        layoutStyle = style;
        layout = count;
        layoutCards.querySelectorAll('.gl-layout-card').forEach((item, itemIndex) => {
          item.classList.toggle('is-selected', itemIndex === index);
          item.setAttribute('aria-pressed', String(itemIndex === index));
        });
      },
    }, h('span', { 'aria-hidden': 'true' }, '▦'), h('b', {}, label))));
    const audienceOptions = [['everyone', 'open', t('everyone')], ['followers', 'approval', t('followers')], ['friends', 'approval', t('friends')], ['gifters', 'approval', t('gifters')]];
    const audienceChoices = h('div', { class: 'gl-audience-options', role: 'radiogroup', 'aria-label': t('admission') },
      ...audienceOptions.map(([choice, value, label]) => h('label', { class: 'gl-audience-option' },
        h('input', { type: 'radio', name: 'glGuestAudience', value: choice, checked: choice === guestAudienceChoice, onchange: event => {
          if (!event.target.checked) return;
          guestAudienceChoice = choice;
          guestAudience = value;
          acceptRequests = value === 'open';
          autoAccept.querySelector('input').checked = acceptRequests;
        } }),
        h('span', {}, label))));
    const autoAccept = h('label', { class: 'lc-toggle' }, h('span', {}, t('autoAcceptRequests')),
      h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch', onchange: event => {
        acceptRequests = event.target.checked;
        guestAudience = acceptRequests ? 'open' : 'approval';
        guestAudienceChoice = acceptRequests ? 'everyone' : 'followers';
        audienceChoices.querySelectorAll('input').forEach(input => { input.checked = input.value === guestAudienceChoice; });
      } }));
    guestSheet.body.append(h('section', { class: 'lc-section' },
      h('p', { class: 'lc-note' }, t('guestAdmissionSupportNote')),
      h('div', { class: 'gl-layout-heading' }, h('b', {}, t('guestLayout')), h('button', { class: 'gl-show-all', type: 'button', onclick: () => layoutCards.classList.toggle('show-all') }, t('showAll'))),
      layoutCards, autoAccept, audienceChoices));
    this.preGuestSheet = guestSheet;
    const dock = h('nav', { class: 'gl-dock', 'aria-label': t('goLive') });
    const dockTabs = [
      [t('live'), 'live'],
      [t('camera'), 'camera'],
      [t('create'), 'create'],
    ].map(([label, target], index) => h('button', {
      type: 'button', class: `gl-dock-tab${index === 0 ? ' selected' : ''}`, 'aria-current': index === 0 ? 'page' : null,
      onclick: async () => {
        if (target === 'live') {
          this.goMode = 'video';
          modeButtons.forEach((item, modeIndex) => {
            const selected = modeIndex === 3;
            item.classList.toggle('is-selected', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
          dockTabs.forEach((tab, tabIndex) => {
            const selected = tabIndex === 0;
            tab.classList.toggle('selected', selected);
            if (selected) tab.setAttribute('aria-current', 'page');
            else tab.removeAttribute('aria-current');
          });
          if (!this.goPreviewStream) void this.#startGoLivePreview('mode');
          return;
        }
        if (target === 'camera') {
          this.goMode = 'camera';
          modeButtons.forEach((item, modeIndex) => {
            const selected = modeIndex === 1;
            item.classList.toggle('is-selected', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
        }
        dockTabs.forEach((tab, tabIndex) => {
          const selected = tabIndex === (target === 'camera' ? 1 : 2);
          tab.classList.toggle('selected', selected);
          if (selected) tab.setAttribute('aria-current', 'page');
          else tab.removeAttribute('aria-current');
        });
        if (!this.hooks.openStudio) {
          toast(t('cameraAccessFailed'));
          return;
        }
        try {
          await this.hooks.openStudio(target);
          sheet.close();
        } catch (error) {
          toast(String(error?.message || t('cameraAccessFailed')).replace(/\b(?:null|undefined)\b/gi, '').trim() || t('cameraAccessFailed'));
        }
      },
    }, label));
    dock.append(...dockTabs);
    sheet.body.append(h('div', { class: 'gl-preview' }, this.goPreviewVideo,
      h('div', { class: 'gl-preview-overlay' }),
      h('header', { class: 'gl-topbar' }, close, h('div', { class: 'gl-top-actions' }, rewards, readiness, statusIcons)),
      mission, this.goPreviewError),
    h('form', { class: 'gl-form', onsubmit: event => {
      event.preventDefault();
      this.broadcastStarting = true;
      sheet.close();
      this.broadcastStarting = false;
      const liveTitle = [title.value.trim(), goalInput.value.trim() ? `${t('liveGoal')}: ${goalInput.value.trim()}` : ''].filter(Boolean).join(' · ').slice(0, 80);
      this.#broadcast(liveTitle, this.goMode === 'audio' ? 'audio' : 'video', {
        scope, admission: guestAudience || admission,
        comments, layout, layoutStyle, allowRequests: true, showGuestSlots: true,
      });
    } },
    toolRows, titleRow, goalInput, start, modeRow, dock));
    return sheet;
  }

  async #broadcast(title, mode, initialSettings = {}) {
    this.close();
    const stage = liveChrome({ host: true });
    stage.classList.add('host-stage');
    const room = `mw-${mode}-live-${crypto.randomUUID()}`;
    const live = { room, title: title || t('live'), mode, initialSettings, host: { id: auth.userId, name: auth.name, avatar: profiles.peek(auth.userId)?.avatar || '' } };
    paintLive(stage, live);
    document.body.append(stage);
    const wait = new WaitIndicator(stage);
    const session = new LiveSession(live, { host: true, mode });
    const picker = voicePicker(session);
    const controls = new HostControls(session, { openProfile: person => this.hooks.openProfile(person) });
    const unbind = connectUi(stage, session);
    let finished = false;
    let hostIdleTimer = 0;
    let hostHiddenTimer = 0;
    let hostBlurred = false;
    let hostLifecycleStarted = false;
    const hostInactive = () => document.visibilityState === 'hidden' || hostBlurred;
    const scheduleHostIdle = () => {
      clearTimeout(hostIdleTimer);
      if (!hostLifecycleStarted || hostInactive()) return;
      hostIdleTimer = setTimeout(() => {
        hostIdleTimer = 0;
        if (!hostInactive()) void finish(t('liveHostIdleEnded'));
        else syncHostLifecycle();
      }, HOST_IDLE_GRACE_MS);
    };
    const syncHostLifecycle = () => {
      if (!hostLifecycleStarted || finished) return;
      if (hostInactive()) {
        clearTimeout(hostIdleTimer);
        hostIdleTimer = 0;
        if (!hostHiddenTimer) {
          hostHiddenTimer = setTimeout(() => {
            hostHiddenTimer = 0;
            if (hostInactive()) void finish(t('liveHostIdleEnded'));
          }, HOST_HIDDEN_GRACE_MS);
        }
      } else {
        clearTimeout(hostHiddenTimer);
        hostHiddenTimer = 0;
        scheduleHostIdle();
      }
    };
    const onHostVisibility = () => syncHostLifecycle();
    const onHostBlur = () => { hostBlurred = true; syncHostLifecycle(); };
    const onHostFocus = () => { hostBlurred = false; syncHostLifecycle(); };
    const onHostActivity = () => { if (!hostInactive()) scheduleHostIdle(); };
    const startHostLifecycle = () => {
      hostLifecycleStarted = true;
      hostBlurred = !document.hasFocus();
      document.addEventListener('visibilitychange', onHostVisibility);
      window.addEventListener('blur', onHostBlur);
      window.addEventListener('focus', onHostFocus);
      stage.addEventListener('pointerdown', onHostActivity);
      stage.addEventListener('keydown', onHostActivity);
      stage.addEventListener('touchstart', onHostActivity);
      syncHostLifecycle();
    };
    const stopHostLifecycle = () => {
      hostLifecycleStarted = false;
      clearTimeout(hostIdleTimer);
      clearTimeout(hostHiddenTimer);
      document.removeEventListener('visibilitychange', onHostVisibility);
      window.removeEventListener('blur', onHostBlur);
      window.removeEventListener('focus', onHostFocus);
      stage.removeEventListener('pointerdown', onHostActivity);
      stage.removeEventListener('keydown', onHostActivity);
      stage.removeEventListener('touchstart', onHostActivity);
    };
    const finish = async reason => {
      if (finished) return;
      finished = true;
      stopHostLifecycle();
      wait.destroy();
      unbind();
      picker.destroy();
      controls.destroy();
      const localLeave = session.leave();
      let endError = null;
      let statusError = null;
      const endRequest = session.end().catch(error => { endError = error; });
      const statusRequest = endSession(room).catch(error => { statusError = error; });
      stage.remove();
      this.hooks.onClose();
      await Promise.all([endRequest, statusRequest]);
      try { await localLeave; } catch (error) { endError ||= error; }
      lives.refresh();
      if (endError) console.warn('[live] LiveKit end request failed', endError);
      if (statusError) console.warn('[live] LIVE status update failed', statusError);
      if (endError && statusError) toast(endError.message || statusError.message || t('liveUnavailable'));
      else if (reason) toast(reason);
    };
    stage.addEventListener('click', async event => {
      const button = event.target.closest('[data-act]');
      const act = button?.dataset.act;
      // Any tap on the host's screen unlocks audio playback, so the host hears approved guests (mobile autoplay rules).
      session.resumeAudio()?.catch?.(() => {});
      if (!act) return;
      if (streamControl(act, session, button, stage)) return;
      if (act === 'voice') picker.open();
      else if (act === 'end') finish();
      else if (act === 'retry') session.reconnect().catch(error => { toast(error?.message || t('liveUnavailable')); showRetry(stage, t('liveUnavailable')); });
      else if (act === 'share') openShare({ title: live.title || 'MilkyWay LIVE', url: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#live=${encodeURIComponent(live.room)}` });
      else if (act === 'guests') controls.openGuests();
      else if (act === 'guest-mute' || act === 'guest-remove' || act === 'guest-kick') {
        event.stopPropagation();
        const userId = button.dataset.uid;
        const member = button.closest('.live-guest')?._member;
        if (!userId) return;
        if (act === 'guest-kick' && !button.classList.contains('armed')) {
          // Removing someone from the LIVE needs a second tap.
          button.classList.add('armed'); button.title = t('tapAgain');
          setTimeout(() => { button.classList.remove('armed'); button.title = t('removeFromLive'); }, 3000);
          toast(t('tapAgain'));
          return;
        }
        const action = act === 'guest-mute' ? (member?.hostMuted ? 'allow-mic' : 'mute') : act === 'guest-remove' ? 'remove' : 'kick';
        button.disabled = true;
        session.control(action, { target: userId })
          .then(() => { if (act === 'guest-kick') toast(t('removed')); })
          .catch(error => toast(error?.message || t('liveUnavailable')))
          .finally(() => { button.disabled = false; });
      }
      else if (act === 'settings') controls.openSettings();
      else if (act === 'multi-guest') controls.openMultiGuest();
      else if (act === 'viewers') controls.openViewers();
      else if (act === 'moderation') controls.openModeration();
      else if (act === 'comments-toggle') {
        const next = session.settings.comments === 'off' ? 'everyone' : 'off';
        button.disabled = true;
        session.control('settings', { comments: next })
          .then(() => {
            button.setAttribute('aria-pressed', String(next === 'off'));
            toast(next === 'off' ? t('commentsOffNote') : t('commentsEnabled'));
          })
          .catch(error => toast(error?.message || t('liveUnavailable')))
          .finally(() => { button.disabled = false; });
      }
      else if (act === 'beautify') {
        const enabled = !stage.classList.contains('host-beautified');
        stage.classList.toggle('host-beautified', enabled);
        button.setAttribute('aria-pressed', String(enabled));
      }
      else if (act === 'profile') this.hooks.openProfile(live.host);
      else if (act === 'unpin') session.control('unpin').catch(error => toast(error.message));
      else if (act === 'guest') {
        // Boxes can appear (from the video track) before the room status names them.
        const member = button._member || { userId: button.dataset.uid, name: button.querySelector('.live-guest-name')?.textContent || '', state: 'speaker' };
        if (member.userId) controls.openPerson(member);
      }
      else if (act === 'comment') {
        const line = button._event;
        if (line?.uid) controls.openPerson({ userId: line.uid, name: line.name }, { id: line.id, body: line.body });
      }
    });
    stage.addEventListener('submit', event => {
      event.preventDefault();
      const input = stage._refs.input;
      if (input.value.trim()) { session.comment(input.value); input.value = ''; }
    });
    try {
      wait.start('broadcast', t('connectingLive'), { onCancel: () => { void finish(); } });
      await createSession({ room, title: live.title, scope: live.initialSettings.scope });
      startHostLifecycle();
      await session.join();
      const { admission, comments, layout, layoutStyle, allowRequests, showGuestSlots } = initialSettings;
      try {
        await session.control('settings', { admission, comments, layout, layoutStyle, allowRequests, showGuestSlots });
      } catch (error) {
        console.warn('[live] Could not apply preflight settings', error);
        toast(t('liveSettingFailed'));
      }
      wait.stop('broadcast');
    } catch (error) {
      wait.stop('broadcast');
      console.warn('[live] broadcast failed', error);
      toast(error?.name === 'NotAllowedError' ? t('cameraNeeded') : error.message || t('liveUnavailable'));
      finish();
    }
  }
}
