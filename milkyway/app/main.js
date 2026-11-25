// MilkyWay app entry.
//
// Startup budget (what happens before the first frame of content):
//   1. index.html paints the shell (static HTML + one CSS file) — no blocking scripts, no network.
//   2. This module reads the session from localStorage (sync) and the feed from IndexedDB (~10–30 ms).
//   3. The cached feed renders; video #1 starts. Network refresh, supabase-js, LiveKit and every sheet load later,
//      in the background or on first use.
import { auth, supabase } from './core/net.js';
import { bus, idle } from './core/events.js';
import { t } from './core/i18n.js';
import { FeedView } from './ui/feed-view.js';
import { playback } from './ui/playback.js';
import { toast } from './ui/dom.js';
import { profiles } from './data/profiles.js';
import { fetchSharedPost } from './data/feed.js';
import { startUpdateCheck } from './core/update-check.js';
import { initPushNotifications } from './core/push.js';
import { registrationIdentity } from './data/usernames.js';

// Conversation-room links belong to a screen that is not in this shell yet. Call links (#call=<id>) open the call screen.
const comingSoon = hash => /^#live=mw-conversation-/.test(hash);
const callLink = hash => /^#call=([a-f0-9-]{36})/i.exec(hash)?.[1] || null;
const soon = () => toast(t('soon'));

const $ = id => document.getElementById(id);
const shell = document.documentElement;

// ---- Lazily created panels (code downloads on first use) -------------------------------------------------
const lazy = loader => { let value; const get = () => (value ||= loader()); get.loaded = () => Boolean(value); return get; };
const authSheet = lazy(() => import('./ui/auth-sheet.js').then(m => new m.AuthSheet()));
const commentsSheet = lazy(() => import('./ui/comments-sheet.js').then(m => new m.CommentsSheet({ requireLogin })));
const giftTray = lazy(() => import('./ui/gift-tray.js').then(m => new m.GiftTray({
  onTopUp: () => novaMenu().then(menu => menu.openWallet()),
})));
const inboxView = lazy(() => import('./ui/inbox-view.js').then(m => new m.InboxView()));
const followersView = lazy(() => import('./ui/followers-view.js').then(m => new m.FollowersView({
  openProfile,
  openLive: room => showLive(room),
  requireLogin,
})));
function openCommunity() {
  if (!requireLogin()) return;
  document.querySelectorAll('.scope-tabs [role="tab"]').forEach(button => {
    button.setAttribute('aria-selected', String(button.hasAttribute('data-community')));
  });
  followersView().then(view => view.open({ id: auth.userId, name: auth.name }, { tab: 'suggested' }));
}
const callView = lazy(() => import('./ui/call-view.js').then(m => m.calls));
const novaMenu = lazy(() => import('./ui/settings-view.js').then(m => new m.NovaMenu({
  openGoLive,
  openProfilePhoto: file => {
    if (!requireLogin()) return;
    profileView().then(view => view.openForPhoto(file)).catch(error => toast(error?.message || t('photoUploadFailed')));
  },
  openStudioPost: post => {
    if (!post) { openCreate(); return; }
    postViewer().then(viewer => viewer.open([post], 0, { own: true }));
  },
})));
const profileView = lazy(() => import('./ui/profile-view.js').then(m => new m.ProfileView({
  requireLogin, openCreate, openComments: post => commentsSheet().then(sheet => sheet.open(post)),
  openMenu: profile => novaMenu().then(menu => menu.open(profile)),
  openChat: person => { if (requireLogin()) inboxView().then(view => view.openWith(person)); },
  openFollowers: (person, options) => followersView().then(view => view.open(person, options)),
  openActivity: person => followersView().then(view => view.open(person, { mode: 'activity' })),
})));
const profileSearch = lazy(() => import('./ui/profile-search.js').then(m => new m.ProfileSearch({ openProfile })));
const composeSheet = lazy(() => import('./ui/compose-sheet.js').then(m => new m.ComposeSheet({ onGoLive: openGoLive })));
// Full-size post popup for photos tapped in the Orbit feed (the same viewer the Nova grid uses).
const postViewer = lazy(() => import('./ui/post-viewer.js').then(m => new m.PostViewer({
  requireLogin,
  openComments: post => commentsSheet().then(sheet => sheet.open(post)),
})));
function openPost(post) {
  if (!post) return;
  playback.suspend(true);
  postViewer().then(viewer => {
    // A copy: the popup keeps its own counts; likes still go through the shared feed actions.
    viewer.open([{ ...post, _counted: true }], 0, { own: false, onClose: () => { if (shell.dataset.view === 'home') playback.suspend(false); } });
  }).catch(() => { playback.suspend(shell.dataset.view !== 'home'); toast(t('imageUnavailable')); });
}
let ambientLiveSession = null;
let ambientLiveRequest = 0;
let ambientLiveMuted = true;
const ambientControls = $('liveAmbientControls');
const ambientMuteButton = $('liveAmbientMute');
const ambientCloseButton = $('liveAmbientClose');
function paintAmbientControls() {
  const active = !!ambientLiveSession;
  if (ambientControls) ambientControls.hidden = !active;
  if (ambientCloseButton) {
    ambientCloseButton.setAttribute('aria-label', t('liveClosePreview'));
    ambientCloseButton.title = t('liveClosePreview');
  }
  if (!ambientMuteButton) return;
  ambientMuteButton.textContent = ambientLiveMuted ? '◖' : '◖))';
  ambientMuteButton.setAttribute('aria-label', t(ambientLiveMuted ? 'liveUnmutePreview' : 'liveMutePreview'));
  ambientMuteButton.title = t(ambientLiveMuted ? 'liveUnmutePreview' : 'liveMutePreview');
  ambientMuteButton.setAttribute('aria-pressed', String(!ambientLiveMuted));
}
async function listenLive(live) {
  if (!requireLogin()) throw new Error(t('signInToContinue'));
  if (!live?.room) throw new Error(t('liveUnavailable'));
  const request = ++ambientLiveRequest;
  if (ambientLiveSession?.live.room === live.room) {
    ambientLiveMuted = false;
    await ambientLiveSession.setAudioMuted(false);
    paintAmbientControls();
    return;
  }
  const previous = ambientLiveSession;
  ambientLiveSession = null;
  paintAmbientControls();
  await previous?.leave();
  const { LiveSession } = await import('./ui/live-session.js');
  if (request !== ambientLiveRequest || shell.dataset.view !== 'home') return;
  const session = new LiveSession(live, { audioOnly: true });
  ambientLiveSession = session;
  ambientLiveMuted = false;
  session.setAudioMuted(ambientLiveMuted);
  paintAmbientControls();
  try {
    await session.join();
    if (request === ambientLiveRequest && ambientLiveSession === session) session.setAudioMuted(ambientLiveMuted);
  } catch (error) {
    if (ambientLiveSession === session) {
      ambientLiveSession = null;
      paintAmbientControls();
    }
    await session.leave();
    if (request !== ambientLiveRequest) return;
    throw error;
  }
}
function takeAmbientSession(room) {
  const session = ambientLiveSession;
  if (!session) return null;
  ambientLiveSession = null;
  ambientLiveRequest++;
  paintAmbientControls();
  if (session.live.room === room) return session;
  void session.leave();
  return null;
}
ambientMuteButton?.addEventListener('click', () => {
  if (!ambientLiveSession) return;
  ambientLiveMuted = !ambientLiveMuted;
  ambientLiveSession.setAudioMuted(ambientLiveMuted).catch(error => {
    console.warn('[live] audio preview playback could not be updated', error);
    toast(t('liveAudioUnavailable'));
  });
  paintAmbientControls();
});
ambientCloseButton?.addEventListener('click', () => {
  const session = ambientLiveSession;
  ambientLiveSession = null;
  ambientLiveRequest++;
  paintAmbientControls();
  void session?.leave();
});
bus.on('auth', () => {
  if (auth.signedIn()) return;
  const session = ambientLiveSession;
  ambientLiveSession = null;
  ambientLiveRequest++;
  paintAmbientControls();
  void session?.leave();
});
playback.onMute(muted => {
  if (!ambientLiveSession) return;
  ambientLiveMuted = muted;
  ambientLiveSession.setAudioMuted(muted).catch(error => console.warn('[live] ambient audio mute could not be applied', error));
  paintAmbientControls();
});
const discoveryView = lazy(() => import('./ui/discovery-view.js').then(m => new m.DiscoveryView($('exploreView'), { openProfile, openPost })));
const liveView = lazy(() => import('./ui/live-view.js').then(m => new m.LiveView($('liveView'), {
  requireLogin, openProfile, onClose: () => showHome(),
  onPreliveClose: () => playback.suspend(shell.dataset.view !== 'home'),
  openRoom: room => showLive(room),
  listenLive,
  takeAmbientSession,
  openStudio: view => composeSheet().then(sheet => sheet.open(view)),
  openServiceStudio: () => novaMenu().then(menu => menu.openStudioSection('business')),
  openGifts: target => giftTray().then(tray => tray.open(target)),
})));

function requireLogin(force = false) {
  if (!force && auth.signedIn()) return true;
  authSheet().then(sheet => sheet.open());
  return false;
}
// Any author (feed / Lives) or, with no argument, the signed-in user's own profile.
function openProfile(person = null, options = {}) {
  if (!person?.id && !requireLogin()) return;
  profileView().then(view => view.open(person?.id ? person : null, options));
}
function openCreate() {
  if (requireLogin()) composeSheet().then(sheet => sheet.open());
}
function openLiveDirectory() {
  liveView().then(view => view.openDirectory()).catch(error => {
    console.error('[live] directory could not be opened', error);
    toast(t('liveUnavailable'));
  });
}

// ---- Feed ---------------------------------------------------------------------------------------------------
const feedView = new FeedView($('feedView'), {
  requireLogin,
  openProfile,
  openFollowers: (person, options) => followersView().then(view => view.open(person, options)),
  openComments: post => commentsSheet().then(sheet => sheet.open(post)),
  openGifts: target => giftTray().then(tray => tray.open(target)),
  openPost,
});

let scope = auth.signedIn() && localStorage.getItem('mw_core_scope') === 'following' ? 'following' : 'foryou';
function setScope(next) {
  if (next === 'following' && !requireLogin()) return;
  scope = next;
  try { localStorage.setItem('mw_core_scope', next); } catch {}
  document.querySelectorAll('.scope-tabs [role="tab"]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.scope === next));
  });
  feedView.show(next);
}

// ---- Views ------------------------------------------------------------------------------------------------
function setNav(name) {
  document.querySelectorAll('.nav-btn').forEach(button => button.toggleAttribute('aria-current', button.dataset.nav === name));
  shell.dataset.view = name;
}
function showHome() {
  if (liveView.loaded()) liveView().then(view => view.close());
  $('liveView').hidden = true;
  $('exploreView').hidden = true;
  $('feedView').hidden = false;
  playback.suspend(false);
  setNav('home');
  if (location.hash.startsWith('#live')) history.replaceState(null, '', location.pathname);
  feedView.focus();
}
function showLive(room = null) {
  if (!requireLogin()) return;
  playback.suspend(true);
  $('feedView').hidden = true;
  $('exploreView').hidden = true;
  $('liveView').hidden = false;
  setNav('live');
  if (!location.hash.startsWith('#live')) history.pushState({ live: true }, '', room ? `#live=${encodeURIComponent(room)}` : '#live');
  liveView().then(view => view.open(room));
}
function openGoLive() {
  if (!requireLogin()) return;
  liveView().then(view => {
    if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) playback.suspend(true);
    view.openGoLive();
  }).catch(error => {
    console.error('[live] studio could not be opened', error);
    playback.suspend(shell.dataset.view !== 'home');
    toast(error?.message || t('liveUnavailable'));
  });
}
function showExplore() {
  if (liveView.loaded()) liveView().then(view => view.close());
  if (location.hash.startsWith('#live')) history.replaceState(null, '', location.pathname + location.search);
  $('feedView').hidden = true;
  $('liveView').hidden = true;
  $('exploreView').hidden = false;
  playback.suspend(true);
  setNav('explore');
  discoveryView().then(view => view.open()).catch(error => {
    console.error('[explore] discovery view could not be opened', error);
    toast(t('exploreLoadFailed'));
  });
}

function route() {
  const call = callLink(location.hash);
  if (call) {
    const params = new URLSearchParams(location.search);
    const action = params.get('do') || '';
    params.delete('do');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    if (requireLogin()) callView().then(calls => calls.handleNotification(call, action));
  }
  if (comingSoon(location.hash)) { history.replaceState(null, '', location.pathname + location.search); soon(); }
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('live')) showLive(hash.split('=')[1] || null);
  else if (shell.dataset.view === 'live') showHome();
}
addEventListener('popstate', route);

document.addEventListener('click', event => {
  const target = event.target.closest('[data-scope], [data-community], [data-nav], #liveEntry, #profileSearch');
  if (!target) return;
  if (target.dataset.scope) { if (shell.dataset.view !== 'home') showHome(); setScope(target.dataset.scope); return; }
  if (target.hasAttribute('data-community')) { openCommunity(); return; }
  if (target.id === 'liveEntry') { openLiveDirectory(); return; }
  if (target.id === 'profileSearch') { profileSearch().then(view => view.open()); return; }
  const nav = target.dataset.nav;
  if (nav === 'home') { if (shell.dataset.view === 'home') feedView.reload(); else showHome(); }
  else if (nav === 'explore') showExplore();
  else if (nav === 'create') openCreate();
  else if (nav === 'inbox') { if (requireLogin()) inboxView().then(view => view.open()); }
  else if (nav === 'me') openProfile();
});

// ---- Connectivity + account changes ----------------------------------------------------------------------
let reconnectTimer = 0;
let reconnectAttempt = 0;
let reconnectInFlight = null;
const reconnectDelays = [0, 1500, 4000, 10_000, 30_000];
bus.on('offline', () => {
  $('netBanner').hidden = false;
  $('netBanner').textContent = t('offline');
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  reconnectAttempt = 0;
});
function scheduleConnectivityRefresh() {
  if (navigator.onLine === false || document.visibilityState !== 'visible' || reconnectTimer || reconnectInFlight) return;
  const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (navigator.onLine === false || document.visibilityState !== 'visible') return;
    let retryReconnect = false;
    reconnectInFlight = (async () => {
      try {
        const [liveData, feedData, presenceData] = await Promise.all([
          import('./data/live.js'),
          import('./data/feed.js'),
          import('./data/presence.js'),
        ]);
        const activeFeed = feedView.source;
        const tasks = [
          activeFeed?.refresh(),
          auth.signedIn() ? profiles.refreshFollowing() : Promise.resolve(true),
          liveData.lives.refresh(),
          liveData.watchLives(),
          feedData.watchPosts(() => scope),
          auth.signedIn() ? presenceData.presence.start() : Promise.resolve(),
          followersView.loaded() ? followersView().then(view => view.refresh()) : Promise.resolve(),
        ].filter(Boolean);
        const results = await Promise.allSettled(tasks);
        const failed = results.some(result => result.status === 'rejected'
          || (result.status === 'fulfilled' && result.value === false))
          || activeFeed?.source.error || liveData.lives.error;
        if (failed) {
          reconnectAttempt++;
          retryReconnect = true;
        } else reconnectAttempt = 0;
      } catch (error) {
        console.warn('[sync] reconnect refresh could not start', error);
        reconnectAttempt++;
        retryReconnect = true;
      }
    })().finally(() => {
      reconnectInFlight = null;
      if (retryReconnect) scheduleConnectivityRefresh();
    });
  }, delay);
}
bus.on('online', () => {
  if (!$('netBanner').hidden) { $('netBanner').hidden = true; toast(t('backOnline')); }
  scheduleConnectivityRefresh();
});
if (navigator.onLine === false) { $('netBanner').hidden = false; $('netBanner').textContent = t('offline'); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (navigator.onLine === false) {
    $('netBanner').hidden = false;
    $('netBanner').textContent = t('offline');
    return;
  }
  $('netBanner').hidden = true;
  scheduleConnectivityRefresh();
});
let syncingOAuthUsername = false;
async function syncPendingOAuthUsername() {
  const key = 'mw_pending_oauth_username';
  const raw = localStorage.getItem(key);
  if (!raw || !auth.signedIn() || syncingOAuthUsername) return;
  let pending;
  try { pending = JSON.parse(raw); }
  catch {
    localStorage.removeItem(key);
    return;
  }
  if (typeof pending?.username !== 'string' || !Number.isFinite(pending.startedAt)
    || Date.now() - pending.startedAt > 30 * 60 * 1000) {
    localStorage.removeItem(key);
    return;
  }
  const createdAt = Date.parse(auth.user?.created_at || '');
  if (!Number.isFinite(createdAt) || createdAt < pending.startedAt - 60_000) {
    localStorage.removeItem(key);
    return;
  }
  const userId = auth.userId;
  syncingOAuthUsername = true;
  try {
    const sb = await supabase();
    if (userId !== auth.userId) return;
    const identity = await registrationIdentity(sb, {
      email: auth.user?.email || '',
      requestedUsername: pending.username,
      excludeId: userId,
    });
    const { error } = await sb.from('mw_profiles').upsert(
      {
        id: userId,
        display_name: identity.displayName,
        username: identity.username,
        username_auto_generated: identity.usernameAutoGenerated,
        username_updated_at: identity.usernameAutoGenerated ? null : new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
    if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
  } catch (error) {
    console.error('[auth] Google sign-up username could not be saved', error);
    toast(error.message || 'Your username could not be saved. Please try again.');
  } finally {
    syncingOAuthUsername = false;
  }
}
bus.on('auth', () => {
  shell.toggleAttribute('data-signed-in', auth.signedIn());
  if (!auth.signedIn() && scope === 'following') scope = 'foryou';
  feedView.scope = null;
  setScope(scope);
  if (auth.signedIn()) {
    syncPendingOAuthUsername();
    startSignedIn();
  }
});
shell.toggleAttribute('data-signed-in', auth.signedIn());
playback.onMute(muted => shell.toggleAttribute('data-muted', muted));
shell.toggleAttribute('data-muted', playback.muted);

// ---- Go -----------------------------------------------------------------------------------------------------
document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
$('profileSearch').setAttribute('aria-label', t('searchPeople'));
$('profileSearch').title = t('searchPeople');
setScope(scope);
route();
const sharedPostId = new URLSearchParams(location.search).get('post');
if (sharedPostId) fetchSharedPost(sharedPostId).then(openPost).catch(error => toast(error?.message || t('imageUnavailable')));

// Signed-in extras, loaded when idle: incoming calls and online status.
let signedInStarted = false;
function startSignedIn() {
  if (signedInStarted || !auth.signedIn()) return;
  signedInStarted = true;
  callView().then(calls => calls.watch());
  import('./data/post-notifications.js').then(({ watchPostNotifications }) => watchPostNotifications())
    .catch(error => console.warn('[notifications] post realtime unavailable', error));
  import('./data/presence.js').then(({ presence }) => presence.start());
}

idle(() => {
  syncPendingOAuthUsername();
  profiles.loadFollowing();
  startSignedIn();
  // LIVE badge: show when someone is live (cached list first, quiet refresh).
  import('./data/live.js').then(({ lives, watchLives }) => {
    lives.subscribe(list => {
      const count = Array.isArray(list) ? list.length : 0;
      const button = $('liveEntry');
      const badge = $('liveEntryBadge');
      button?.classList.toggle('has-live', count > 0);
      if (badge) {
        badge.hidden = count === 0;
        badge.textContent = count > 9 ? '9+' : String(count);
        badge.setAttribute('aria-label', count ? `${count} ${t('liveRoomsNow')}` : '');
      }
      button?.setAttribute('aria-label', count ? `${t('live')} · ${count} ${t('liveRoomsNow')}` : t('live'));
      button?.setAttribute('title', count ? `${count} ${t('liveRoomsNow')}` : t('live'));
    });
    watchLives().catch(error => console.warn('[live] realtime directory updates unavailable', error));
    lives.load().catch(error => console.warn('[live] directory list unavailable', error));
  });
  if ('serviceWorker' in navigator) {
    // Notification taps forwarded by the worker: Lives and calls open here.
    navigator.serviceWorker.addEventListener('message', ({ data }) => {
      if (data?.type === 'mw-open-live' && data.url) {
        const hash = new URL(data.url).hash;
        if (comingSoon(hash)) soon();
        else { history.pushState(null, '', hash); route(); }
      } else if (data?.type === 'mw-call-push' || data?.type === 'mw-call-action') {
        const id = data.callId || data.call?.id || data.id || callLink(new URL(data.url || location.href, location.href).hash);
        if (auth.signedIn()) callView().then(calls => (id ? calls.handleNotification(String(id), data.action || '') : calls.watch()));
      }
    });
  }
  startUpdateCheck();
  initPushNotifications();
}, 2500);
