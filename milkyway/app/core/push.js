import { api, auth } from './net.js';
import { bus } from './events.js';

const OFFERED = 'mw_push_offer_at';
const DECLINED = 'mw_push_declines';
const COOLDOWN = 3 * 24 * 60 * 60 * 1000;
const ACTIONS = '[data-follow],#publicFollow,#mwLiveFollowHost,[data-sig],[data-echo],#echoSend,#threadSend,[data-repost],#msgUserBtn,#mwLiveCommentForm button[type=submit]';
const native = !!(window.Capacitor?.isNativePlatform?.());
const capacitor = window.Capacitor;
const push = native ? capacitor.Plugins?.PushNotifications || capacitor.registerPlugin?.('PushNotifications') : null;
let token = '';
let savedTokenKey = '';
let prompting = false;
let initialized = false;

function plugin(name) {
  return capacitor?.Plugins?.[name] || capacitor?.registerPlugin?.(name);
}

async function configureFirebase() {
  const bridge = plugin('MilkyWayNative');
  if (!bridge) return true;
  const info = await bridge.getInfo();
  if (info.firebaseReady) return true;
  const result = await api('/api/fcm?action=config', { authed: false, timeout: 8000 });
  if (!result?.firebase) throw new Error('Firebase push configuration is missing.');
  const configured = await bridge.configureFirebase(result.firebase);
  return configured?.firebaseReady === true;
}

async function registerNative() {
  if (!native || !push || !auth.signedIn()) return;
  const permissions = await push.checkPermissions();
  if (permissions.receive !== 'granted') return;
  if (!await configureFirebase()) throw new Error('Firebase could not be initialized.');
  await push.createChannel?.({
    id: 'milkyway_default',
    name: 'MilkyWay',
    description: 'Ujumbe, machapisho mapya na simu zinazoingia',
    importance: 5,
    sound: 'default',
    vibration: true,
    visibility: 1,
  });
  await push.register();
}

function applicationKey(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function registerWeb() {
  if (native || !auth.signedIn() || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission !== 'granted') return;
  const settings = await api('/api/milkyway-notifications?action=settings', { timeout: 10000 });
  if (!settings?.publicKey) throw new Error('Web Push is not configured.');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationKey(settings.publicKey),
  });
  await api('/api/milkyway-notifications?action=subscription', {
    method: 'POST',
    body: { subscription: subscription.toJSON() },
    timeout: 10000,
  });
}

async function register() {
  try {
    if (native) await registerNative();
    else await registerWeb();
  } catch (error) {
    console.warn('[push] Device registration failed.', error);
  }
}

async function permission() {
  if (native) {
    if (!push) return 'unavailable';
    try { return (await push.checkPermissions()).receive; } catch { return 'denied'; }
  }
  return 'Notification' in window ? Notification.permission : 'unavailable';
}

async function requestPermission() {
  if (native) {
    if (!push) return 'unavailable';
    let status = await push.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') status = await push.requestPermissions();
    if (status.receive === 'granted') await register();
    return status.receive;
  }
  if (!('Notification' in window)) return 'unavailable';
  const result = await Notification.requestPermission();
  if (result === 'granted') await register();
  return result;
}

async function offer() {
  if (prompting || !auth.signedIn()) return;
  const state = await permission();
  if (state === 'granted') { await register(); return; }
  if (state === 'denied' || state === 'unavailable') return;
  const last = Number(localStorage.getItem(OFFERED) || 0);
  const declines = Number(localStorage.getItem(DECLINED) || 0);
  if (Date.now() - last < COOLDOWN || declines >= 3) return;
  prompting = true;
  try {
    localStorage.setItem(OFFERED, String(Date.now()));
    const yes = window.confirm('Turn on notifications for new posts and incoming calls, even when MilkyWay is closed?');
    if (!yes) {
      localStorage.setItem(DECLINED, String(declines + 1));
      return;
    }
    const result = await requestPermission();
    if (result !== 'granted') console.info('[push] Notification permission was not granted.');
  } finally {
    prompting = false;
  }
}

async function saveToken() {
  if (!token || !auth.signedIn()) return;
  const key = `${token}|${auth.userId}`;
  if (savedTokenKey === key) return;
  try {
    await api('/api/fcm?action=register', { method: 'POST', body: { token }, timeout: 10000 });
    savedTokenKey = key;
  } catch (error) {
    console.warn('[push] FCM token could not be linked to this account.', error);
  }
}

export function initPushNotifications() {
  if (initialized) return;
  initialized = true;
  if (native && push) {
    push.addListener('registration', result => {
      token = String(result?.value || '');
      void saveToken();
    });
    push.addListener('registrationError', error => console.warn('[push] FCM registration failed.', error));
    push.addListener('pushNotificationActionPerformed', action => {
      const url = action?.notification?.data?.url;
      if (typeof url === 'string' && url.startsWith('/milkyway/')) location.href = url;
    });
  }
  document.addEventListener('click', event => {
    if (event.target.closest?.(ACTIONS)) setTimeout(() => {
      void offer().catch(error => console.warn('[push] Notification permission prompt failed.', error));
    }, 1200);
  }, { passive: true, capture: true });
  bus.on('auth', () => {
    savedTokenKey = '';
    if (auth.signedIn()) {
      void register();
      void saveToken();
    }
  });
  if (auth.signedIn()) void register();
}
