// Hold-to-talk audio messages for existing DM and group conversations.
import { inbox } from '../data/chats.js';
import { sendDirectMedia } from '../data/messages.js';
import { auth } from '../core/net.js';
import { bus } from '../core/events.js';
import { profiles } from '../data/profiles.js';
import {
  downloadGroupWalkie, isActiveGroupMember, loadGroups, loadLatestGroupWalkie, onGroupMessage, sendGroupWalkie,
} from '../data/groups.js';
import { t } from '../core/i18n.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

const micIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11z"/></svg>';
const MAX_RECORDING_MS = 180_000;

function audioMimeType() {
  const formats = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return formats.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}

function audioFile(blob) {
  const extension = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const name = `walkie-talkie-${Date.now()}.${extension}`;
  if (typeof File === 'function') return new File([blob], name, { type: blob.type || 'audio/webm', lastModified: Date.now() });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

export class WalkieTalkieView {
  constructor() {
    this.captureGeneration = 0;
    this.openGeneration = 0;
    this.recordingStarting = false;
    this.recording = null;
    this.releaseRequested = false;
    this.sending = false;
    this.lastHoldEvent = 0;
    this.groupGeneration = 0;
    this.playbackGeneration = 0;
    this.playbackUrl = '';
    this.latestWalkie = null;
    this.loadingWalkieId = '';
    this.loadedWalkieId = '';
    this.autoplayWalkieId = '';
    this.groupUnsubscribe = null;

    this.sheet = new Sheet({
      title: t('walkieTalkie'),
      className: 'walkie-sheet',
      onClose: () => {
        this.openGeneration++;
        this.cancelRecording();
        this.#stopGroupListening();
      },
    });
    this.target = h('select', {
      class: 'field walkie-target',
      'aria-label': t('chooseConversation'),
      onchange: () => this.#selectionChanged(),
    }, h('option', { value: '' }, t('chooseConversation')));
    this.hint = h('p', { class: 'walkie-hint' }, t('walkieHint'));
    this.speaker = h('p', { class: 'walkie-speaker', role: 'status', 'aria-live': 'polite', hidden: true });
    this.player = h('audio', { class: 'walkie-player', controls: true, preload: 'none', hidden: true });
    this.status = h('p', { class: 'walkie-status', role: 'status', 'aria-live': 'polite' });
    this.time = h('span', { class: 'walkie-time', 'aria-hidden': 'true' });
    this.button = h('button', {
      class: 'walkie-talk-button', type: 'button', 'aria-pressed': 'false', 'aria-label': t('holdToTalk'),
      html: micIcon,
    }, h('span', {}, t('holdToTalk')));
    this.button.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      this.lastHoldEvent = Date.now();
      this.pointerId = event.pointerId;
      this.button.setPointerCapture?.(event.pointerId);
      this.#startHold();
    });
    this.button.addEventListener('pointerup', event => {
      if (event.pointerId !== this.pointerId) return;
      event.preventDefault();
      this.pointerId = null;
      this.lastHoldEvent = Date.now();
      this.#endHold();
    });
    this.button.addEventListener('pointercancel', event => {
      if (event.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.cancelRecording();
    });
    this.button.addEventListener('keydown', event => {
      if (![' ', 'Enter'].includes(event.key) || event.repeat) return;
      event.preventDefault();
      this.lastHoldEvent = Date.now();
      this.#startHold();
    });
    this.button.addEventListener('keyup', event => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      this.lastHoldEvent = Date.now();
      this.#endHold();
    });
    this.button.addEventListener('click', () => {
      if (Date.now() - this.lastHoldEvent < 500) return;
      if (this.recording || this.recordingStarting) this.#endHold();
      else this.#startHold();
    });
    this.sheet.body.append(
      this.target,
      this.hint,
      this.speaker,
      this.player,
      this.button,
      this.time,
      this.status);
    addEventListener('blur', () => this.cancelRecording());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.cancelRecording();
        this.player.pause();
      }
    });
    bus.on('auth', () => {
      this.cancelRecording();
      this.#stopGroupListening();
      this.target.value = '';
      this.#updateControls();
    });
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
      this.button.disabled = true;
      this.status.textContent = t('recordingFailed');
    }
  }

  attachToDm(person, host) {
    if (!person?.id || !host) return;
    if (this.sheet.isOpen) this.sheet.close();
    this.cancelRecording();
    this.#stopGroupListening();
    this.inlineHost = host;
    this.target.replaceChildren(h('option', { value: `dm:${person.id}` }, person.name || 'MilkyWay'));
    this.target.value = `dm:${person.id}`;
    this.target.hidden = true;
    this.hint.hidden = true;
    this.speaker.hidden = true;
    this.player.hidden = true;
    host.replaceChildren(this.button, this.time, this.status);
    this.button.classList.add('walkie-talk-button-inline');
    this.status.classList.add('walkie-inline-status');
    this.#updateControls();
  }

  detachFromDm() {
    if (!this.inlineHost) return;
    this.cancelRecording();
    this.inlineHost.replaceChildren();
    this.inlineHost = null;
    this.button.classList.remove('walkie-talk-button-inline');
    this.status.classList.remove('walkie-inline-status');
    this.target.hidden = false;
    this.hint.hidden = false;
    this.sheet.body.append(this.target, this.hint, this.speaker, this.player, this.button, this.time, this.status);
    this.target.replaceChildren(h('option', { value: '' }, t('chooseConversation')));
    this.target.value = '';
    this.#updateControls();
  }

  async open() {
    this.cancelRecording();
    this.#stopGroupListening();
    this.sheet.open();
    this.status.textContent = t('loading');
    const generation = ++this.openGeneration;
    try {
      await inbox.load();
      const [rooms, groups] = await Promise.all([
        inbox.refresh(),
        loadGroups().catch(error => {
          toast(error?.message || t('groupActionFailed'));
          return [];
        }),
      ]);
      if (generation !== this.openGeneration || !this.sheet.isOpen) return;
      this.#renderTargets(rooms || inbox.value || [], groups);
    } catch (error) {
      if (generation !== this.openGeneration) return;
      toast(error?.message || t('retry'));
      this.#renderTargets(inbox.value || [], []);
    }
  }

  cancelRecording() {
    this.captureGeneration++;
    this.recordingStarting = false;
    this.releaseRequested = false;
    this.pointerId = null;
    const capture = this.recording;
    if (capture) {
      capture.cancelled = true;
      if (capture.recorder.state !== 'inactive') capture.recorder.stop();
    }
    this.status.textContent = '';
    this.#resetControls();
  }

  #renderTargets(rooms, groups) {
    const previous = this.target.value;
    const dmOptions = rooms.map(room => h('option', { value: `dm:${room.peer}` }, `${t('chats')}: ${room.name || 'MilkyWay'}`));
    const activeGroups = groups.filter(group => isActiveGroupMember(group));
    const options = [h('option', { value: '' }, t('chooseConversation'))];
    if (dmOptions.length) options.push(h('optgroup', { label: t('chats') }, ...dmOptions));
    if (activeGroups.length) options.push(h('optgroup', { label: t('groups') },
      ...activeGroups.map(group => h('option', { value: `group:${group.id}` }, group.name || t('groupChat')))));
    this.target.replaceChildren(...options);
    this.target.value = options.length > 1 && [...this.target.options].some(option => option.value === previous) ? previous : '';
    this.status.textContent = options.length > 1 ? '' : t('noWalkieTargets');
    this.#selectionChanged();
  }

  #selectionChanged() {
    const [type, id] = this.target.value.split(':', 2);
    if (type !== 'group' || !id) {
      if (this.groupId) this.#stopGroupListening();
      this.#updateControls();
      return;
    }
    if (this.groupId !== id) {
      this.#stopGroupListening();
      this.groupId = id;
      const generation = ++this.groupGeneration;
      const groupName = this.target.selectedOptions[0]?.textContent || t('groups');
      this.speaker.hidden = false;
      this.speaker.textContent = `${t('walkieListening')}: ${groupName}`;
      this.groupUnsubscribe = onGroupMessage(event => {
        if (event.type !== 'INSERT' || event.message?.group_id !== id) return;
        this.#presentWalkie(event.message, generation, true);
      }, id);
      loadLatestGroupWalkie(id).then(message => {
        if (generation !== this.groupGeneration || this.groupId !== id || !message) return;
        this.#presentWalkie(message, generation, false);
      }).catch(error => {
        if (generation !== this.groupGeneration || this.groupId !== id) return;
        this.speaker.textContent = error?.message || t('walkiePlaybackFailed');
      });
    }
    this.#updateControls();
  }

  #stopGroupListening() {
    this.groupGeneration++;
    this.groupUnsubscribe?.();
    this.groupUnsubscribe = null;
    this.groupId = '';
    this.latestWalkie = null;
    this.#clearPlayback();
    this.speaker.textContent = '';
    this.speaker.hidden = true;
  }

  #clearPlayback(invalidate = true) {
    if (invalidate) this.playbackGeneration++;
    this.player.pause();
    this.player.removeAttribute('src');
    this.player.load();
    this.player.hidden = true;
    if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl);
    this.playbackUrl = '';
    this.loadingWalkieId = '';
    this.loadedWalkieId = '';
    this.autoplayWalkieId = '';
  }

  async #presentWalkie(message, groupGeneration, autoplay) {
    if (!message?.id || message.media_metadata?.walkie !== true
      || message.media_metadata?.storage_path !== `${message.group_id}/${message.sender_id}/${message.id}`
      || message.group_id !== this.groupId || groupGeneration !== this.groupGeneration) return;
    if (this.latestWalkie?.id === message.id) {
      if (autoplay && message.sender_id !== auth.userId) this.autoplayWalkieId = message.id;
      if (this.loadingWalkieId === message.id || message.sender_id === auth.userId) return;
      if (this.loadedWalkieId === message.id) {
        if (autoplay && this.player.paused) {
          this.autoplayWalkieId = '';
          try { await this.player.play(); }
          catch (error) {
            if (error?.name !== 'NotAllowedError') console.warn('[walkie] received audio could not autoplay', error);
          }
        }
        return;
      }
      this.loadingWalkieId = message.id;
    } else {
      if (this.latestWalkie && Date.parse(message.created_at) < Date.parse(this.latestWalkie.created_at)) return;
      this.latestWalkie = message;
      const playbackGeneration = ++this.playbackGeneration;
      this.#clearPlayback(false);
      this.loadingWalkieId = message.sender_id === auth.userId ? '' : message.id;
      if (autoplay && message.sender_id !== auth.userId) this.autoplayWalkieId = message.id;
    }
    const playbackGeneration = this.playbackGeneration;
    const ownMessage = message.sender_id === auth.userId;
    try {
      const profile = ownMessage ? null : (await profiles.many([message.sender_id])).get(message.sender_id);
      if (groupGeneration !== this.groupGeneration || playbackGeneration !== this.playbackGeneration) return;
      const name = ownMessage ? t('you') : profile?.name || 'MilkyWay';
      this.speaker.textContent = `${t('walkieLatestFrom')}: ${name}`;
      if (ownMessage) return;
      const blob = await downloadGroupWalkie(this.groupId, message.sender_id, message.id);
      if (groupGeneration !== this.groupGeneration || playbackGeneration !== this.playbackGeneration) return;
      this.playbackUrl = URL.createObjectURL(blob);
      this.loadingWalkieId = '';
      this.loadedWalkieId = message.id;
      this.player.src = this.playbackUrl;
      this.player.hidden = false;
      if (autoplay || this.autoplayWalkieId === message.id) {
        this.autoplayWalkieId = '';
        try { await this.player.play(); }
        catch (error) {
          if (error?.name !== 'NotAllowedError') console.warn('[walkie] received audio could not autoplay', error);
        }
      }
    } catch (error) {
      if (groupGeneration !== this.groupGeneration || playbackGeneration !== this.playbackGeneration) return;
      this.loadingWalkieId = '';
      this.speaker.textContent = `${t('walkieLatestFrom')}: ${ownMessage ? t('you') : t('walkiePlaybackFailed')}`;
      console.warn('[walkie] received group audio could not be loaded', error);
    }
  }

  #updateControls() {
    const locked = this.recordingStarting || Boolean(this.recording) || this.sending;
    this.target.disabled = locked;
    this.button.disabled = !this.target.value || this.sending
      || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function';
  }

  #startHold() {
    if (this.recording || this.recordingStarting || this.sending) return;
    if (!this.target.value) {
      this.status.textContent = t('noWalkieTargets');
      this.target.focus();
      return;
    }
    const [type, id] = this.target.value.split(':', 2);
    if (!id || !['dm', 'group'].includes(type)) return;
    const generation = ++this.captureGeneration;
    this.recordingStarting = true;
    this.releaseRequested = false;
    this.captureTarget = { type, id };
    this.status.textContent = t('preparingRecording');
    this.button.querySelector('span').textContent = t('releaseToSend');
    this.button.classList.add('is-recording');
    this.button.setAttribute('aria-pressed', 'true');
    this.#updateControls();
    navigator.vibrate?.(30);
    this.#capture(generation, this.captureTarget);
  }

  #endHold() {
    if (this.recordingStarting) {
      this.releaseRequested = true;
      this.status.textContent = t('releaseToSend');
      return;
    }
    const capture = this.recording;
    if (capture && capture.recorder.state !== 'inactive') capture.recorder.stop();
  }

  async #capture(generation, target) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const mimeType = audioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const capture = { recorder, stream, chunks: [], target, cancelled: false, failed: false };
      this.recording = capture;
      this.recordingStarting = false;
      this.status.textContent = '';
      this.startedAt = Date.now();
      this.timer = setInterval(() => {
        const elapsed = Date.now() - this.startedAt;
        const seconds = Math.floor(elapsed / 1000);
        this.time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        if (elapsed >= MAX_RECORDING_MS && recorder.state !== 'inactive') recorder.stop();
      }, 250);
      recorder.addEventListener('dataavailable', event => {
        if (event.data?.size) capture.chunks.push(event.data);
      });
      recorder.addEventListener('error', () => {
        capture.failed = true;
        if (recorder.state !== 'inactive') recorder.stop();
        else this.#finishCapture(capture);
      }, { once: true });
      recorder.addEventListener('stop', () => this.#finishCapture(capture), { once: true });
      recorder.start(250);
      this.#updateControls();
      if (this.releaseRequested) {
        this.releaseRequested = false;
        recorder.stop();
      }
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (generation !== this.captureGeneration) return;
      this.recordingStarting = false;
      this.recording = null;
      this.status.textContent = '';
      this.#resetControls();
      toast(error?.message || t('recordingFailed'));
    }
  }

  #finishCapture(capture) {
    if (capture.finished) return;
    capture.finished = true;
    clearInterval(this.timer);
    capture.stream.getTracks().forEach(track => track.stop());
    if (this.recording === capture) {
      this.recording = null;
      this.#resetControls();
    }
    if (capture.cancelled || capture.failed) return;
    const blob = new Blob(capture.chunks, { type: capture.recorder.mimeType || 'audio/webm' });
    if (!blob.size) {
      this.status.textContent = '';
      toast(t('recordingFailed'));
      return;
    }
    this.#send(audioFile(blob), capture.target);
  }

  async #send(file, target) {
    this.sending = true;
    this.status.textContent = t('sendingVoice');
    this.#updateControls();
    try {
      if (target.type === 'dm') {
        await sendDirectMedia(target.id, { file, noteType: 'voice_note' });
      } else {
        const message = await sendGroupWalkie(target.id, file);
        if (message) this.#presentWalkie(message, this.groupGeneration, false);
      }
      this.status.textContent = t('walkieSent');
    } catch (error) {
      this.status.textContent = '';
      toast(error?.message || t('messageFailed'));
    } finally {
      this.sending = false;
      this.#updateControls();
    }
  }

  #resetControls() {
    clearInterval(this.timer);
    this.button.classList.remove('is-recording');
    this.button.setAttribute('aria-pressed', 'false');
    this.button.querySelector('span').textContent = t('holdToTalk');
    this.time.textContent = '';
    this.#updateControls();
  }
}
