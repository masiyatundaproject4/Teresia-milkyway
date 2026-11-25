// Synchronized YouTube and direct-video playback shared by everyone in one DM or group.
import { auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import { t } from '../core/i18n.js';
import { h, toast } from './dom.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VIDEO_FILE = /\.(?:mp4|webm|ogv|m4v|mov|3gp|3g2)(?:$|\/)/i;
const YOUTUBE_ID = /^[\w-]{11}$/;
let youtubeApi;

export function watchableUrl(text = '') {
  const candidates = String(text).match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const url = normalizeWatchUrl(candidate.replace(/[),.!?;:]+$/, ''));
    if (url) return url.url;
  }
  return '';
}

function normalizeWatchUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let videoId = '';
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
    else if (['embed', 'shorts', 'live'].includes(parts[0])) videoId = parts[1] || '';
  }
  if (YOUTUBE_ID.test(videoId)) return { url: `https://www.youtube-nocookie.com/embed/${videoId}`, type: 'youtube', videoId };
  if (VIDEO_FILE.test(url.pathname)) return { url: url.href, type: 'video' };
  return null;
}

function getYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-mw-youtube-api]');
    const timeout = setTimeout(() => {
      youtubeApi = null;
      reject(new Error(t('watchPlayerFailed')));
    }, 15_000);
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      try { previousReady?.(); }
      catch (error) { console.warn('[watch-party] existing YouTube ready handler failed', error); }
      if (window.YT?.Player) resolve(window.YT);
      else { youtubeApi = null; reject(new Error(t('watchPlayerFailed'))); }
    };
    const script = existing || h('script', { src: 'https://www.youtube.com/iframe_api', async: true, 'data-mw-youtube-api': '' });
    script.addEventListener('error', () => {
      clearTimeout(timeout);
      youtubeApi = null;
      reject(new Error(t('watchPlayerFailed')));
    }, { once: true });
    if (!existing) document.head.append(script);
  });
  return youtubeApi;
}

export class WatchParty {
  constructor() {
    this.channel = null;
    this.connected = false;
    this.roomGeneration = 0;
    this.party = null;
    this.applyingRemote = false;
    this.player = null;
    this.playerKind = '';
    this.playerTimer = 0;
    this.sampleTime = null;
    this.sampleAt = 0;
    this.lastSyncAt = 0;

    this.url = h('input', {
      class: 'field watch-party-url', type: 'url', inputmode: 'url', autocomplete: 'url',
      placeholder: t('watchLinkPlaceholder'), 'aria-label': t('watchLinkPlaceholder'),
    });
    this.status = h('p', { class: 'watch-party-status', role: 'status', 'aria-live': 'polite' });
    this.playerBox = h('div', { class: 'watch-party-player', hidden: true });
    this.startButton = h('button', { class: 'pill-btn hot', type: 'submit' }, t('watchStart'));
    this.startButton.disabled = true;
    this.endButton = h('button', { class: 'pill-btn', type: 'button', hidden: true, onclick: () => this.#endParty() }, t('watchEnd'));
    this.takeControl = h('button', { class: 'pill-btn', type: 'button', hidden: true, onclick: () => this.#takeControl() }, t('watchTakeControl'));
    this.form = h('form', {
      class: 'watch-party-form',
      onsubmit: event => { event.preventDefault(); this.#startParty(); },
    }, this.url, this.startButton);
    this.root = h('section', { class: 'watch-party', 'aria-label': t('watchTogether'), hidden: true },
      h('div', { class: 'watch-party-top' }, this.status, this.takeControl, this.endButton),
      this.form,
      this.playerBox);
    bus.on('auth', () => this.leave());
  }

  async join(type, id) {
    if (!auth.signedIn() || !['dm', 'group'].includes(type) || !UUID.test(String(id || ''))) {
      this.leave();
      return;
    }
    const generation = ++this.roomGeneration;
    await this.#removeChannel();
    if (generation !== this.roomGeneration) return;
    this.roomId = String(id);
    this.roomType = type;
    const topic = type === 'dm'
      ? `mw-watch:dm:${[auth.userId, this.roomId].sort().join(':')}`
      : `mw-watch:group:${this.roomId}`;
    const client = await supabase();
    if (generation !== this.roomGeneration) return;
    const channel = client.channel(topic, {
      config: { private: true, broadcast: { ack: true, self: false }, presence: { key: auth.userId } },
    });
    this.channel = channel;
    channel
      .on('broadcast', { event: 'watch-party' }, ({ payload }) => this.#receive(payload, generation))
      .on('presence', { event: 'sync' }, () => this.#presenceSync(generation));

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (generation !== this.roomGeneration) return resolve();
        reject(new Error(t('watchConnectFailed')));
      }, 12_000);
      channel.subscribe(async status => {
        if (generation !== this.roomGeneration) { clearTimeout(timeout); resolve(); return; }
        if (status === 'SUBSCRIBED') {
          try {
            const result = await channel.track({ userId: auth.userId, party: this.party || null });
            if (result !== 'ok') throw new Error(t('watchConnectFailed'));
            this.connected = true;
            this.startButton.disabled = false;
            this.endButton.disabled = false;
            this.takeControl.disabled = false;
            clearTimeout(timeout);
            if (!this.party) this.status.textContent = t('watchReady');
            resolve();
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          this.connected = false;
          this.startButton.disabled = true;
          this.endButton.disabled = true;
          this.takeControl.disabled = true;
          this.status.textContent = t('watchConnectFailed');
          clearTimeout(timeout);
          reject(new Error(t('watchConnectFailed')));
        }
      });
    }).catch(error => {
      if (generation !== this.roomGeneration) return;
      this.leave();
      toast(error?.message || t('watchConnectFailed'));
    });
  }

  async leave() {
    ++this.roomGeneration;
    await this.#removeChannel();
  }

  async #removeChannel() {
    const channel = this.channel;
    this.channel = null;
    this.connected = false;
    this.startButton.disabled = true;
    this.endButton.disabled = true;
    this.takeControl.disabled = true;
    this.roomId = '';
    this.roomType = '';
    this.party = null;
    this.root.hidden = true;
    this.status.textContent = '';
    this.url.value = '';
    this.#destroyPlayer();
    if (channel) {
      const client = await supabase().catch(error => {
        console.warn('[watch-party] realtime client unavailable during cleanup', error);
        return null;
      });
      if (client) {
        const result = await client.removeChannel(channel).catch(error => {
          console.warn('[watch-party] realtime channel cleanup failed', error);
          return null;
        });
        if (result && result !== 'ok') console.warn('[watch-party] realtime channel cleanup returned', result);
      }
    }
  }

  async startFromLink(value) {
    const parsed = normalizeWatchUrl(value);
    if (!parsed) {
      toast(t('watchInvalidLink'));
      return;
    }
    if (!this.connected) { toast(t('watchConnecting')); return; }
    this.root.hidden = false;
    this.url.value = parsed.url;
    await this.#publish('load', {
      url: parsed.url, kind: parsed.type, videoId: parsed.videoId || '',
      position: 0, playing: false, hostId: auth.userId,
    });
  }

  openPanel() {
    this.root.hidden = !this.root.hidden;
    if (!this.root.hidden && !this.party) this.url.focus({ preventScroll: true });
  }

  #presenceSync(generation) {
    if (generation !== this.roomGeneration) return;
    const states = this.channel?.presenceState() || {};
    const parties = Object.values(states).flat().map(meta => meta.party).filter(party => party?.id && party?.url);
    const latest = parties.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))[0];
    if (latest && (!this.party || Number(latest.updatedAt) > Number(this.party.updatedAt))) {
      this.root.hidden = false;
      this.#applyParty(latest);
    } else if (!parties.length && this.party) {
      this.#clearParty(false);
    }
  }

  async #receive(payload, generation) {
    if (generation !== this.roomGeneration || payload?.senderId === auth.userId) return;
    if (payload?.type === 'close') {
      if (this.party && (payload.senderId !== this.party.hostId || payload.partyId !== this.party.id)) return;
      this.#clearParty(true);
      return;
    }
    if (payload?.type === 'load' || payload?.type === 'control') {
      if (this.#applyParty(payload.party)) {
        try { await this.#trackParty(this.party); }
        catch (error) { toast(error?.message || t('watchSyncFailed')); }
      }
    }
    if (['play', 'pause', 'seek', 'sync'].includes(payload?.type)) {
      const party = {
        ...this.party, position: payload.position,
        playing: payload.type === 'play' || (payload.type !== 'pause' && Boolean(payload.playing)),
        updatedAt: payload.updatedAt,
      };
      if (!party.id) return;
      if (this.#applyParty(party)) {
        try { await this.#trackParty(this.party); }
        catch (error) { toast(error?.message || t('watchSyncFailed')); }
      }
    }
  }

  async #publish(type, details = {}) {
    if (!this.connected || !this.channel || !this.party && type !== 'load') {
      if (type !== 'load') return;
      if (!this.roomType || !this.roomId) { toast(t('watchChooseChat')); return; }
    }
    const party = type === 'load'
      ? { ...details, id: crypto.randomUUID(), updatedAt: Date.now() }
      : { ...this.party, ...details, updatedAt: Date.now() };
    if (type === 'close') {
      try {
        await this.#sendEvent({ type, senderId: auth.userId, partyId: this.party?.id });
        this.#clearParty(true);
      } catch (error) { toast(error?.message || t('watchSyncFailed')); }
      return;
    }
    try {
      await this.#sendEvent({ type, senderId: auth.userId, party });
      if (this.#applyParty(party)) await this.#trackParty(this.party);
    } catch (error) {
      toast(error?.message || t('watchSyncFailed'));
    }
  }

  async #sendEvent(payload) {
    if (!this.channel) throw new Error(t('watchConnectFailed'));
    const result = await this.channel.send({ type: 'broadcast', event: 'watch-party', payload });
    if (result?.status !== 'ok') throw new Error(t('watchSyncFailed'));
  }

  async #trackParty(party) {
    if (!this.channel) return;
    const result = await this.channel.track({ userId: auth.userId, party });
    if (result !== 'ok') throw new Error(t('watchSyncFailed'));
  }

  async #startParty() {
    const parsed = normalizeWatchUrl(this.url.value);
    if (!parsed) { toast(t('watchInvalidLink')); return; }
    this.startButton.disabled = true;
    try {
      await this.#publish('load', {
        url: parsed.url, kind: parsed.type, videoId: parsed.videoId || '',
        position: 0, playing: false, hostId: auth.userId,
      });
    } finally { this.startButton.disabled = false; }
  }

  async #takeControl() {
    if (!this.party) return;
    await this.#publish('control', { hostId: auth.userId });
  }

  async #endParty() {
    if (this.party?.hostId !== auth.userId) return;
    await this.#publish('close');
  }

  #applyParty(party) {
    const parsed = normalizeWatchUrl(party?.url);
    const position = Number(party?.position);
    const updatedAt = Number(party?.updatedAt);
    if (!parsed || !UUID.test(String(party?.id || '')) || !UUID.test(String(party?.hostId || ''))
      || !Number.isFinite(position) || position < 0 || position > 86_400 || !Number.isFinite(updatedAt)) return false;
    if (this.party && updatedAt < Number(this.party.updatedAt)) return false;
    const isNew = this.party?.id !== party.id || this.party?.url !== parsed.url;
    this.party = { ...party, position, updatedAt, url: parsed.url, kind: parsed.type };
    this.root.hidden = false;
    this.playerBox.hidden = false;
    this.status.textContent = party.hostId === auth.userId ? t('watchHosting') : t('watchViewing');
    this.endButton.hidden = party.hostId !== auth.userId;
    this.takeControl.hidden = party.hostId === auth.userId;
    this.endButton.disabled = !this.connected;
    this.takeControl.disabled = !this.connected;
    if (isNew) {
      this.#destroyPlayer();
      this.#createPlayer(parsed, this.party);
    } else this.#syncPlayer(this.party);
    return true;
  }

  async #createPlayer(parsed, party) {
    this.playerBox.replaceChildren();
    if (parsed.type === 'video') {
      const video = h('video', {
        class: 'watch-party-media', controls: true, playsinline: true, preload: 'metadata',
        src: parsed.url,
      });
      this.playerBox.append(video);
      this.player = video;
      this.playerKind = 'video';
      this.#startSampler();
      video.addEventListener('loadedmetadata', () => this.#syncPlayer(this.party));
      video.addEventListener('play', () => this.#userAction('play'));
      video.addEventListener('pause', () => this.#userAction('pause'));
      video.addEventListener('seeking', () => this.#userAction('seek'));
      video.addEventListener('error', () => { this.status.textContent = t('watchPlayerFailed'); });
      this.#syncPlayer(party);
      return;
    }
    const mount = h('div', { class: 'watch-party-youtube' });
    this.playerBox.append(mount);
    this.playerKind = 'youtube';
    try {
      const YT = await getYouTubeApi();
      if (this.party?.id !== party.id || !mount.isConnected) return;
      this.player = new YT.Player(mount, {
        videoId: parsed.videoId,
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => this.#syncPlayer(this.party),
          onStateChange: event => {
            const states = window.YT?.PlayerState || {};
            if (this.applyingRemote || Date.now() < this.applyingUntil) return;
            if (event.data === states.PLAYING) this.#userAction('play');
            else if (event.data === states.PAUSED || event.data === states.ENDED) this.#userAction('pause');
          },
          onError: () => { this.status.textContent = t('watchPlayerFailed'); },
        },
      });
      this.#startSampler();
      this.#syncPlayer(party);
    } catch (error) {
      if (this.party?.id === party.id) {
        this.status.textContent = error?.message || t('watchPlayerFailed');
        toast(this.status.textContent);
      }
    }
  }

  #syncPlayer(party) {
    if (!party || !this.player) return;
    const baseTime = Math.max(0, Number(party.position) || 0);
    const position = baseTime + (party.playing ? Math.max(0, Date.now() - Number(party.updatedAt || Date.now())) / 1000 : 0);
    this.applyingRemote = true;
    this.applyingUntil = Date.now() + 1800;
    if (this.playerKind === 'video') {
      if (Number.isFinite(this.player.duration) && Math.abs(this.player.currentTime - position) > 1.5) this.player.currentTime = position;
      if (party.playing) this.player.play().catch(() => { this.status.textContent = t('watchTapToPlay'); });
      else this.player.pause();
    } else if (this.player.getPlayerState) {
      if (Math.abs(this.player.getCurrentTime() - position) > 1.5) this.player.seekTo(position, true);
      if (party.playing) this.player.playVideo();
      else this.player.pauseVideo();
    }
    setTimeout(() => { this.applyingRemote = false; }, 1200);
  }

  #userAction(type) {
    if (this.applyingRemote || Date.now() < this.applyingUntil || !this.party) return;
    const position = this.#currentTime();
    this.sampleTime = position;
    this.sampleAt = Date.now();
    this.lastSyncAt = this.sampleAt;
    const playing = type === 'play' || (type !== 'pause' && this.#isPlaying());
    this.#publish(type, { position, playing });
  }

  #currentTime() {
    try {
      return this.playerKind === 'video' ? Number(this.player?.currentTime) || 0
        : Number(this.player?.getCurrentTime?.()) || 0;
    } catch { return Number(this.party?.position) || 0; }
  }

  #startSampler() {
    clearInterval(this.playerTimer);
    this.lastSyncAt = Date.now();
    this.playerTimer = setInterval(() => {
      if (!this.party || !this.player || this.applyingRemote || Date.now() < this.applyingUntil) return;
      const now = Date.now(), time = this.#currentTime();
      const expectedAdvance = this.party.playing ? (now - this.sampleAt) / 1000 : 0;
      if (this.sampleTime != null && Math.abs(time - this.sampleTime - expectedAdvance) > 2.5) {
        this.#userAction('seek');
      }
      if (this.party.hostId === auth.userId && now - this.lastSyncAt >= 5000) {
        this.lastSyncAt = now;
        this.#publish('sync', { position: time, playing: this.#isPlaying() });
      }
      this.sampleTime = time;
      this.sampleAt = now;
    }, 1200);
  }

  #isPlaying() {
    try {
      if (this.playerKind === 'video') return !this.player.paused && !this.player.ended;
      const state = window.YT?.PlayerState || {};
      return this.player?.getPlayerState?.() === state.PLAYING;
    } catch { return Boolean(this.party?.playing); }
  }

  #clearParty(remote) {
    if (remote && this.channel) this.#trackParty(null).catch(error => console.warn('[watch-party] presence cleanup failed', error));
    this.party = null;
    this.#destroyPlayer();
    this.playerBox.hidden = true;
    this.playerBox.replaceChildren();
    this.status.textContent = this.channel ? t('watchReady') : '';
    this.endButton.hidden = true;
    this.takeControl.hidden = true;
  }

  #destroyPlayer() {
    clearInterval(this.playerTimer);
    this.playerTimer = 0;
    if (this.playerKind === 'video' && this.player) {
      this.player.pause();
      this.player.removeAttribute('src');
      this.player.load();
    } else if (this.playerKind === 'youtube' && this.player?.destroy) {
      this.player.destroy();
    }
    this.player = null;
    this.playerKind = '';
    this.sampleTime = null;
    this.sampleAt = 0;
    this.applyingRemote = false;
  }
}
