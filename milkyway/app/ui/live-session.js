// LiveSession — one real-time Live connection (viewer or host).
//
// Media:   LiveKit (WebRTC SFU) with adaptive stream + dynacast, so each viewer only receives the layer its screen needs.
// Events:  comments and gifts travel on LiveKit data channels, then are verified against server-persisted records
//          before they are rendered. Supabase Realtime is used only for presence; the client cannot author events.
// History: comments are persisted through /api/milkyway-live-room so late joiners see the recent conversation.
// Viewers: counted from LiveKit participants (authoritative), Realtime presence when LiveKit is not connected.
//
// Stage:   every viewer enters as a silent subscriber (token canPublish:false, canPublishData:true; mic and camera are
//          forced off). "Request to join" is stored by the server AND sent to the host as a LiveKit data packet, so it
//          shows on the host's screen at once. Only the host's Approve upgrades the guest's LiveKit permissions (the
//          server calls UpdateParticipant); the guest's camera and mic switch on only after LiveKit confirms them.
//          Stage states (session.stage): 'host' | 'audience' | 'requested' | 'invited' | 'joining' | 'guest'.
//
// Two-way audio: every client (host included) connects with autoSubscribe:true and also subscribes explicitly to any
//          remote microphone track that is published, so the host always receives an approved guest's audio. Each
//          remote audio track gets its own <audio autoplay> element in the page (RoomEvent.TrackSubscribed). Mobile
//          browsers block playback until a tap, so the first tap anywhere unlocks it (room.startAudio + play()).
//          Own microphone tracks are never attached locally, and capture uses echo cancellation, so nobody hears
//          themselves back.
// Co-host: when the host approves, the server grants the rights on the live connection (UpdateParticipant). If this
//          connection does not hold canPublish right away, the guest immediately fetches a FRESH publisher token
//          (canPublish:true, canSubscribe:true — signed only because the approval is on record) and reconnects with
//          it, then camera + microphone switch on (enableCameraAndMicrophone).
//
// Live room signals: understands {type:'lv-heart'} / {type:'lv-sync'} signals and sends them.
import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { TRANSPARENT_VIDEO_POSTER } from '../core/media.js';
import { api, auth, supabase, accessToken } from '../core/net.js';
import { loadLiveKit } from '../core/sdk.js';
import { assertRoomAccess } from '../core/livekit-access.js';
import { device } from '../core/device.js';
import { sendGift } from '../data/gifts.js';
import { createVoiceEffects, VOICE_PRESETS } from './voice-effects.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOPIC = 'mw';
const SAFETY_POLL_MS = 20_000;
const HOST_POLL_MS = 4_000;   // the host watches guest requests closely
const STAGE_POLL_MS = 5_000;  // viewers who requested, were invited or are on stage
const HOST_GRACE_MS = 25_000;
const tokenCache = new Map(); // room → { payload, at }
const tokenRequests = new Map();
const endedRooms = new Set();
const roomMembers = status => Array.isArray(status?.members)
  ? status.members.filter(member => member && typeof member === 'object' && member.userId)
  : [];
// Host decision → the signal the affected viewer receives (they re-read the room at once).
const HOST_SIGNALS = { approve: 'stage-approve', reject: 'stage-reject', remove: 'stage-remove', kick: 'stage-remove', mute: 'stage-mute', 'allow-mic': 'stage-unmute', invite: 'stage-invite', 'cancel-invite': 'stage-invite' };

class Emitter {
  #handlers = new Map();
  on(type, fn) { (this.#handlers.get(type) || this.#handlers.set(type, new Set()).get(type)).add(fn); return () => this.#handlers.get(type)?.delete(fn); }
  emit(type, detail) { this.#handlers.get(type)?.forEach(fn => { try { fn(detail); } catch (error) { console.error(error); } }); }
}

const isJson = response => response && ![404, 405].includes(response.status) && /json/.test(response.headers.get('content-type') || '');

// LiveKit refuses tokens signed with a key from another project: "could not establish signal connection: invalid API key".
export const isKeyRejection = error => /invalid api key|api key|signal connection|unauthori[sz]ed|\b401\b/i.test(String(error?.message || error || ''));

// Asks the Supabase livekit-token Edge Function (it signs with the LiveKit secrets stored in Supabase).
async function directToken(body) {
  const token = await accessToken();
  const response = await fetch(config.livekit.directTokenEndpoint, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', apikey: config.supabase.anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!isJson(response)) throw Object.assign(new Error('LIVE unavailable'), { status: response.status });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error || 'LIVE unavailable'), { status: response.status });
  return payload;
}

// Viewers always enter as subscribers (no camera / mic rights). Only `stage` — an approved guest reconnecting — asks
// the server for a publisher token, which it signs only when the host's approval is on record.
async function requestToken(live, host, { direct = false, stage = false } = {}) {
  const body = {
    room: live.room, roomName: live.room, identity: auth.userId, name: auth.name, participantName: auth.name,
    role: host ? 'host' : 'viewer', title: live.title, scope: 'public', action: 'token', ...(stage && !host ? { stage: true } : {}),
  };
  let payload;
  if (direct) payload = await directToken(body);
  else {
    try { payload = await api(config.livekit.tokenEndpoint, { method: 'POST', body, timeout: 12000 }); }
    catch (error) {
      // Only when the site API itself is missing on this host (static mirror: an HTML 404/405) or unreachable, use the
      // Edge Function. A real JSON answer from the site API ("session ended", "followers only"…) is final.
      const routeMissing = [404, 405].includes(error.status) && /^HTTP \d+$/.test(error.message || '');
      const missing = !error.status || routeMissing || (error.status === 502 && /invalid response/i.test(error.message || ''));
      if (!missing) throw error;
      try { payload = await directToken(body); } catch { throw error; }
    }
  }
  return assertRoomAccess(payload, live.room);
}

async function fetchToken(live, host, options = {}) {
  if (endedRooms.has(live.room)) throw Object.assign(new Error('This Live session has ended.'), { status: 404 });
  const { direct = false, stage = false } = options;
  const cacheable = !direct && !host && !stage;
  const cached = tokenCache.get(live.room);
  if (cacheable && cached && cached.payload && Date.now() - cached.at < 30_000) return cached.payload;
  const key = `${live.room}:${host ? 'host' : stage ? 'stage' : 'viewer'}:${direct ? 'direct' : 'api'}`;
  if (cacheable && tokenRequests.has(key)) return tokenRequests.get(key);
  const pending = requestToken(live, host, options).then(payload => {
    if (endedRooms.has(live.room)) throw Object.assign(new Error('This Live session has ended.'), { status: 404 });
    if (cacheable) tokenCache.set(live.room, { payload, at: Date.now() });
    return payload;
  }).finally(() => tokenRequests.delete(key));
  if (cacheable) tokenRequests.set(key, pending);
  return pending;
}

export class LiveSession extends Emitter {
  /** Loads the media SDK and caches a subscriber token before the first frame is requested. */
  static warm(live) {
    return Promise.all([loadLiveKit(), fetchToken(live, false)]);
  }

  constructor(live, { host = false, mode = live.mode || 'video', audioOnly = false } = {}) {
    super();
    this.live = live;
    this.host = host;
    this.mode = mode;
    this.audioOnly = audioOnly;
    this.audioMuted = false;
    this.room = null;
    this.channel = null;
    this.seen = new Set();
    this.closed = false;
    this.viewers = 0;
    this.likeBatch = 0;
    this.status = null;      // last /live-room status: settings, self, members, messages
    this.onStage = false;    // a guest whose camera / mic are live right now
    this.approving = new Set();
    this.stageAction = null;
    this.entered = false;    // true after the first connection of this visit; later joins are reconnects
    this.joinPromise = null;
    this.stage = host ? 'host' : 'audience';
    this.voicePreset = 'normal';
    this.voiceCapture = null;
    this.voiceEnabled = false;
    this.noiseSuppression = true;
  }

  get settings() { return this.status?.settings || {}; }
  get self() { return this.status?.self || null; }
  /** Whether the server has this viewer seated on stage (approved by the host). The host's own account opening its
   *  room as a viewer is never a guest. */
  get seated() { return !this.host && !this.self?.host && this.self?.state === 'speaker'; }
  get canPublish() { return !!this.room?.localParticipant?.permissions?.canPublish; }

  async setNoiseSuppression(enabled) {
    const next = !!enabled;
    const tracks = this.voiceCapture?.input.getAudioTracks() || [];
    await Promise.all(tracks.map(track => {
      const supported = track.getCapabilities?.().noiseSuppression;
      if (Array.isArray(supported) && !supported.includes(next)) {
        throw new Error(t('liveFeatureUnavailable'));
      }
      return track.applyConstraints({ noiseSuppression: next });
    }));
    this.noiseSuppression = next;
  }

  #setStage(next) {
    if (this.stage === next) return;
    this.stage = next;
    this.emit('stage-state', next);
  }

  #beginStageAction(action) {
    if (this.stageAction) return false;
    this.stageAction = action;
    this.emit('stage-action', action);
    return true;
  }

  #endStageAction() {
    this.stageAction = null;
    this.emit('stage-action', null);
  }

  // The viewer's stage state from the server record + LiveKit rights. 'joining' = approved, rights arriving.
  #deriveStage() {
    if (this.host) return 'host';
    const self = this.self;
    if (this.seated) return this.onStage ? 'guest' : 'joining';
    if (self?.state === 'pending') return 'requested';
    if (self?.invited) return 'invited';
    return 'audience';
  }

  /** Connects media + event channels. Resolves when watching (or throws with a readable message). */
  join() {
    if (this.joinPromise) return this.joinPromise;
    const pending = this.#join();
    this.joinPromise = pending;
    return pending.finally(() => {
      if (this.joinPromise === pending) this.joinPromise = null;
    });
  }

  async #join() {
    this.emit('state', 'connecting');
    if (!this.channel) this.#openRealtime(); // in parallel; never blocks the video
    const rejoin = this.entered;
    // A publisher token only for an approved guest reconnecting within this visit.
    const stage = rejoin && this.seated;
    // A fresh visit clears any seat or request left over from an earlier visit, so the viewer starts as a subscriber.
    this.#loadHistory({ enter: !rejoin && !this.host });
    const [sdk, token] = await Promise.all([loadLiveKit(), fetchToken(this.live, this.host, { stage })]);
    if (this.closed) return;
    const { Room, RoomEvent, Track } = sdk;
    const mobileStart = device.lowEnd || device.slowNetwork || innerWidth <= 760;
    // LiveKit's SFU supplies the ICE/TURN configuration; leave ICE servers and SDK reconnection policy to the SDK.
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      publishDefaults: {
        videoEncoding: { maxBitrate: mobileStart ? 700_000 : 1_500_000, maxFramerate: mobileStart ? 24 : 30 },
        simulcast: true,
      },
      videoCaptureDefaults: { resolution: mobileStart ? { width: 640, height: 360, frameRate: 24 } : { width: 1280, height: 720, frameRate: 30 }, facingMode: 'user' },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.room = room;
    this.sdk = sdk;
    this.#installAudioUnlock();

    room
      // A remote track was published (host's stream for viewers, an approved guest's camera / mic for the host):
      // make sure it is subscribed, even if auto-subscribe was skipped for it.
      .on(RoomEvent.TrackPublished, (publication, participant) => this.#subscribe(publication, participant))
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => this.#attach(track, participant, Track))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => { track.detach().forEach(element => { this.audioElements?.delete(element); element.remove(); }); if (track.kind === 'video') this.emit('video-gone', participant.identity); })
      .on(RoomEvent.LocalTrackPublished, publication => {
        // Hard guard: a viewer who is not an approved guest never publishes anything, whatever called it.
        if (!this.host && !this.onStage) { room.localParticipant.unpublishTrack(publication.track).catch(() => {}); return; }
        if (publication.track?.kind === 'video') this.#attach(publication.track, room.localParticipant, Track, true);
        this.#emitMedia();
      })
      .on(RoomEvent.LocalTrackUnpublished, publication => {
        if (publication.kind === 'video' || publication.track?.kind === 'video') { publication.track?.detach().forEach(element => element.remove()); this.emit('video-gone', room.localParticipant.identity); }
        this.#emitMedia();
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => { this.emit('track-muted', { participant: participant.identity, kind: publication.kind, muted: true }); if (participant?.isLocal) this.#emitMedia(); })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => { this.emit('track-muted', { participant: participant.identity, kind: publication.kind, muted: false }); if (participant?.isLocal) this.#emitMedia(); })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
        // The host just approved, muted or removed this guest (LiveKit pushed the new rights): act on them now.
        if (participant === room.localParticipant || participant?.isLocal || !participant) { this.#syncStage(); this.#refreshSoon(); }
      })
      .on(RoomEvent.ParticipantConnected, participant => {
        this.#countViewers(); this.emit('audience');
        if (participant.identity === this.live.host.id) clearTimeout(this.hostTimer);
        // Someone the host removed tried to come back: disconnect them again.
        if (this.host && this.settings.blockedIds?.includes(participant.identity)) this.control('kick', { target: participant.identity }, { quiet: true }).catch(() => {});
      })
      .on(RoomEvent.ParticipantDisconnected, participant => {
        this.#countViewers(); this.emit('audience');
        if (!this.host && participant.identity === this.live.host.id) {
          clearTimeout(this.hostTimer);
          this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
        }
      })
      .on(RoomEvent.DataReceived, (payload, participant) => this.#receive(payload, participant))
      .on(RoomEvent.Reconnecting, () => this.emit('state', 'reconnecting'))
      .on(RoomEvent.Reconnected, () => { this.emit('state', 'connected'); this.#loadHistory(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit('audio-blocked', !room.canPlaybackAudio))
      .on(RoomEvent.Disconnected, reason => {
        if (this.closed) return;
        if (reason != null && reason === sdk.DisconnectReason?.ROOM_DELETED) this.#ended();
        else if (reason != null && reason === sdk.DisconnectReason?.PARTICIPANT_REMOVED) this.#removed();
        else this.emit('state', 'disconnected');
      });

    try { await room.connect(token.serverUrl, token.token, { autoSubscribe: true }); }
    catch (error) {
      tokenCache.delete(this.live.room);
      if (this.closed || !(isKeyRejection(error) || /token|expired/i.test(String(error?.message || '')))) throw error;
      // "invalid API key": this host signed with a key LiveKit does not know, so asking it again cannot help. The
      // Supabase function signs with the LiveKit project's own secrets. An expired token just needs a fresh one.
      let fresh;
      if (isKeyRejection(error)) { try { fresh = await fetchToken(this.live, this.host, { direct: true, stage }); } catch {} }
      fresh ||= await fetchToken(this.live, this.host, { stage });
      if (this.closed) return;
      assertRoomAccess(fresh, this.live.room, token.serverUrl);
      await room.connect(fresh.serverUrl, fresh.token, { autoSubscribe: true });
    }
    if (this.closed) { room.disconnect(); return; }
    this.entered = true;
    this.emit('state', 'connected');
    this.#countViewers();
    if (!this.host && ![...room.remoteParticipants.values()].some(p => p.identity === this.live.host.id)) {
      this.hostTimer = setTimeout(() => this.#ended(), HOST_GRACE_MS);
    }
    // Tracks that were already published before this client connected (the host for viewers, seated guests).
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) this.#subscribe(publication, participant);
    }
    this.resumeAudio();
    if (this.host) await this.#publish();
    else {
      // Zero auto-publishing: the viewer's microphone and camera are off on entry, always.
      await this.#enforceAudience();
      await this.#syncStage(); // an approved guest reconnecting goes straight back on stage
    }
    this.#schedulePoll();
    this.flushLikes = setInterval(() => this.#sendLikes(), 500);
  }

  /** Joins again after the media connection dropped for good (same session, panels and chat stay as they are). */
  async reconnect() {
    const old = this.room;
    this.room = null;
    clearTimeout(this.poll); clearInterval(this.flushLikes); clearTimeout(this.hostTimer);
    try { old?.removeAllListeners?.(); await old?.disconnect(); } catch {}
    // The old connection's <audio> elements are dead now; the new one attaches fresh ones on TrackSubscribed.
    this.audioElements?.forEach(element => element.remove()); this.audioElements?.clear();
    if (this.closed) return;
    this.onStage = false;
    if (this.voiceCapture) this.voiceCapture.published = false;
    if (this.voiceCapture) this.voiceCapture.track.enabled = false;
    this.voiceEnabled = false;
    this.rightsWaitSince = 0;
    tokenCache.delete(this.live.room);
    return this.join();
  }

  async leave() {
    this.closed = true;
    clearTimeout(this.poll); clearInterval(this.flushLikes); clearTimeout(this.hostTimer); clearTimeout(this.nudgeTimer); clearTimeout(this.rightsTimer);
    this.#sendLikes();
    // Leaving while seated or waiting frees the seat / request right away (the next visit would clear it anyway).
    if (!this.host && ['pending', 'speaker'].includes(this.self?.state)) {
      api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: this.self.state === 'speaker' ? 'leave-stage' : 'cancel-request' } }).catch(() => {});
      this.#signal(this.self.state === 'speaker' ? 'stage-left' : 'stage-cancel', { to: this.live.host.id });
    }
    this.#removeAudioUnlock();
    this.audioElements?.forEach(element => element.remove()); this.audioElements?.clear();
    await this.#releaseVoiceCapture();
    try { await this.room?.disconnect(); } catch {}
    try { if (this.channel) (await supabase()).removeChannel(this.channel); } catch {}
    this.room = null; this.channel = null;
  }

  setAudioMuted(muted) {
    this.audioMuted = !!muted;
    this.audioElements?.forEach(element => { element.muted = this.audioMuted; });
    if (!this.audioMuted) return this.resumeAudio();
    return Promise.resolve();
  }

  setAudioOnly(audioOnly) {
    const wasAudioOnly = this.audioOnly;
    this.audioOnly = !!audioOnly;
    if (wasAudioOnly && !this.audioOnly) {
      for (const participant of this.room?.remoteParticipants.values() || []) {
        for (const publication of participant.trackPublications.values()) this.#subscribe(publication, participant);
      }
    }
  }

  /** Unlocks audio after a user gesture (mobile autoplay policies): LiveKit playback plus every remote <audio>. */
  resumeAudio() {
    const room = this.room;
    if (!room) return Promise.resolve();
    const plays = [...(this.audioElements || [])].filter(el => el.isConnected && el.paused).map(el => el.play().catch(() => {}));
    return Promise.all([room.startAudio?.(), ...plays])
      .then(() => this.emit('audio-blocked', !room.canPlaybackAudio))
      .catch(() => this.emit('audio-blocked', true));
  }

  // ---- Sending ---------------------------------------------------------------------------------------------
  /** Sends a comment. The server applies the host's rules first; only accepted comments reach other viewers. */
  async comment(text) {
    const body = text.trim().slice(0, 300);
    if (!body) return;
    const event = { t: 'chat', id: crypto.randomUUID(), uid: auth.userId, name: auth.name, body, at: Date.now() };
    try {
      const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'message', id: event.id, message: body } });
      if (result?.filtered) return; // hidden from everyone else, like a filtered TikTok comment
      const saved = result?.message;
      const accepted = saved ? { ...event, uid: saved.userId, name: saved.name, body: saved.body, at: Date.parse(saved.createdAt) } : event;
      this.#deliver(accepted);
      this.#broadcast(accepted, true);
    } catch (error) {
      this.emit('comment-rejected', { id: event.id, error });
    }
  }

  like() {
    if (this.settings.likesEnabled === false || this.endedOnce) return;
    this.likeBatch += 1;
    this.emit('like', { n: 1, mine: true });
  }

  async gift(key) {
    const result = await sendGift({ gift: key, room: this.live.room });
    const event = { t: 'gift', id: result?.id, uid: auth.userId, name: auth.name, gift: key, at: Date.now() };
    if (!event.id) throw new Error(t('giftFailed'));
    this.#deliver(event);
    this.#broadcast(event, true);
    return result;
  }

  // ---- Stream controls (host, and guests on stage) ---------------------------------------------------------
  // Only the host or an approved guest whose LiveKit rights arrived can touch their camera / mic.
  #mayPublish() { return this.host || (this.onStage && this.seated); }

  async flipCamera() {
    if (!this.#mayPublish() || this.mode !== 'video') return;
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    const track = this.room?.localParticipant.getTrackPublication(this.sdk.Track.Source.Camera)?.track;
    if (track) await track.restartTrack({ facingMode: this.facing });
    this.emit('facing', this.facing);
  }
  async toggleMic() {
    const lp = this.room?.localParticipant;
    if (!lp || !this.#mayPublish()) return false;
    const next = !this.voiceEnabled;
    if (next && !this.host && this.self?.hostMuted) throw new Error(t('guestMutedByHost'));
    if (next) await this.#enableMicrophone();
    else {
      if (this.voiceCapture) this.voiceCapture.track.enabled = false;
      this.voiceEnabled = false;
    }
    this.#emitMedia();
    return next;
  }
  async setVoicePreset(id) {
    if (!VOICE_PRESETS.some(preset => preset.id === id)) throw new Error(t('voicePresetUnavailable'));
    if (id !== 'normal' && this.voiceCapture && !this.voiceCapture.effects) throw new Error(t('voiceEffectsUnsupported'));
    this.voiceCapture?.effects?.setPreset(id);
    this.voicePreset = id;
    this.emit('voice-preset', id);
    return id;
  }
  async toggleCamera() {
    const lp = this.room?.localParticipant;
    if (!lp || this.mode !== 'video' || !this.#mayPublish()) return false;
    const next = !lp.isCameraEnabled;
    await lp.setCameraEnabled(next, { facingMode: this.facing || 'user' });
    this.#emitMedia();
    return next;
  }
  get micOn() { return this.voiceEnabled; }
  get cameraOn() { return !!this.room?.localParticipant?.isCameraEnabled; }
  /** Current own media state for the control buttons. */
  get media() {
    return { mic: this.micOn, camera: this.cameraOn, hostMuted: !this.host && !!this.self?.hostMuted, onStage: this.host || this.onStage };
  }
  #emitMedia() { this.emit('media', this.media); }

  /** Everyone connected to the LiveKit room right now (identity + name), excluding the host. */
  audience() {
    if (!this.room) return [];
    return [...this.room.remoteParticipants.values()]
      .filter(participant => participant.identity !== this.live.host.id)
      .map(participant => ({ userId: participant.identity, name: participant.name || '' }));
  }

  /** Host moderation / guest action through the server, then everyone concerned refreshes. */
  async control(action, extra = {}, { quiet = false } = {}) {
    const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action, ...extra } });
    if (result?.settings && this.status) this.status = { ...this.status, settings: result.settings };
    const target = typeof extra.target === 'string' ? extra.target : '';
    if (this.host && target) {
      this.#signal(HOST_SIGNALS[action] || 'room', { to: target });
      this.#nudge('', target); // everyone else refreshes the stage grid
    } else this.#nudge(this.host ? '' : 'host');
    if (!quiet) await this.refresh();
    return result;
  }

  // ---- Guest actions (viewers) ----------------------------------------------------------------------------
  /** Request to join: stored by the server, then signalled straight to the host's screen. */
  async requestStage() {
    if (!this.#beginStageAction('request')) return;
    this.#setStage('requested'); // instant feedback; corrected by the server answer below
    try {
      const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'request' } });
      this.#signal('stage-request', { to: this.live.host.id, name: auth.name });
      await this.refresh();
      return result?.state;
    } catch (error) {
      this.#setStage(this.#deriveStage());
      throw error;
    } finally {
      this.#endStageAction();
    }
  }
  /** Tap on "Requested": withdraws the request. */
  async cancelRequest() {
    if (!this.#beginStageAction('cancel')) return;
    this.#setStage('audience');
    try {
      await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'cancel-request' } });
      this.#signal('stage-cancel', { to: this.live.host.id });
    } catch (error) {
      this.#setStage(this.#deriveStage());
      throw error;
    } finally {
      try { await this.refresh(); }
      finally { this.#endStageAction(); }
    }
  }
  async acceptInvite() {
    if (!this.#beginStageAction('accept-invite')) return;
    this.#setStage('requested');
    try {
      const result = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'accept-invite' } });
      this.#signal('stage-request', { to: this.live.host.id, name: auth.name, invited: true });
      await this.refresh();
      return result?.state;
    } catch (error) { this.#setStage(this.#deriveStage()); throw error; }
    finally { this.#endStageAction(); }
  }
  async declineInvite() {
    await this.control('decline-invite');
    this.#broadcast({ t: 'decline', id: crypto.randomUUID(), uid: auth.userId }, true);
  }
  /** Guest steps down: camera and mic stop immediately, then the server revokes the rights. */
  async leaveStage() {
    await this.#stopPublishing();
    await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'leave-stage' } });
    this.#signal('stage-left', { to: this.live.host.id });
    await this.refresh();
  }

  async end() {
    await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'end' } });
    const event = { t: 'end', id: crypto.randomUUID(), at: Date.now() };
    this.#broadcast(event, true);
    await this.leave();
  }

  /** Re-reads the room (settings, stage, chat history). Public so the UI can refresh after an action. */
  refresh() { return this.#loadHistory(); }

  // ---- Internals -------------------------------------------------------------------------------------------
  async #publish() {
    const lp = this.room.localParticipant;
    await this.#enableMicrophone();
    if (this.mode === 'video') await lp.setCameraEnabled(true, { facingMode: 'user' });
    this.facing = 'user';
    if (this.published) { this.refresh(); return; } // reconnecting: the host's current settings stay as they are
    this.published = true;
    // Starting settings chosen in the Go LIVE sheet (guests, comments); everything else keeps its defaults.
    const initial = { layout: 9, admission: 'approval', order: [], ...(this.live.initialSettings || {}) };
    api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'settings', ...initial } })
      .then(result => { if (result?.settings) this.status = { ...(this.status || {}), settings: result.settings }; this.refresh(); })
      .catch(() => {});
    api('/api/milkyway-notifications?action=live-started', { method: 'POST', body: { room: this.live.room } }).catch(() => {});
  }

  // Viewer entry: microphone and camera off, nothing published.
  async #enforceAudience() {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    await this.#releaseVoiceCapture();
    await lp.setCameraEnabled(false).catch(() => {});
    for (const publication of lp.trackPublications?.values?.() || []) {
      if (publication.track) await lp.unpublishTrack(publication.track).catch(() => {});
    }
    this.#emitMedia();
  }

  async #stopPublishing() {
    const wasOnStage = this.onStage;
    this.onStage = false;
    await this.#enforceAudience();
    if (wasOnStage) this.emit('stage', { onStage: false });
  }

  // Matches the guest's camera / mic to the server record (seated or not) and the LiveKit rights it holds.
  async #syncStage() {
    if (this.host || !this.room || this.closed || this.room.state !== 'connected') return;
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      const self = this.self;
      const lp = this.room.localParticipant;
      if (!this.seated) {
        clearTimeout(this.rightsTimer); this.rightsWaitSince = 0;
        if (this.onStage || this.voiceEnabled || lp.isCameraEnabled) await this.#stopPublishing();
        return;
      }
      // An audio LIVE guest muted by the host holds no publish right at all; that is expected, not "waiting".
      const expectRights = !(this.mode === 'audio' && self.hostMuted);
      if (expectRights && !this.canPublish) { this.#awaitRights(); return; }
      clearTimeout(this.rightsTimer); this.rightsWaitSince = 0; this.stageRejoined = false;
      if (!this.onStage) {
        // Promoted: the host approved and LiveKit granted the rights. Camera and mic go live now.
        this.onStage = true;
        try {
          if (this.mode === 'video') await lp.setCameraEnabled(true, { facingMode: this.facing || 'user' });
          if (!self.hostMuted) await this.#enableMicrophone();
        } catch (error) {
          if (error?.name === 'NotAllowedError') this.emit('error', Object.assign(new Error(t('cameraNeeded')), { status: 0 }));
          // A camera refusal must not prevent an approved guest from joining with voice.
          if (this.mode === 'video' && !self.hostMuted && !this.voiceEnabled) {
            try { await this.#enableMicrophone(); } catch (micError) { this.emit('error', micError); }
          }
        }
        this.resumeAudio();
        this.emit('stage', { onStage: true });
      }
      if (self.hostMuted && this.voiceEnabled) await this.#releaseVoiceCapture();
      this.#emitMedia();
    } finally {
      this.syncing = false;
      this.#setStage(this.#deriveStage());
      if (this.syncAgain) { this.syncAgain = false; setTimeout(() => this.#syncStage(), 0); }
    }
  }

  async #enableMicrophone() {
    const lp = this.room?.localParticipant;
    if (!lp) throw new Error(t('liveUnavailable'));
    let capture = this.voiceCapture;
    if (capture?.input.getAudioTracks().some(track => track.readyState === 'ended')) {
      await this.#releaseVoiceCapture();
      capture = null;
    }
    if (!capture) {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: this.noiseSuppression, autoGainControl: true } });
      let effects = null;
      try { effects = createVoiceEffects(input, this.voicePreset); }
      catch {
        if (this.voicePreset !== 'normal') {
          input.getTracks().forEach(track => track.stop());
          throw new Error(t('voiceEffectsUnsupported'));
        }
      }
      const track = effects?.stream.getAudioTracks()[0] || input.getAudioTracks()[0];
      if (!track) {
        effects?.close();
        input.getTracks().forEach(item => item.stop());
        throw new Error(t('recordingFailed'));
      }
      capture = this.voiceCapture = { input, effects, track, published: false };
    }
    capture.track.enabled = true;
    try {
      if (!capture.published) {
        if (typeof lp.publishTrack !== 'function') throw new Error(t('voiceEffectsUnsupported'));
        await lp.publishTrack(capture.track, { source: this.sdk.Track.Source.Microphone });
        capture.published = true;
      }
      capture.track.enabled = true;
      this.voiceEnabled = true;
    } catch (error) {
      if (!capture.published) await this.#releaseVoiceCapture();
      throw error;
    }
  }

  async #releaseVoiceCapture() {
    const capture = this.voiceCapture;
    this.voiceCapture = null;
    this.voiceEnabled = false;
    if (!capture) return;
    const lp = this.room?.localParticipant;
    if (capture.published && lp) {
      try { await lp.unpublishTrack(capture.track); } catch (error) { console.warn('[live] microphone unpublish failed', error); }
    }
    capture.track.enabled = false;
    capture.effects?.close();
    capture.track.stop();
    capture.input.getTracks().forEach(track => track.stop());
  }

  // Approved but this connection has no publish rights yet. The server grants them on the live connection before it
  // records the approval, so they are normally here already. If not, the guest does not wait: after a short grace for
  // LiveKit's push it asks for a FRESH publisher token (canPublish:true, canSubscribe:true, signed only because the
  // host's approval is on record) and reconnects with it. A second failure falls back to asking for a resync.
  #awaitRights() {
    const now = Date.now();
    if (!this.rightsWaitSince) this.rightsWaitSince = now;
    const waited = now - this.rightsWaitSince;
    clearTimeout(this.rightsTimer);
    if (waited > 450 && !this.stageRejoined) {
      this.stageRejoined = true;
      setTimeout(() => { if (!this.closed) this.reconnect().catch(error => this.emit('error', error)); }, 0);
      return;
    }
    if (waited > 2500 && now - (this.resyncAt || 0) > 3000) {
      this.resyncAt = now;
      api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'resync' } }).catch(() => {});
    }
    this.rightsTimer = setTimeout(() => this.#syncStage(), 1000);
  }

  #schedulePoll() {
    clearTimeout(this.poll);
    if (this.closed) return;
    const busy = this.host || ['pending', 'speaker'].includes(this.self?.state) || this.self?.invited;
    this.poll = setTimeout(async () => {
      if (document.visibilityState === 'visible') await this.#loadHistory();
      this.#schedulePoll();
    }, this.host ? HOST_POLL_MS : busy ? STAGE_POLL_MS : SAFETY_POLL_MS);
  }

  // Tells everyone in the room that the room state changed, so they refresh now instead of at the next poll.
  // A stage signal for one person: a LiveKit data packet addressed only to them (authenticated by LiveKit), with the
  // Realtime channel as fallback. Signals only make the receiver re-read the room; the server state is the authority.
  #signal(kind, { to, ...extra }) {
    if (!to) return;
    const event = { t: 'sig', id: crypto.randomUUID(), uid: auth.userId, kind, to, ...extra };
    try { this.room?.localParticipant.publishData(encoder.encode(JSON.stringify(event)), { reliable: true, topic: TOPIC, destinationIdentities: [to] }).catch(() => {}); } catch {}
  }

  #onSignal(event) {
    if (event.to !== auth.userId) return;
    if (this.host) {
      // A viewer asked to join, cancelled or left the stage: show it on the host's screen right now.
      if (['stage-request', 'stage-cancel', 'stage-left'].includes(event.kind)) {
        this.#refreshSoon();
      }
      return;
    }
    if (event.uid !== this.live.host.id) return;
    this.#refreshSoon();
  }

  #nudge(to = '', target = '') { this.#broadcast({ t: 'room', id: crypto.randomUUID(), uid: auth.userId, to, ...(target ? { target } : {}) }, true); }

  #refreshSoon() {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.#loadHistory(), 120);
  }

  #onNudge() {
    clearTimeout(this.nudgeTimer);
    // Spread viewer refreshes so a host action does not hit the API with every viewer at the same instant.
    this.nudgeTimer = setTimeout(() => this.#loadHistory(), this.host ? 150 : 250 + Math.random() * 1250);
  }

  // The host's app approves guests who accepted an invitation (publish rights can only be granted by the host).
  #autoApprove(status) {
    if (!this.host) return;
    for (const member of roomMembers(status)) {
      if (member.state !== 'pending' || !member.invited || this.approving.has(member.userId)) continue;
      this.approving.add(member.userId);
      this.control('approve', { target: member.userId }, { quiet: true })
        .catch(error => this.emit('error', error))
        .finally(() => { this.approving.delete(member.userId); this.#onNudge(); });
    }
  }

  #removed() {
    if (this.removedOnce) return;
    this.removedOnce = true;
    this.emit('removed');
  }

  // Remote microphone / camera tracks are always received: viewers get the host, the host gets every approved guest
  // (only they hold publish rights, so nobody else has a track to receive).
  #subscribe(publication, participant) {
    if (!participant || participant.isLocal || participant.identity === auth.userId) return;
    if (this.audioOnly && publication.kind !== 'audio') return;
    if (!publication.isSubscribed && typeof publication.setSubscribed === 'function') publication.setSubscribed(true);
  }

  #attach(track, participant, Track, local = false) {
    if (track.kind === Track.Kind.Audio) {
      // Never play our own microphone back (echo). Every remote voice — host or guest — gets its own <audio> element.
      if (local || participant?.isLocal || participant?.identity === auth.userId) return;
      const el = track.attach();
      el.autoplay = true;
      el.playsInline = true;
      el.muted = this.audioMuted;
      el.dataset.uid = participant?.identity || '';
      (this.audioElements ||= new Set()).add(el);
      this.emit('audio', el); // the UI puts it in the page
      if (!el.isConnected) document.body.append(el); // no UI bound: keep it playing anyway
      el.play?.().catch(() => this.emit('audio-blocked', true));
      track.once?.('ended', () => {
        this.audioElements?.delete(el);
        el.pause();
        el.srcObject = null;
        el.remove();
      });
      return;
    }
    const element = track.attach();
    element.playsInline = true;
    element.muted = true;
    element.controls = false;
    element.poster = TRANSPARENT_VIDEO_POSTER;
    element.className = 'live-track';
    if (local) element.classList.add('local');
    if (local && this.facing !== 'environment') element.classList.add('mirror');
    this.emit('video', { element, participant: participant.identity, name: participant.name || '', local, isHost: participant.identity === this.live.host.id });
  }

  // Mobile autoplay: the first tap anywhere on the page after audio was blocked turns playback on.
  #installAudioUnlock() {
    if (this.unlockAudio) return;
    this.unlockAudio = () => { if (!this.closed && !this.audioMuted) this.resumeAudio(); };
    for (const type of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(type, this.unlockAudio, { capture: true, passive: true });
  }
  #removeAudioUnlock() {
    if (!this.unlockAudio) return;
    for (const type of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(type, this.unlockAudio, { capture: true });
    this.unlockAudio = null;
  }

  #countViewers() {
    if (!this.room) return;
    const n = Math.max(1, (this.room.numParticipants || this.room.remoteParticipants.size + 1) - 1);
    if (n !== this.viewers) { this.viewers = n; this.emit('viewers', n); }
  }

  async #openRealtime() {
    try {
      const sb = await supabase();
      if (this.closed) return;
      const channel = sb.channel(`mw-live:${this.live.room}`, { config: { broadcast: { self: false }, presence: { key: auth.userId || crypto.randomUUID() } } });
      channel
        .on('presence', { event: 'sync' }, () => {
          if (this.room?.state === 'connected') return;
          const n = Object.keys(channel.presenceState()).length;
          if (n && n !== this.viewers) { this.viewers = n; this.emit('viewers', n); }
        })
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'mw_live_room_members',
          filter: `room_name=eq.${this.live.room}`,
        }, () => this.#refreshSoon())
        .subscribe(status => {
          if (status === 'SUBSCRIBED') {
            channel.track({ at: Date.now() }).catch(() => {});
            this.#refreshSoon();
          }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[live] member realtime unavailable; status polling remains active', status);
          }
        });
      this.channel = channel;
    } catch { /* LiveKit data still works */ }
  }

  #broadcast(event, reliable) {
    try { this.room?.localParticipant.publishData(encoder.encode(JSON.stringify(event)), { reliable, topic: TOPIC }).catch(() => {}); } catch {}
  }

  #sendLikes() {
    if (!this.likeBatch || this.sendingLikes || this.closed || this.endedOnce) return;
    const n = Math.min(this.likeBatch, 50);
    this.likeBatch = 0;
    this.sendingLikes = true;
    const id = crypto.randomUUID();
    api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'like', id, count: n } })
      .then(result => {
        const like = result?.like;
          if (!like?.id || this.closed || this.endedOnce) return;
        const event = { t: 'like', id: like.id, uid: like.userId, n: like.count };
        this.#deliver(event);
        this.#broadcast(event, false);
      })
      .catch(error => this.emit('like-rejected', error))
      .finally(() => { this.sendingLikes = false; });
  }

  #receive(payload, participant) {
    if (!payload || payload.byteLength > 4096 || !participant?.identity) return;
    let message;
    try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    message.uid = participant.identity;
    this.#handle(message);
  }

  #allowReceived(sender, limit) {
    const now = Date.now();
    this.receiveRates ||= new Map();
    let bucket = this.receiveRates.get(sender);
    if (!bucket || now - bucket.at >= 1000) {
      bucket = { at: now, count: 0 };
      this.receiveRates.set(sender, bucket);
    }
    if (++bucket.count > limit) return false;
    if (this.receiveRates.size > 500) this.receiveRates.delete(this.receiveRates.keys().next().value);
    return true;
  }

  async #handle(event) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!event || typeof event.t !== 'string' || !uuid.test(event.id || '') || !uuid.test(event.uid || '') || this.seen.has(event.id)) return;
    if (event.t === 'chat' || event.t === 'gift' || event.t === 'like') {
      if (event.t === 'chat' && (typeof event.body !== 'string' || event.body.length > 300)) return;
      if (event.t === 'gift' && (typeof event.gift !== 'string' || event.gift.length > 80)) return;
      if (event.t === 'like' && (!Number.isInteger(event.n) || event.n < 1 || event.n > 50)) return;
      if (!this.#allowReceived(event.uid, 20)) return;
      this.verifyingEvents ||= new Set();
      if (this.verifyingEvents.has(event.id)) return;
      this.verifyingEvents.add(event.id);
      try {
        const result = await api(config.api.liveRoom, {
          method: 'POST',
          body: { room: this.live.room, action: event.t === 'chat' ? 'message-status' : event.t === 'gift' ? 'gift-status' : 'like-status', id: event.id, sender: event.uid },
          timeout: 8000,
        });
        if (event.t === 'chat' && result?.message) {
          const message = result.message;
          this.#deliver({ t: 'chat', id: message.id, uid: message.userId, name: message.name, body: message.body, at: Date.parse(message.createdAt) });
        } else if (event.t === 'gift' && result?.gift) {
          const gift = result.gift;
          this.#deliver({ t: 'gift', id: gift.id, uid: gift.sender, gift: gift.gift, at: Date.parse(gift.createdAt) });
        } else if (event.t === 'like' && result?.like) {
          const like = result.like;
          this.#deliver({ t: 'like', id: like.id, uid: like.userId, n: like.count });
        }
      } catch { /* polling loads the authoritative history */ }
      finally { this.verifyingEvents.delete(event.id); }
      return;
    }
    if (!this.#allowReceived(event.uid, 5)) return;
    if (event.t === 'end') {
      if (event.uid !== this.live.host.id) return;
      try {
        const status = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'status' }, timeout: 8000 });
        if (status?.isLive === false) this.#ended();
      } catch { /* the regular status poll will confirm shutdown */ }
      return;
    }
    if (event.t === 'decline') {
      if (!this.host || event.uid === this.live.host.id) return;
      try {
        const status = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'status' }, timeout: 8000 });
        if (!roomMembers(status).some(member => member.userId === event.uid && member.invited)) return;
        await this.control('cancel-invite', { target: event.uid }, { quiet: true });
        this.emit('declined', event.uid);
      } catch { /* the status poll will reflect the persisted invitation */ }
      return;
    }
    if (event.t === 'sig') {
      const allowed = ['stage-request', 'stage-cancel', 'stage-left', 'stage-approve', 'stage-reject', 'stage-remove', 'stage-mute', 'stage-unmute', 'stage-invite'];
      if (!allowed.includes(event.kind) || typeof event.to !== 'string') return;
      this.#deliver(event);
      return;
    }
    if (event.t === 'room') {
      if (event.uid === this.live.host.id) this.#deliver(event);
    }
  }

  // Comments from people the host muted or removed (or while comments are off) never render, even if a modified
  // client broadcasts them directly.
  #hidden(event) {
    if (event.uid === auth.userId || event.uid === this.live.host.id) return false;
    const settings = this.settings;
    return settings.comments === 'off' || settings.mutedIds?.includes(event.uid) || settings.blockedIds?.includes(event.uid);
  }

  #deliver(event) {
    this.seen.add(event.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    if (event.t === 'chat') { if (!this.#hidden(event)) this.emit('comment', event); }
    else if (event.t === 'gift') this.emit('gift', event);
    else if (event.t === 'like') { if (this.settings.likesEnabled !== false) this.emit('like', { n: Math.min(event.n || 1, 50) }); }
    else if (event.t === 'end') this.#ended();
    else if (event.t === 'room') {
      if (!this.host && event.target && event.target === auth.userId && event.uid === this.live.host.id) this.#refreshSoon();
      else if (!event.to || (event.to === 'host' && this.host)) this.#onNudge();
    }
    else if (event.t === 'sig') this.#onSignal(event);
  }

  async #loadHistory({ enter = false } = {}) {
    if (!auth.signedIn() || this.closed) return;
    if (this.loadingHistory) { this.loadAgain = true; return; } // one more read right after the current one
    this.loadingHistory = true;
    this.loadAgain = false;
    try {
      const status = await api(config.api.liveRoom, { method: 'POST', body: { room: this.live.room, action: 'status', ...(enter ? { enter: true } : {}) }, timeout: 10000 });
      if (this.closed || !status) return;
      if (status.isLive === false) { this.#ended(); return; }
      const before = this.status;
      this.status = status;
      if (this.host) {
        const previouslyPending = new Set(roomMembers(before).filter(member => member.state === 'pending').map(member => member.userId));
        for (const member of roomMembers(status)) {
          if (member.state === 'pending' && !previouslyPending.has(member.userId)) {
            this.emit('stage-request', { userId: member.userId, name: member.name || '' });
          }
        }
      }
      for (const message of status.messages || []) {
        if (message.deleted) { if (this.seen.has(message.id)) this.emit('comment-deleted', message.id); continue; }
        if (message.kind !== 'chat' || this.seen.has(message.id)) continue;
        this.#deliver({ t: 'chat', id: message.id, uid: message.userId, name: message.name, body: message.body, at: Date.parse(message.createdAt), history: true });
      }
      if (!this.host && status.self?.invited && !before?.self?.invited && status.self?.state === 'viewer') this.emit('invited');
      if (!this.host) this.#setStage(this.#deriveStage());
      this.emit('room', status);
      this.#autoApprove(status);
      await this.#syncStage();
      if (!this.host) this.#schedulePoll();
    } catch (error) {
      if (error.status === 404) this.#ended();
      else if (error.status === 403 && !this.host) this.#removed();
    } finally {
      this.loadingHistory = false;
      if (this.loadAgain && !this.closed) { this.loadAgain = false; setTimeout(() => this.#loadHistory(), 0); }
    }
  }

  #ended() {
    if (this.endedOnce) return;
    this.endedOnce = true;
    tokenCache.delete(this.live.room);
    endedRooms.add(this.live.room);
    if (endedRooms.size > 1000) endedRooms.delete(endedRooms.values().next().value);
    clearTimeout(this.poll); clearInterval(this.flushLikes); clearTimeout(this.hostTimer); clearTimeout(this.nudgeTimer); clearTimeout(this.rightsTimer);
    this.emit('ended');
  }
}
