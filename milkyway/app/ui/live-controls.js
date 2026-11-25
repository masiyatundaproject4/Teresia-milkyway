// LIVE host controls (TikTok LIVE style): guest management, LIVE settings (comment filters, moderation, audience)
// and viewer management. Everything here is a thin UI over LiveSession.control(); the server enforces every rule
// (api/milkyway-live-room.js), so a modified client cannot bypass the host's choices.
//
// Viewers get the matching pieces: the invitation prompt and the join-as-guest request.
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, icon, toast, avatar, WaitIndicator } from './dom.js';

const SLOW_STEPS = [0, 3, 10, 30, 60];
const MAX_SEATS = 8;
const roomMembers = status => Array.isArray(status?.members)
  ? status.members.filter(member => member && typeof member === 'object' && member.userId)
  : [];
const displayName = name => typeof name === 'string' && name.trim() && !/^(null|undefined)$/i.test(name.trim())
  ? name
  : 'MilkyWay';

/** Runs a session action with a toast on failure; returns true on success. */
async function run(session, action, extra = {}, okMessage = '') {
  try {
    await session.control(action, extra);
    if (okMessage) toast(okMessage);
    return true;
  } catch (error) {
    toast(error?.message || t('liveUnavailable'));
    return false;
  }
}

/** A button that needs a second tap within 3 s (destructive actions). */
function confirmButton(label, onConfirm, className = 'pill-btn danger') {
  let armed = 0;
  const button = h('button', { class: className, type: 'button' }, label);
  button.addEventListener('click', () => {
    if (!armed) {
      button.textContent = t('tapAgain');
      button.classList.add('armed');
      armed = setTimeout(() => { armed = 0; button.textContent = label; button.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0;
    onConfirm();
  });
  return button;
}

const actionBtn = (label, onClick, className = 'pill-btn') => {
  const button = h('button', { class: className, type: 'button' }, label);
  button.addEventListener('click', onClick);
  return button;
};

function personRow(person, ...actions) {
  return h('div', { class: 'lc-person' },
    avatar(person, 36),
    h('div', { class: 'lc-person-name' }, h('b', {}, displayName(person.name)),
      person.hostMuted ? h('small', {}, `🔇 ${t('muteMic')}`) : person.commentMuted ? h('small', {}, `💬 ${t('mutedCommenters')}`) : null),
    h('div', { class: 'lc-person-actions' }, ...actions.filter(Boolean)));
}

const section = (title, ...children) => h('section', { class: 'lc-section' }, h('h3', {}, title), ...children);
const note = text => h('p', { class: 'lc-note' }, text);

function toggleRow(label, checked, onchange) {
  const input = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch' });
  input.checked = !!checked;
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'lc-toggle' }, h('span', {}, label), input);
}

function settingRow(label, detail, onClick, disabled = false) {
  return h('button', { class: 'lc-setting-row', type: 'button', onclick: onClick, disabled, 'aria-disabled': String(disabled) },
    h('span', {}, h('b', {}, label), detail ? h('small', {}, detail) : null),
    h('span', { class: 'lc-setting-chevron', 'aria-hidden': 'true' }, '›'));
}

function segmented(name, options, value, onchange) {
  const group = h('div', { class: `segmented lc-seg lc-seg-${options.length}`, role: 'radiogroup' });
  for (const [key, label] of options) {
    const input = h('input', { type: 'radio', name, value: String(key) });
    input.checked = String(key) === String(value);
    input.addEventListener('change', () => { if (input.checked) onchange(key); });
    group.append(h('label', {}, input, h('span', {}, label)));
  }
  return group;
}

function readHostPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(`mw_live_preferences:${auth.userId || 'guest'}`) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    console.warn('[live] Could not read LIVE preferences', error);
    return {};
  }
}

/** Host-side panels. One instance per broadcast; destroy() when the LIVE ends. */
export class HostControls {
  constructor(session, { openProfile } = {}) {
    this.session = session;
    this.preferences = readHostPreferences();
    this.openProfile = openProfile;
    this.sheets = [];
    this.guestSheet = this.#sheet(t('guests'), 'lc-sheet');
    this.settingsSheet = this.#sheet('', 'lc-sheet lc-live-settings-sheet');
    this.multiGuestSheet = this.#sheet('', 'lc-sheet lc-multiguest-sheet');
    this.multiGuestWait = new WaitIndicator(this.multiGuestSheet.panel);
    this.audienceSheet = this.#sheet('', 'lc-sheet');
    this.preferenceSheet = this.#sheet('', 'lc-sheet');
    this.viewerSheet = this.#sheet(t('viewersTitle'), 'lc-sheet');
    this.moderationSheet = this.#sheet(t('moderation'), 'lc-sheet');
    this.modQuery = '';
    this.personSheet = this.#sheet('', 'lc-sheet lc-person-sheet');
    this.query = '';
    this.knownRequests = null;
    this.offs = [
      session.on('room', status => { this.#announceRequests(status); this.#rerender(); }),
      session.on('audience', () => { if (this.viewerSheet.isOpen || this.guestSheet.isOpen || this.moderationSheet.isOpen) this.#rerender(); }),
      // A viewer's request arrived as a direct signal: bring the requests list up to date if it is open.
      session.on('stage-request', () => this.#rerender()),
      session.on('declined', userId => {
        const person = this.#people().find(entry => entry.userId === userId);
        toast(`${displayName(person?.name)} ${t('declined')}`);
      }),
    ];
  }

  destroy() {
    this.offs.forEach(off => off());
    this.multiGuestWait.destroy();
    this.sheets.forEach(sheet => sheet.root.remove());
  }

  openGuests() {
    this.#renderGuests();
    this.guestSheet.open();
    this.session.refresh();
  }
  /** Moderation: comment rules plus everyone watching, with quick mute / remove and the muted and removed lists. */
  openModeration() { this.#renderModeration(); this.moderationSheet.open(); }
  openSettings() { this.#renderSettings(); this.settingsSheet.open(); }
  openViewers() { this.#renderViewers(); this.viewerSheet.open(); }
  async openMultiGuest() {
    this.#renderMultiGuest();
    this.multiGuestSheet.open();
    const settings = this.session.settings;
    const layout = Number(settings.layout);
    if (settings.showGuestSlots && settings.layoutStyle === 'featured' && layout > 1) return;
    if (await run(this.session, 'settings', {
      showGuestSlots: true,
      layout: layout > 1 ? layout : 8,
      layoutStyle: 'featured',
    }) && this.multiGuestSheet.isOpen) this.#renderMultiGuest();
  }
  /** Actions for one person; `message` is set when opened from a comment. */
  openPerson(person, message = null) {
    if (!person?.userId || person.userId === auth.userId) return;
    this.focus = { userId: person.userId, fallback: person, message };
    this.#renderPerson();
    this.personSheet.open();
  }

  /** Pending guest requests, for the badge on the guests button. */
  get pendingCount() { return this.#people().filter(person => person.state === 'pending' && !person.invited).length; }

  // A short notice when someone new asks to join, so the host never misses a request.
  #announceRequests(status) {
    const pending = roomMembers(status).filter(member => member.state === 'pending' && !member.invited);
    const ids = new Set(pending.map(member => member.userId));
    if (this.knownRequests && !this.guestSheet.isOpen) {
      const fresh = pending.filter(member => !this.knownRequests.has(member.userId));
      if (fresh.length) toast(fresh.length === 1 ? `${displayName(fresh[0].name)} ${t('wantsToJoin')}` : `${fresh.length} ${t('newRequests')}`);
    }
    this.knownRequests = ids;
  }

  #sheet(title, className) { const sheet = new Sheet({ title, className }); this.sheets.push(sheet); return sheet; }

  #savePreference(key, value) {
    this.preferences[key] = value;
    try {
      localStorage.setItem(`mw_live_preferences:${auth.userId || 'guest'}`, JSON.stringify(this.preferences));
      toast(t('liveSettingSaved'));
    } catch (error) {
      console.warn('[live] Could not save LIVE preferences', error);
      toast(t('liveSettingFailed'));
    }
  }

  #renderPreferenceOptions(key, title, options) {
    const close = h('button', { class: 'lc-sheet-close', type: 'button', 'aria-label': t('close'), onclick: () => this.preferenceSheet.close() }, '×');
    const choices = options.map(([value, label]) => {
      const selectedValue = this.preferences[key] ?? options[0][0];
      const input = h('input', { type: 'radio', name: `livePreference-${key}`, value, checked: String(selectedValue) === String(value) });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.#savePreference(key, value);
        this.#renderSettings();
        this.#renderPreferenceOptions(key, title, options);
      });
      return h('label', { class: 'lc-audience-choice' }, input, h('span', {}, label));
    });
    this.preferenceSheet.body.replaceChildren(
      h('header', { class: 'lc-sheet-header' }, h('strong', {}, title), close),
      section(title, ...choices));
    this.preferenceSheet.open();
  }

  #rerender() {
    if (this.guestSheet.isOpen) this.#renderGuests();
    if (this.settingsSheet.isOpen) this.#renderSettings({ keepInputs: true });
    if (this.multiGuestSheet.isOpen) this.#renderMultiGuest();
    if (this.viewerSheet.isOpen) this.#renderViewers();
    if (this.moderationSheet.isOpen) this.#renderModeration();
    if (this.personSheet.isOpen) this.#renderPerson();
  }

  // Members known to the server, merged with who is connected to the media room right now.
  #people() {
    const status = this.session.status;
    const byId = new Map(roomMembers(status).map(member => [member.userId, { ...member }]));
    for (const participant of this.session.audience()) {
      const known = byId.get(participant.userId);
      if (known) known.online = true;
      else byId.set(participant.userId, { userId: participant.userId, name: participant.name || 'MilkyWay', avatar: '', state: 'viewer', online: true });
    }
    const settings = this.session.settings;
    for (const person of byId.values()) {
      person.commentMuted = !!settings.mutedIds?.includes(person.userId);
      person.blocked = !!settings.blockedIds?.includes(person.userId);
      person.invited = !!settings.invites?.[person.userId];
    }
    return [...byId.values()];
  }

  // ---- Guests -----------------------------------------------------------------------------------------------
  #renderGuests() {
    const s = this.session, settings = s.settings;
    const people = this.#people();
    const stage = people.filter(person => person.state === 'speaker');
    const requests = people.filter(person => person.state === 'pending' && !person.invited && !person.blocked);
    const invited = people.filter(person => person.invited && person.state !== 'speaker');
    const seats = Math.max(1, Math.min(MAX_SEATS, (settings.layout || 9) - 1));
    const seatLabel = h('b', {}, `${stage.length}/${seats}`);
    const setSeats = next => {
      const value = Math.max(1, Math.min(MAX_SEATS, next));
      if (value < stage.length) { toast(t('removeGuestFirst')); return; }
      run(s, 'settings', { layout: value + 1 });
    };
    const inviteSection = section(t('inviteViewers'), ...this.#inviteList(people));
    // Seats 1–8: guests on stage, open seats (tap to invite) and closed seats (tap to open up to that seat).
    const seatGrid = h('div', { class: 'lc-seats', role: 'list' }, ...Array.from({ length: MAX_SEATS }, (_, i) => {
      const n = i + 1;
      const person = stage[i];
      if (person) {
        const seat = h('button', { class: 'lc-seat taken', type: 'button', role: 'listitem' },
          h('span', { class: 'lc-seat-n' }, String(n)), avatar(person, 36), h('small', {}, displayName(person.name)),
          person.hostMuted ? h('span', { class: 'lc-seat-mic', html: icon.muted }) : null);
        seat.addEventListener('click', () => this.openPerson(person));
        return seat;
      }
      if (n > seats) {
        const seat = h('button', { class: 'lc-seat locked', type: 'button', role: 'listitem', 'aria-label': `${t('openSeat')} ${n}` },
          h('span', { class: 'lc-seat-n' }, String(n)), h('span', { class: 'lc-seat-icon' }, '🔒'), h('small', {}, t('closedSeat')));
        seat.addEventListener('click', () => setSeats(n));
        return seat;
      }
      const seat = h('button', { class: 'lc-seat empty', type: 'button', role: 'listitem' },
        h('span', { class: 'lc-seat-n' }, String(n)), h('span', { class: 'lc-seat-icon' }, '+'), h('small', {}, t('emptySeat')));
      seat.addEventListener('click', () => inviteSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return seat;
    }));

    this.guestSheet.body.replaceChildren(
      section(t('seats'),
        h('div', { class: 'lc-stepper' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '−', disabled: seats <= 1 || seats <= stage.length, onclick: () => setSeats(seats - 1) }, '−'),
          seatLabel,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '+', disabled: seats >= MAX_SEATS, onclick: () => setSeats(seats + 1) }, '+')),
        toggleRow(t('showGuestSlots'), !!settings.showGuestSlots, value => run(s, 'settings', { showGuestSlots: value })),
        seatGrid),
      section(t('admission'),
        segmented('lcAdmission', [['approval', t('admissionApproval')], ['open', t('admissionDirect')], ['broadcast', t('admissionOff')]], settings.admission === 'broadcast' || settings.admission === 'open' ? settings.admission : 'approval',
          value => run(s, 'settings', { admission: value })),
        toggleRow(t('allowRequests'), settings.allowRequests !== false, value => run(s, 'settings', { allowRequests: value }))),
      section(`${t('onStage')} (${stage.length})`,
        ...(stage.length ? stage.map(person => personRow(person,
          person.hostMuted
            ? actionBtn(t('unmuteMic'), () => run(s, 'allow-mic', { target: person.userId }))
            : actionBtn(t('muteMic'), () => run(s, 'mute', { target: person.userId })),
          actionBtn(t('removeFromStage'), () => run(s, 'remove', { target: person.userId })),
          confirmButton(t('removeFromLive'), () => run(s, 'kick', { target: person.userId }, t('removed')))))
          : [note(t('noGuests'))])),
      section(`${t('requests')} (${requests.length})`,
        ...(requests.length ? requests.map(person => personRow(person,
          actionBtn(t('accept'), () => run(s, 'approve', { target: person.userId }), 'pill-btn hot'),
          actionBtn(t('decline'), () => run(s, 'reject', { target: person.userId }))))
          : [note(t('noRequests'))])),
      invited.length ? section(`${t('invited')} (${invited.length})`,
        ...invited.map(person => personRow(person, actionBtn(t('cancelInvite'), () => run(s, 'cancel-invite', { target: person.userId }))))) : null,
      inviteSection,
    );
  }

  #inviteList(people) {
    const candidates = people.filter(person => person.online && person.state === 'viewer' && !person.invited && !person.blocked);
    if (!candidates.length) return [note(t('noViewers'))];
    return candidates.slice(0, 50).map(person => personRow(person,
      actionBtn(t('invite'), () => run(this.session, 'invite', { target: person.userId }, t('inviteSent')), 'pill-btn hot')));
  }

  // ---- LIVE settings ----------------------------------------------------------------------------------------
  #renderSettings({ keepInputs = false } = {}) {
    const s = this.session, settings = s.settings;
    if (keepInputs && this.settingsSheet.body.contains(document.activeElement) && document.activeElement.matches('input[type="text"], input[type="url"]')) return;
    const close = h('button', { class: 'lc-sheet-close', type: 'button', 'aria-label': t('close'), onclick: () => this.settingsSheet.close() }, '×');
    const header = h('header', { class: 'lc-sheet-header' }, h('strong', {}, t('liveSettings')), close);
    const audience = settingRow(t('liveWhoCanWatch'), s.live.scope === 'followers' ? t('followersOnly') : t('everyone'), () => {
      this.#renderAudience();
      this.audienceSheet.open();
    });
    const noise = toggleRow(t('noiseSuppression'), s.noiseSuppression !== false, (enabled, input) => {
      s.setNoiseSuppression(enabled).then(() => toast(t('liveSettingSaved'))).catch(error => {
        input.checked = !enabled;
        s.noiseSuppression = !enabled;
        console.warn('[live] Could not update noise suppression', error);
        toast(t('liveSettingFailed'));
      });
    });
    const giftPreferences = toggleRow(t('giftPreferences'), settings.giftsEnabled !== false, enabled => {
      void run(s, 'settings', { giftsEnabled: enabled }, t('liveSettingSaved'));
    });
    const practice = toggleRow(t('practiceMode'), this.preferences.practiceMode === true,
      enabled => this.#savePreference('practiceMode', enabled));
    const qualityOptions = [
      ['auto', t('liveQualityAuto')],
      ['standard', t('liveQualityStandard')],
      ['data-saver', t('liveQualityDataSaver')],
    ];
    const quality = settingRow(t('liveQuality'),
      qualityOptions.find(([value]) => value === this.preferences.quality)?.[1] || t('liveQualityAuto'),
      () => this.#renderPreferenceOptions('quality', t('liveQuality'), qualityOptions));
    const assistant = toggleRow(t('liveAiAssistant'), this.preferences.liveAiAssistant === true,
      enabled => this.#savePreference('liveAiAssistant', enabled));
    const moderators = settingRow(t('moderators'), t('moderation'), () => this.openModeration());
    const groupChats = toggleRow(t('groupChats'), this.preferences.groupChats === true,
      enabled => this.#savePreference('groupChats', enabled));
    const rankings = toggleRow(t('rankings'), this.preferences.rankings !== false,
      enabled => this.#savePreference('rankings', enabled));
    const recordings = toggleRow(t('liveRecordings'), this.preferences.liveRecordings === true,
      enabled => this.#savePreference('liveRecordings', enabled));
    const monitoring = toggleRow(t('voiceMonitoring'), this.preferences.voiceMonitoring === true,
      enabled => this.#savePreference('voiceMonitoring', enabled));
    const stability = toggleRow(t('optimiseStability'), this.preferences.optimiseStability !== false,
      enabled => this.#savePreference('optimiseStability', enabled));
    this.settingsSheet.body.replaceChildren(
      header,
      section(t('liveAudioVideo'), monitoring, stability),
      section(t('liveAudience'), audience, practice, settingRow(t('aboutMe'), t('profile'), () => {
        this.openProfile?.({ id: auth.userId, name: auth.name });
      }), quality, noise, assistant),
      section(t('liveSafety'), settingRow(t('markedViewers'), t('viewersTitle'), () => this.openViewers()),
        settingRow(t('mutedAccounts'), t('mutedCommenters'), () => this.openModeration()),
        settingRow(t('blockedAccounts'), t('removedPeople'), () => this.openModeration()),
        settingRow(t('commentSafety'), t('moderation'), () => this.openModeration()),
        moderators),
      section(t('liveCommunity'), giftPreferences, groupChats, rankings, recordings),
      section(t('guests'), settingRow(t('multiGuestSettings'), t('guestLayout'), () => this.openMultiGuest())));
  }

  #renderAudience() {
    const scope = this.session.live.scope === 'followers' ? 'followers' : 'public';
    const close = h('button', { class: 'lc-sheet-close', type: 'button', 'aria-label': t('close'), onclick: () => this.audienceSheet.close() }, '×');
    const options = [['public', t('everyone')], ['followers', t('followersOnly')]];
    const controls = options.map(([value, label]) => {
      const input = h('input', { type: 'radio', name: 'liveAudienceScope', value, checked: value === scope });
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        input.disabled = true;
        if (await run(this.session, 'scope', { scope: value }, t('liveSettingSaved'))) {
          this.session.live.scope = value;
          this.#renderSettings();
          this.#renderAudience();
        }
        input.disabled = false;
      });
      return h('label', { class: 'lc-audience-choice' }, input, h('span', {}, label));
    });
    this.audienceSheet.body.replaceChildren(
      h('header', { class: 'lc-sheet-header' }, h('strong', {}, t('liveWhoCanWatch')), close),
      section(t('liveAudience'), ...controls));
  }

  #renderMultiGuest() {
    const s = this.session, settings = s.settings;
    const cards = [
      ['fullscreen', 2, t('layoutFullScreen')], ['featured', 3, t('layoutFluidPanel')],
      ['fullscreen', 5, t('layoutFluidGrid')], ['fullscreen', 9, t('layoutFixedGrid')],
      ['featured', 2, t('layoutSideBySide')], ['featured', 4, t('layoutSpotlight')],
      ['fullscreen', 5, t('layoutRoundtableOne')], ['featured', 8, t('layoutRoundtableTwo')],
    ];
    let selectedIndex = this.selectedGuestLayout ?? cards.findIndex(([style, count]) =>
      style === (settings.layoutStyle === 'featured' ? 'featured' : 'fullscreen') && Number(count) === Number(settings.layout));
    if (selectedIndex < 0) selectedIndex = cards.findIndex(([style]) => style === (settings.layoutStyle === 'featured' ? 'featured' : 'fullscreen'));
    if (selectedIndex < 0) selectedIndex = 0;
    const grid = h('div', { class: 'gl-layout-cards' }, ...cards.map(([style, count, label], index) => h('button', {
      class: `gl-layout-card${index === selectedIndex ? ' is-selected' : ''}`, type: 'button',
      'aria-pressed': String(index === selectedIndex), onclick: async () => {
        this.multiGuestWait.start('layout', t('switchingLiveMode'));
        try {
          if (!await run(s, 'settings', { layout: count, layoutStyle: style, showGuestSlots: true })) return;
          selectedIndex = index;
          this.selectedGuestLayout = index;
          grid.querySelectorAll('.gl-layout-card').forEach((item, itemIndex) => {
            item.classList.toggle('is-selected', itemIndex === index);
            item.setAttribute('aria-pressed', String(itemIndex === index));
          });
        } finally { this.multiGuestWait.stop('layout'); }
      },
    }, h('span', { 'aria-hidden': 'true' }, '▦'), h('b', {}, label))));
    const autoAccept = toggleRow(t('autoAcceptRequests'), settings.admission === 'open', value => {
      void run(s, 'settings', { admission: value ? 'open' : 'approval', allowRequests: true });
    });
    const audience = [['everyone', 'open', t('everyone')], ['followers', 'approval', t('followers')], ['friends', 'approval', t('friends')], ['gifters', 'approval', t('gifters')]];
    this.guestAudienceChoice ||= settings.admission === 'open' ? 'everyone' : 'followers';
    const radios = h('div', { class: 'gl-audience-options', role: 'radiogroup', 'aria-label': t('admission') },
      ...audience.map(([choice, value, label]) => {
        const input = h('input', { type: 'radio', name: 'multiGuestAudience', value: choice, checked: choice === this.guestAudienceChoice });
        input.addEventListener('change', () => {
          if (!input.checked) return;
          this.guestAudienceChoice = choice;
          void run(s, 'settings', { admission: value, allowRequests: true });
        });
        return h('label', { class: 'gl-audience-option' }, input, h('span', {}, label));
      }));
    this.multiGuestSheet.body.replaceChildren(
      h('header', { class: 'lc-sheet-header' },
        h('button', { class: 'lc-sheet-back', type: 'button', 'aria-label': t('back'), onclick: () => this.multiGuestSheet.close() }, '‹'),
        h('strong', {}, t('multiGuestSettings'))),
      section(t('guestLayout'),
        h('div', { class: 'gl-layout-heading' }, h('b', {}, t('guestLayout')),
          h('button', { class: 'gl-show-all', type: 'button', onclick: () => grid.classList.toggle('show-all') }, t('showAll'))),
        grid),
      section(t('admission'), autoAccept, radios, note(t('guestAdmissionSupportNote'))));
  }

  // ---- Moderation -------------------------------------------------------------------------------------------
  #renderModeration() {
    const s = this.session, settings = s.settings;
    // Don't wipe the search box while the host is typing in it.
    const typing = this.moderationSheet.body.contains(document.activeElement) && document.activeElement.matches('input[type="search"]');
    const people = this.#people();
    const byId = id => people.find(person => person.userId === id) || { userId: id, name: 'MilkyWay' };
    const muted = (settings.mutedIds || []).map(byId);
    const blocked = (settings.blockedIds || []).map(byId);

    const list = h('div', { class: 'lc-list' });
    const paint = () => {
      const q = this.modQuery.trim().toLowerCase();
      const watching = this.#people().filter(person => person.online && !person.blocked && (!q || (person.name || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.state === 'speaker') - (a.state === 'speaker') || (a.name || '').localeCompare(b.name || ''));
      list.replaceChildren(...(watching.length ? watching.slice(0, 200).map(person => {
        const row = personRow(person,
          person.commentMuted
            ? actionBtn(t('unmute'), event => { event.stopPropagation(); run(s, 'unmute-comments', { target: person.userId }); })
            : actionBtn(t('muteComments'), event => { event.stopPropagation(); run(s, 'mute-comments', { target: person.userId }); }),
          confirmButton(t('removeFromLive'), () => run(s, 'kick', { target: person.userId }, t('removed'))));
        row.classList.add('tappable');
        row.addEventListener('click', event => { if (!event.target.closest('button')) this.openPerson(person); });
        return row;
      }) : [note(t('noViewers'))]));
    };
    if (typing) { paint(); this.moderationSheet.body.querySelector('.lc-list')?.replaceWith(list); return; }
    const search = h('input', { class: 'field', type: 'search', placeholder: t('searchViewers'), value: this.modQuery });
    search.addEventListener('input', () => { this.modQuery = search.value; paint(); });
    paint();

    this.moderationSheet.body.replaceChildren(
      section(t('comments2'),
        segmented('lcModComments', [['everyone', t('commentsEveryone')], ['followers', t('commentsFollowers')], ['off', t('commentsOff')]], settings.comments || 'everyone',
          value => run(s, 'settings', { comments: value })),
        h('div', { class: 'lc-label' }, t('slowMode')),
        segmented('lcModSlow', SLOW_STEPS.map(step => [step, step ? `${step}${t('seconds')}` : t('slowOff')]), settings.slowMode || 0,
          value => run(s, 'settings', { slowMode: Number(value) })),
        toggleRow(t('filterLinks'), settings.filterLinks, value => run(s, 'settings', { filterLinks: value })),
        settings.pinned ? h('div', { class: 'lc-inline' }, h('span', { class: 'lc-note' }, `📌 ${settings.pinned.name || 'MilkyWay'}: ${settings.pinned.body || ''}`),
          actionBtn(t('unpinComment'), () => run(s, 'unpin'))) : null),
      section(t('viewersTitle'), search, list),
      section(`${t('mutedCommenters')} (${muted.length})`,
        ...(muted.length ? muted.map(person => personRow(person, actionBtn(t('unmute'), () => run(s, 'unmute-comments', { target: person.userId })))) : [note(t('noneYet'))])),
      section(`${t('removedPeople')} (${blocked.length})`,
        ...(blocked.length ? blocked.map(person => personRow(person, actionBtn(t('unblock'), () => run(s, 'unblock', { target: person.userId })))) : [note(t('noneYet'))])),
    );
  }

  // ---- Viewers ----------------------------------------------------------------------------------------------
  #renderViewers() {
    const keep = this.viewerSheet.body.contains(document.activeElement);
    const search = h('input', { class: 'field', type: 'search', placeholder: t('searchViewers'), value: this.query });
    const list = h('div', { class: 'lc-list' });
    const paint = () => {
      const q = this.query.trim().toLowerCase();
      const people = this.#people().filter(person => person.online && !person.blocked && (!q || (person.name || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.state === 'speaker') - (a.state === 'speaker') || (a.name || '').localeCompare(b.name || ''));
      this.viewerSheet.title = `${t('viewersTitle')} (${people.length})`;
      list.replaceChildren(...(people.length ? people.slice(0, 200).map(person => {
        const row = personRow(person,
          person.state === 'speaker' ? h('span', { class: 'lc-tag' }, t('onStage')) : person.invited ? h('span', { class: 'lc-tag' }, t('invited')) : null,
          h('button', { class: 'icon-btn lc-more', type: 'button', 'aria-label': t('moderation'), html: icon.shield }));
        row.classList.add('tappable');
        row.addEventListener('click', () => this.openPerson(person));
        return row;
      }) : [note(t('noViewers'))]));
    };
    search.addEventListener('input', () => { this.query = search.value; paint(); });
    paint();
    this.viewerSheet.body.replaceChildren(search, list);
    if (keep) search.focus({ preventScroll: true });
  }

  // ---- One person -------------------------------------------------------------------------------------------
  #renderPerson() {
    const s = this.session;
    const focus = this.focus;
    if (!focus) return;
    const person = this.#people().find(entry => entry.userId === focus.userId) || { ...focus.fallback, state: focus.fallback.state || 'viewer' };
    const message = focus.message;
    const id = person.userId;
    const pinnedId = s.settings.pinned?.id;
    const close = () => this.personSheet.close();
    this.personSheet.title = person.name || 'MilkyWay';

    const stage = person.state === 'speaker'
      ? [person.hostMuted
          ? actionBtn(t('unmuteMic'), () => run(s, 'allow-mic', { target: id }))
          : actionBtn(t('muteMic'), () => run(s, 'mute', { target: id })),
         actionBtn(t('removeFromStage'), () => run(s, 'remove', { target: id }))]
      : person.state === 'pending' && !person.invited
        ? [actionBtn(t('accept'), () => run(s, 'approve', { target: id }), 'pill-btn hot'), actionBtn(t('decline'), () => run(s, 'reject', { target: id }))]
        : person.invited
          ? [actionBtn(t('cancelInvite'), () => run(s, 'cancel-invite', { target: id }))]
          : person.blocked ? [] : [actionBtn(t('invite'), () => run(s, 'invite', { target: id }, t('inviteSent')), 'pill-btn hot')];

    this.personSheet.body.replaceChildren(
      h('div', { class: 'lc-person-head' }, avatar(person, 56), h('b', {}, person.name || 'MilkyWay'),
        person.state === 'speaker' ? h('span', { class: 'lc-tag' }, t('onStage')) : null),
      message ? h('blockquote', { class: 'lc-quote' }, message.body) : null,
      h('div', { class: 'lc-actions' },
        this.openProfile ? actionBtn(t('viewProfile'), () => { close(); this.openProfile({ id, name: person.name, avatar: person.avatar }); }) : null,
        ...stage,
        message && message.id !== pinnedId ? actionBtn(`📌 ${t('pinComment')}`, async () => { if (await run(s, 'pin', { id: message.id }, t('pinned'))) close(); }) : null,
        message && message.id === pinnedId ? actionBtn(t('unpinComment'), () => run(s, 'unpin')) : null,
        message ? actionBtn(t('deleteComment'), async () => { if (await run(s, 'delete-message', { id: message.id })) close(); }) : null,
        person.commentMuted
          ? actionBtn(t('unmuteComments'), () => run(s, 'unmute-comments', { target: id }))
          : actionBtn(t('muteComments'), () => run(s, 'mute-comments', { target: id })),
        person.blocked
          ? actionBtn(t('unblock'), () => run(s, 'unblock', { target: id }))
          : confirmButton(t('removeFromLive'), async () => { if (await run(s, 'kick', { target: id }, t('removed'))) close(); })),
    );
  }
}

/** Viewer-side prompt shown when the host invites them on stage. */
export class InvitePrompt {
  constructor(session, hostName) {
    this.session = session;
    this.sheet = new Sheet({ title: t('joinLive'), className: 'lc-sheet lc-invite' });
    this.sheet.body.append(
      h('p', { class: 'lc-invite-text' }, h('b', {}, hostName || 'MilkyWay'), ' ', t('invitedYou')),
      h('div', { class: 'lc-actions' },
        actionBtn(t('accept'), async () => {
          this.sheet.close();
          try { await session.acceptInvite(); } catch (error) { toast(error?.message || t('liveUnavailable')); }
        }, 'pill-btn hot wide'),
        actionBtn(t('decline'), () => { this.sheet.close(); session.declineInvite().catch(() => {}); }, 'pill-btn wide')));
  }
  open() { this.sheet.open(); }
  destroy() { this.sheet.root.remove(); }
}
