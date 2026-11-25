// Messages: inbox (device cache first, refreshed in the background), real-time conversations and
// audio / video calls from any conversation.
import { t } from '../core/i18n.js';
import { auth } from '../core/net.js';
import { inbox } from '../data/chats.js';
import { profiles } from '../data/profiles.js';
import { presence } from '../data/presence.js';
import { loadThread, sendMessage, sendOneViewText, sendDirectMedia, markRead, onMessage, deleteForMe, searchPeople } from '../data/messages.js';
import { consumeViewOnce } from '../data/chat-media.js';
import { deleteGroup, discoverGroups, isActiveGroupMember, joinGroup, loadGroups } from '../data/groups.js';
import { Sheet } from './sheet.js';
import { h, icon, ago, avatar, formatDateTime, toast } from './dom.js';
import { calls } from './call-view.js';
import { GroupChatSheet, GroupCreateSheet, joinAndOpenGroup } from './group-view.js';
import { ChatComposer, mediaMessageContent } from './chat-composer.js';
import { WatchParty, watchableUrl } from './watch-party.js';
import { bindLongPress } from './long-press.js';
import { WalkieTalkieView } from './walkie-talkie.js';

const phoneIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z"/></svg>';
const backIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/></svg>';
/** Avatar with a green dot while that person is active. */
function presenceAvatar(person, size) {
  const node = h('span', { class: 'presence-avatar', 'data-presence': person.id });
  node.append(avatar(person, size), h('i', { class: 'presence-dot', 'aria-hidden': 'true' }));
  node.classList.toggle('online', presence.isOnline(person.id));
  return node;
}
presence.subscribe(() => document.querySelectorAll('[data-presence]').forEach(node => node.classList.toggle('online', presence.isOnline(node.dataset.presence))));

export class InboxView {
  constructor() {
    this.sheet = new Sheet({ title: t('chats'), className: 'inbox-sheet' });
    this.active = h('p', { class: 'muted inbox-active' });
    this.list = h('div', { class: 'chat-list' });
    this.groupList = h('div', { class: 'chat-list' });
    this.groups = [];
    this.groupActions = new Sheet({ title: t('groupActions'), className: 'group-manage-sheet', autoFocus: false });
    this.groupSection = h('section', { class: 'inbox-group-section' }, h('h3', { class: 'group-section-title' }, t('groups')), this.groupList);
    this.discoverBox = h('div', { class: 'inbox-group-discovery', hidden: true });
    this.searchBox = h('div', { class: 'stack', hidden: true });
    this.sheet.body.append(
      h('div', { class: 'inbox-tools' },
        this.active,
        h('div', { class: 'inbox-actions' },
          h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#toggleDiscover() }, t('discoverGroups')),
          h('button', {
            class: 'pill-btn inbox-walkie-action', type: 'button',
            'aria-label': t('walkieTalkie'), title: t('walkieTalkie'),
            onclick: () => this.chat.walkie.open(),
          }, h('span', { html: icon.mic }), t('walkieTalkie')),
          h('button', { class: 'pill-btn', type: 'button', onclick: () => this.createGroup.open() }, h('span', { html: icon.plus }), t('createGroup')),
          h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.#toggleSearch() }, h('span', { html: icon.plus }), t('newChat')))),
      this.searchBox, this.discoverBox, this.groupSection, this.list);
    this.chat = new ChatSheet();
    this.groupChat = new GroupChatSheet({
      onChanged: () => this.#loadGroups(),
      onDeleted: groupId => this.#removeGroupLocally(groupId),
    });
    this.createGroup = new GroupCreateSheet(group => {
      this.#loadGroups();
      if (group?.id) this.groupChat.open(group);
    });
    inbox.subscribe(rooms => this.#render(rooms));
    presence.subscribe(() => { this.active.textContent = presence.count ? `🟢 ${presence.count} ${t('activeUsers')}` : ''; });
    onMessage(() => {}); // opens the realtime connection so the inbox refreshes on new messages
  }

  open() {
    if (!inbox.value) this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    inbox.load().then(value => { if (value === undefined) inbox.refresh().then(rooms => !rooms && this.#render([])); });
    inbox.refresh();
    this.#loadGroups();
    presence.start();
    this.sheet.open();
  }

  async #loadGroups() {
    try {
      const groups = await loadGroups();
      this.groups = groups;
      this.#renderGroups();
    } catch (error) {
      this.groupList.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    }
  }

  #renderGroups() {
    this.groupList.replaceChildren(...(this.groups.length
      ? this.groups.map(group => this.#groupRow(group))
      : [h('p', { class: 'muted center' }, t('noGroups'))]));
  }

  #removeGroupLocally(groupId) {
    this.groups = this.groups.filter(group => group.id !== groupId);
    this.#renderGroups();
  }

  #groupRow(group) {
    const face = group.avatar_url
      ? h('img', { class: 'group-list-avatar', src: group.avatar_url, alt: '', loading: 'lazy' })
      : h('span', { class: 'group-list-avatar group-list-placeholder' }, '👥');
    const active = isActiveGroupMember(group);
    const pending = !active && group.join_status === 'pending';
    let statusAction;
    if (active) {
      statusAction = () => this.groupChat.open(group);
    } else if (group.join_status === 'invited') {
      statusAction = () => joinAndOpenGroup(group, joined => { this.#loadGroups(); this.groupChat.open(joined); }, () => this.#loadGroups());
    }
    const actionLabel = pending ? t('requestPending')
      : group.join_status === 'invited' ? t('acceptInvite') : t('openChat');
    const row = h('div', { class: `group-list-row${pending ? ' pending' : ''}`, 'data-group-id': group.id },
      statusAction
        ? h('button', { class: 'group-list-open', type: 'button', onclick: statusAction }, face,
          h('span', { class: 'chat-text' }, h('b', {}, group.name), h('small', { class: 'muted' }, `${group.caption || t(`joinModeLabel_${group.join_mode}`)}`)))
        : h('span', { class: 'group-list-open' }, face,
          h('span', { class: 'chat-text' }, h('b', {}, group.name), h('small', { class: 'muted' }, t('requestPending')))),
      statusAction ? h('button', { class: 'pill-btn group-row-action', type: 'button', onclick: statusAction }, actionLabel)
        : h('span', { class: 'muted group-row-action' }, actionLabel));
    if (this.#canManageGroup(group)) bindLongPress(row, () => this.#openGroupActions(group));
    return row;
  }

  #canManageGroup(group) {
    return group.created_by === auth.userId
      || ['admin', 'co_admin', 'owner'].includes(String(group.role || '').toLowerCase());
  }

  #openGroupActions(group) {
    if (!this.#canManageGroup(group)) return;
    this.groupActions.title = group.name || t('groupActions');
    const manage = h('button', {
      class: 'pill-btn', type: 'button',
      onclick: () => {
        this.groupActions.close();
        this.groupChat.manager.open(group);
      },
    }, t('manageGroup'));
    const remove = h('button', {
      class: 'pill-btn danger', type: 'button',
      onclick: () => this.#deleteGroupFromList(group),
    }, t('deleteGroup'));
    this.groupActions.body.replaceChildren(
      ...(this.#canManageGroup(group) ? [manage] : []),
      remove,
      h('button', { class: 'pill-btn', type: 'button', onclick: () => this.groupActions.close() }, t('cancel')));
    this.groupActions.open();
  }

  async #deleteGroupFromList(group) {
    if (!confirm(`${t('deleteGroup')}?`)) return;
    const previous = this.groups;
    this.groups = previous.filter(item => item.id !== group.id);
    this.#renderGroups();
    this.groupActions.close();
    try {
      await deleteGroup(group.id);
      this.groupChat.onChanged?.();
    } catch (error) {
      this.groups = previous;
      this.#renderGroups();
      toast(error?.message || t('groupActionFailed'));
    }
  }

  #toggleDiscover() {
    if (!this.discoverBox.hidden) { this.discoverBox.hidden = true; return; }
    const input = h('input', { class: 'field', type: 'search', placeholder: t('searchOpenGroups'), 'aria-label': t('searchOpenGroups') });
    const results = h('div', { class: 'chat-list' });
    let timer = 0, token = 0;
    const search = async () => {
      const mine = ++token;
      results.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
      try {
        const groups = await discoverGroups(input.value.trim());
        if (mine !== token) return;
        results.replaceChildren(...(groups.length ? groups.map(group => h('div', { class: 'group-discover-row' },
          h('div', { class: 'chat-text' }, h('b', {}, group.name), h('small', { class: 'muted' }, group.caption || t('joinModeLabel_open'))),
          h('button', { class: 'pill-btn hot', type: 'button', onclick: () => joinAndOpenGroup(group,
            joined => { this.discoverBox.hidden = true; this.#loadGroups(); this.groupChat.open(joined); },
            () => { toast(t('requestSent')); this.#loadGroups(); }) }, group.join_mode === 'open' ? t('joinGroup') : t('requestJoin'))))
          : [h('p', { class: 'muted center' }, t('noOpenGroups'))]));
      } catch (error) {
        if (mine === token) results.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    this.discoverBox.replaceChildren(input, results);
    this.discoverBox.hidden = false;
    search();
  }

  /** Opens a conversation directly (e.g. "Message" on someone's profile). */
  openWith(person) {
    if (!person?.id || person.id === auth.userId) return;
    this.chat.open(person);
  }

  #toggleSearch() {
    if (!this.searchBox.hidden) { this.searchBox.hidden = true; return; }
    const input = h('input', { class: 'field', type: 'search', placeholder: t('searchPeople'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('searchPeople') });
    const results = h('div', { class: 'chat-list' });
    let timer = 0, token = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++token;
        const q = input.value.trim();
        if (q.replace(/^@/, '').length < 2) { results.replaceChildren(); return; }
        results.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
        try {
          const people = await searchPeople(q);
          if (mine !== token) return;
          profiles.prime(people);
          results.replaceChildren(...(people.length ? people.map(person => h('button', { class: 'chat-row', type: 'button', onclick: () => { this.searchBox.hidden = true; this.chat.open(person); } },
            presenceAvatar(person, 40), h('div', { class: 'chat-text' }, h('b', {}, person.name), person.username ? h('span', { class: 'muted' }, `@${person.username}`) : null)))
            : [h('p', { class: 'muted center' }, t('noResults'))]));
        } catch { if (mine === token) results.replaceChildren(h('p', { class: 'muted center' }, t('retry'))); }
      }, 280);
    });
    this.searchBox.replaceChildren(input, results);
    this.searchBox.hidden = false;
    setTimeout(() => input.focus(), 50);
  }

  #render(rooms) {
    if (!rooms?.length) { this.list.replaceChildren(h('p', { class: 'muted center' }, t('noChats'))); return; }
    this.list.replaceChildren(...rooms.map(room => {
      const person = { id: room.peer, name: room.name, avatar: room.avatar };
      return h('button', { class: `chat-row${room.unread ? ' unread' : ''}`, type: 'button', onclick: () => this.chat.open(person) },
        presenceAvatar(person, 44),
        h('div', { class: 'chat-text' }, h('b', {}, room.name),
          h('span', { class: 'muted' }, room.preview === '🔒' ? `🔒 ${t('encrypted')}` : `${room.mine ? `${t('you')}: ` : ''}${room.preview}`)),
        h('small', { class: 'muted' }, ago(room.at)));
    }));
  }
}

class ChatSheet {
  constructor() {
    this.sheet = new Sheet({ title: '', className: 'chat-sheet', onClose: () => { this.peer = null; this.composer.cancelRecording(); this.walkie.detachFromDm(); this.watchParty.leave(); this.#clearRevealed(); } });
    this.sheet.heading.hidden = true;
    this.name = h('b', {});
    this.state = h('small', { class: 'muted' });
    this.face = h('span', {});
    this.list = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'polite' });
    this.revealed = new Map();
    this.composer = new ChatComposer({
      onSendText: (text, viewOnce) => this.#send(text, viewOnce),
      onSendMedia: media => this.#sendMedia(media),
    });
    this.walkie = new WalkieTalkieView();
    this.watchParty = new WatchParty();
    const iconBtn = (label, html, onclick) => h('button', { class: 'icon-btn chat-call', type: 'button', 'aria-label': label, title: label, html, onclick });
    let callMenuButton;
    const closeCallMenu = () => {
      callMenu.hidden = true;
      callMenuButton?.setAttribute('aria-expanded', 'false');
    };
    const callMenu = h('div', { class: 'chat-header-menu', role: 'menu', hidden: true },
      h('button', { class: 'chat-header-menu-item', type: 'button', role: 'menuitem', html: phoneIcon, onclick: () => { closeCallMenu(); if (this.peer) calls.start(this.peer.id, 'audio'); } }, t('audioCall')),
      h('button', { class: 'chat-header-menu-item', type: 'button', role: 'menuitem', html: icon.camera, onclick: () => { closeCallMenu(); if (this.peer) calls.start(this.peer.id, 'video'); } }, t('videoCall')),
      h('button', { class: 'chat-header-menu-item', type: 'button', role: 'menuitem', html: icon.play, onclick: () => { closeCallMenu(); this.watchParty.openPanel(); } }, t('watchTogether')));
    callMenu.id = 'dmConversationActions';
    callMenuButton = iconBtn(t('conversationActions'), phoneIcon, () => {
      callMenu.hidden = !callMenu.hidden;
      callMenuButton.setAttribute('aria-expanded', String(!callMenu.hidden));
    });
    callMenuButton.setAttribute('aria-haspopup', 'menu');
    callMenuButton.setAttribute('aria-controls', callMenu.id);
    this.sheet.body.append(
      h('header', { class: 'chat-head' },
        iconBtn(t('back'), backIcon, () => this.sheet.close()),
        this.face,
        h('div', { class: 'chat-who' }, this.name, this.state),
        h('div', { class: 'chat-header-actions' }, this.composer.walkieSlot, callMenuButton, callMenu)),
      this.watchParty.root,
      this.list, this.composer.form);
    this.messages = new Map();
    onMessage(event => this.#live(event));
    presence.subscribe(() => this.#paintState());
  }

  open(person) {
    this.composer.cancelRecording();
    this.watchParty.join('dm', person.id).catch(error => toast(error?.message || t('watchConnectFailed')));
    this.#clearRevealed();
    this.peer = { ...person, ...(profiles.peek(person.id) || {}), ...person };
    this.walkie.attachToDm(this.peer, this.composer.walkieSlot);
    this.name.textContent = this.peer.name || 'MilkyWay';
    this.face.replaceChildren(presenceAvatar(this.peer, 38));
    this.#paintState();
    this.messages.clear();
    this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.open();
    this.#load(person.id);
  }

  #paintState() {
    if (!this.peer) return;
    this.state.textContent = presence.isOnline(this.peer.id) ? t('activeNow') : (this.peer.username ? `@${this.peer.username}` : '');
  }

  async #load(peer) {
    try {
      const rows = await loadThread(peer);
      if (this.peer?.id !== peer) return;
      this.messages.clear();
      rows.forEach(row => this.messages.set(row.id, row));
      this.#render();
      markRead(peer).then(() => this.peer?.id === peer && import('../data/chats.js').then(m => m.inbox.refresh()));
    } catch (error) {
      if (this.peer?.id === peer) this.list.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    }
  }

  #render() {
    const rows = [...this.messages.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!rows.length) { this.list.replaceChildren(h('p', { class: 'muted center msg-empty' }, t('sayHello'))); return; }
    const lastMine = [...rows].reverse().find(row => row.sender_id === auth.userId);
    this.list.replaceChildren(...rows.map(row => this.#bubble(row, row === lastMine)));
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  #bubble(row, last) {
    const mine = row.sender_id === auth.userId;
    const encrypted = Number(row.encryption_version) > 0;
    const revealed = this.revealed.get(row.id);
    const content = revealed
      ? mediaMessageContent({ ...row, ...revealed, view_once: false })
      : encrypted ? h('p', {}, `🔒 ${t('encrypted')}`)
        : mediaMessageContent(row, { mine, onViewOnce: row.view_once && !mine ? () => this.#viewOnce(row) : undefined });
    const sharedUrl = encrypted ? '' : watchableUrl(row.body)
      || (row.message_type !== 'video_note' && (row.message_type === 'video' || row.media_type?.startsWith('video/'))
        ? watchableUrl(row.media_url) : '');
    const bubble = h('div', { class: `msg${mine ? ' mine' : ''}${row.pending ? ' pending' : ''}${row.failed ? ' failed' : ''}`, 'data-id': row.id },
      content,
      sharedUrl ? h('button', { class: 'pill-btn watch-message-action', type: 'button', onclick: () => this.watchParty.startFromLink(sharedUrl) }, t('watchTogether')) : null,
      h('small', {}, formatDateTime(row.created_at, { hour: '2-digit', minute: '2-digit' }), row.edited_at ? ` · ${t('edited')}` : '',
        mine && last && row.read_at ? ` · ${t('seen')}` : '', row.failed ? ` · ${t('messageFailed')}` : ''));
    if (!row.pending && !row.failed) {
      // Long-press (context menu) or double-tap: "Delete for me".
      bubble.addEventListener('contextmenu', event => { event.preventDefault(); this.#hide(row); });
      bubble.addEventListener('dblclick', () => this.#hide(row));
    }
    return bubble;
  }

  async #hide(row) {
    if (!confirm(`${t('deleteForMe')}?`)) return;
    try { await deleteForMe(row.id); this.messages.delete(row.id); this.#render(); } catch (error) { toast(error?.message || t('retry')); }
  }

  async #viewOnce(row) {
    try {
      const viewed = await consumeViewOnce(row.id);
      const revealed = viewed.blob
        ? { media_url: URL.createObjectURL(viewed.blob), media_type: viewed.mediaType }
        : { body: viewed.body, media_url: '', media_type: '' };
      this.revealed.set(row.id, revealed);
      this.messages.set(row.id, { ...row, ...revealed, view_once: false });
      this.#render();
    } catch (error) { toast(error?.message || t('viewOnceFailed')); }
  }

  #clearRevealed() {
    for (const media of this.revealed.values()) if (media.media_url?.startsWith('blob:')) URL.revokeObjectURL(media.media_url);
    this.revealed.clear();
  }

  async #send(text, viewOnce = false) {
    if (!text || !this.peer) return;
    const peer = this.peer.id;
    const temp = {
      id: `tmp-${Date.now()}`, sender_id: auth.userId, receiver_id: peer,
      body: viewOnce ? 'View-once message' : text, view_once: viewOnce,
      created_at: new Date().toISOString(), pending: true,
    };
    this.messages.set(temp.id, temp);
    this.#render();
    try {
      const saved = viewOnce ? await sendOneViewText(peer, text) : await sendMessage(peer, text);
      this.messages.delete(temp.id);
      if (saved?.id) this.messages.set(saved.id, saved);
    } catch (error) {
      temp.pending = false; temp.failed = true;
      toast(error?.status === 403 || /row-level security/i.test(String(error?.message || '')) ? t('cantMessage') : t('messageFailed'));
    }
    if (this.peer?.id === peer) this.#render();
  }

  async #sendMedia(media) {
    if (!this.peer) return;
    const peer = this.peer.id;
    const message = await sendDirectMedia(peer, media);
    if (this.peer?.id === peer && message?.id) {
      this.messages.set(message.id, message);
      this.#render();
    }
  }

  #live({ type, message }) {
    if (!this.peer || !message) return;
    const peer = this.peer.id;
    const inThread = (message.sender_id === peer && message.receiver_id === auth.userId) || (message.sender_id === auth.userId && message.receiver_id === peer);
    if (type === 'DELETE') {
      if (this.revealed.has(message.id)) return;
      if (this.messages.delete(message.id)) this.#render();
      return;
    }
    if (!inThread) return;
    if (type === 'INSERT' && message.sender_id === auth.userId) {
      // Our own message echoed back: replace the optimistic copy instead of showing it twice.
      for (const [id, row] of this.messages) if (row.pending && row.body === message.body) this.messages.delete(id);
    }
    this.messages.set(message.id, { ...(this.messages.get(message.id) || {}), ...message });
    this.#render();
    if (type === 'INSERT' && message.sender_id === peer && this.sheet.isOpen && document.visibilityState === 'visible') markRead(peer);
  }
}
