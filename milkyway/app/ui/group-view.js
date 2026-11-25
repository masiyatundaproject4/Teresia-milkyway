// Group conversations and their membership/settings controls.
import { auth } from '../core/net.js';
import { profiles } from '../data/profiles.js';
import { searchPeople } from '../data/messages.js';
import {
  addGroupMembers, clearGroupMessages, createGroup, decideGroupRequest, deleteGroup, deleteGroupMessage,
  isActiveGroupMember, joinGroup, leaveGroup, loadGroup, loadGroupMessages, onGroupMessage, removeGroupMember,
  sendGroupMedia, sendGroupMessage, sendGroupOneViewText, setGroupRole, updateGroup,
} from '../data/groups.js';
import { consumeViewOnce } from '../data/chat-media.js';
import { t } from '../core/i18n.js';
import { Sheet } from './sheet.js';
import { avatar, formatDateTime, h, icon, toast } from './dom.js';
import { ChatComposer, mediaMessageContent } from './chat-composer.js';
import { WatchParty, watchableUrl } from './watch-party.js';
import { bindLongPress } from './long-press.js';

const backIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/></svg>';
const gearIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.7 7.7 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.4 11a7.7 7.7 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1l.4 2.9h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5zM12.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>';

const button = (label, action, className = 'pill-btn') => h('button', { type: 'button', class: className, onclick: action }, label);
const sectionTitle = label => h('h3', { class: 'group-section-title' }, label);
const roleName = role => ({ admin: 'Admin', co_admin: 'Co-admin', member: 'Member', owner: 'Owner' }[role] || 'Member');

export class GroupCreateSheet {
  constructor(onCreated) {
    this.onCreated = onCreated;
    this.sheet = new Sheet({ title: t('createGroup'), className: 'group-manage-sheet' });
    this.name = h('input', { class: 'field', maxlength: '70', required: true, placeholder: t('groupName'), 'aria-label': t('groupName') });
    this.caption = h('input', { class: 'field', maxlength: '120', placeholder: t('groupCaption'), 'aria-label': t('groupCaption') });
    this.avatarUrl = h('input', { class: 'field', type: 'url', placeholder: 'https://…', 'aria-label': t('groupAvatarUrl') });
    this.mode = h('select', { class: 'field', 'aria-label': t('joinMode') },
      h('option', { value: 'open' }, t('joinOpen')),
      h('option', { value: 'request_approval' }, t('joinApproval')),
      h('option', { value: 'invite_only' }, t('joinInviteOnly')));
    this.invites = h('input', { type: 'checkbox', checked: true });
    this.submit = button(t('createGroup'), () => this.#create(), 'pill-btn hot');
    this.sheet.body.append(
      h('label', { class: 'group-field' }, h('span', {}, t('groupName')), this.name),
      h('label', { class: 'group-field' }, h('span', {}, t('groupCaption')), this.caption),
      h('label', { class: 'group-field' }, h('span', {}, t('groupAvatarUrl')), this.avatarUrl),
      h('label', { class: 'group-field' }, h('span', {}, t('joinMode')), this.mode),
      h('label', { class: 'group-check' }, this.invites, h('span', {}, t('membersCanInvite'))),
      this.submit);
  }

  open() {
    this.name.value = '';
    this.caption.value = '';
    this.avatarUrl.value = '';
    this.mode.value = 'invite_only';
    this.invites.checked = true;
    this.sheet.open();
  }

  async #create() {
    const name = this.name.value.trim();
    if (!name) { this.name.focus(); return; }
    this.submit.disabled = true;
    try {
      const data = await createGroup({
        name, caption: this.caption.value.trim(), description: '', avatarUrl: this.avatarUrl.value.trim(),
        joinMode: this.mode.value, membersCanInvite: this.invites.checked,
      });
      this.sheet.close();
      this.onCreated?.(data.group);
    } catch (error) {
      toast(error?.message || t('groupActionFailed'));
    } finally { this.submit.disabled = false; }
  }
}

export class GroupChatSheet {
  constructor({ onChanged, onDeleted } = {}) {
    this.onChanged = onChanged;
    this.onDeleted = onDeleted;
    this.group = null;
    this.messages = new Map();
    this.revealed = new Map();
    this.selectedMessage = null;
    this.messageActions = new Sheet({
      title: t('messageActions'), className: 'group-manage-sheet', autoFocus: false,
      onClose: () => { this.selectedMessage = null; },
    });
    this.deleteMessageAction = button(t('deleteMessage'), () => this.#deleteSelectedMessage(), 'pill-btn danger');
    this.messageActions.body.append(this.deleteMessageAction, button(t('cancel'), () => this.messageActions.close()));
    this.sheet = new Sheet({ title: '', className: 'chat-sheet group-chat-sheet', onClose: () => { this.group = null; this.messageActions.close(); this.composer.cancelRecording(); this.watchParty.leave(); this.#clearRevealed(); } });
    this.sheet.heading.hidden = true;
    this.name = h('b', {});
    this.subtitle = h('small', { class: 'muted' });
    this.face = h('span', { class: 'group-chat-face' });
    this.list = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'polite' });
    this.composer = new ChatComposer({
      onSendText: (text, viewOnce) => this.#send(text, viewOnce),
      onSendMedia: media => this.#sendMedia(media),
    });
    this.watchParty = new WatchParty();
    this.sheet.body.append(
      h('header', { class: 'chat-head' },
        h('button', { class: 'icon-btn chat-call', type: 'button', 'aria-label': t('back'), html: backIcon, onclick: () => this.sheet.close() }),
        this.face, h('div', { class: 'chat-who' }, this.name, this.subtitle),
        h('button', { class: 'icon-btn chat-call', type: 'button', 'aria-label': t('watchTogether'), title: t('watchTogether'), html: icon.play, onclick: () => this.watchParty.openPanel() }),
        h('button', { class: 'icon-btn chat-call', type: 'button', 'aria-label': t('groupManage'), html: gearIcon, onclick: () => this.manager.open(this.group) })),
      this.watchParty.root, this.list, this.composer.form);
    this.manager = new GroupManager({
        onChanged: this.onChanged,
        onDeleted: this.onDeleted,
        onLeave: () => this.sheet.close(),
        onClearMessages: groupId => this.#clearMessages(groupId),
    });
    onGroupMessage(event => this.#live(event));
  }

  async open(group) {
    if (!group?.id) return;
    this.messageActions.close();
    this.composer.cancelRecording();
    this.watchParty.join('group', group.id).catch(error => toast(error?.message || t('watchConnectFailed')));
    this.#clearRevealed();
    this.group = group;
    this.messages.clear();
    this.name.textContent = group.name || t('groupChat');
    this.subtitle.textContent = '';
    this.face.replaceChildren(group.avatar_url
      ? h('img', { src: group.avatar_url, alt: '', loading: 'lazy' })
      : h('span', {}, '👥'));
    this.list.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.open();
    const groupId = group.id;
    try {
      const [details, rows] = await Promise.all([loadGroup(groupId), loadGroupMessages(groupId)]);
      if (this.group?.id !== groupId) return;
      this.group = { ...group, ...details.group };
      const activeMembers = (details.members || []).filter(member => isActiveGroupMember(member, { createdBy: this.group.created_by }));
      await profiles.many(activeMembers.map(member => member.user_id));
      this.subtitle.textContent = `${activeMembers.length} ${t('groupMembers').toLowerCase()}`;
      this.messages.clear();
      rows.forEach(row => this.messages.set(row.id, row));
      this.#render();
    } catch (error) {
      if (this.group?.id === groupId) this.list.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    }
  }

  #render() {
    const rows = [...this.messages.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!rows.length) { this.list.replaceChildren(h('p', { class: 'muted center msg-empty' }, t('groupSayHello'))); return; }
    this.list.replaceChildren(...rows.map(row => {
      const mine = row.sender_id === auth.userId;
      const profile = profiles.peek(row.sender_id);
      const revealed = this.revealed.get(row.id);
      const content = revealed
        ? mediaMessageContent({ ...row, ...revealed, view_once: false })
        : mediaMessageContent(row, { mine, onViewOnce: row.view_once && !mine ? () => this.#viewOnce(row) : undefined });
      const sharedUrl = watchableUrl(row.body)
        || (row.message_type !== 'video_note' && (row.message_type === 'video' || row.media_type?.startsWith('video/'))
          ? watchableUrl(row.media_url) : '');
      const bubble = h('div', { class: `msg${mine ? ' mine' : ''}`, 'data-id': row.id },
        !mine ? h('small', { class: 'group-message-sender' }, profile?.name || 'MilkyWay') : null,
        content,
        sharedUrl ? h('button', { class: 'pill-btn watch-message-action', type: 'button', onclick: () => this.watchParty.startFromLink(sharedUrl) }, t('watchTogether')) : null,
        h('small', {}, formatDateTime(row.created_at, { hour: '2-digit', minute: '2-digit' }), row.edited_at ? ` · ${t('edited')}` : ''));
      if (this.#canDeleteMessage(row)) bindLongPress(bubble, () => this.#openMessageActions(row));
      return bubble;
    }));
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  async #viewOnce(row) {
    try {
      const viewed = await consumeViewOnce(row.id, this.group?.id);
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

  #canDeleteMessage(row) {
    return (!row.groupId || row.groupId === this.group?.id) && (row.sender_id === auth.userId
      || this.group?.created_by === auth.userId
      || ['admin', 'co_admin', 'owner'].includes(String(this.group?.role || '').toLowerCase()));
  }

  #openMessageActions(row) {
    if (!this.#canDeleteMessage(row) || !this.messages.has(row.id)) return;
    this.selectedMessage = { ...row, groupId: this.group?.id };
    this.messageActions.open();
  }

  async #deleteSelectedMessage() {
    const selected = this.selectedMessage;
    if (!selected || !this.#canDeleteMessage(selected)) return;
    if (!confirm(`${t('deleteMessage')}?`)) return;
    const groupId = selected.groupId;
    const current = this.group?.id === groupId ? this.messages.get(selected.id) : null;
    if (!current) { this.messageActions.close(); return; }
    this.messages.delete(selected.id);
    this.#clearRevealedMessage(selected.id);
    this.#render();
    this.messageActions.close();
    try {
      await deleteGroupMessage(groupId, selected.id);
    } catch (error) {
      if (this.group?.id === groupId) {
        this.messages.set(selected.id, current);
        this.#render();
      }
      toast(error?.message || t('groupActionFailed'));
    }
  }

  #clearRevealedMessage(id) {
    const media = this.revealed.get(id);
    if (media?.media_url?.startsWith('blob:')) URL.revokeObjectURL(media.media_url);
    this.revealed.delete(id);
  }

  async #clearMessages(groupId) {
    if (this.group?.id !== groupId) return;
    const previous = new Map(this.messages);
    this.messages.clear();
    this.#clearRevealed();
    this.#render();
    try {
      await clearGroupMessages(groupId);
    } catch (error) {
      if (this.group?.id === groupId) {
        this.messages = previous;
        this.#render();
      }
      throw error;
    }
  }

  async #send(text, viewOnce = false) {
    const groupId = this.group?.id;
    if (!text || !groupId) return;
    const temp = {
      id: `tmp-${Date.now()}`, group_id: groupId, sender_id: auth.userId,
      body: viewOnce ? 'View-once message' : text, view_once: viewOnce,
      created_at: new Date().toISOString(), pending: true,
    };
    this.messages.set(temp.id, temp);
    this.#render();
    try {
      const result = viewOnce ? await sendGroupOneViewText(groupId, text) : await sendGroupMessage(groupId, text);
      this.messages.delete(temp.id);
      const message = result?.message || result;
      if (message?.id) this.messages.set(message.id, message);
    } catch (error) {
      this.messages.delete(temp.id);
      toast(error?.message || t('messageFailed'));
    }
    if (this.group?.id === groupId) this.#render();
  }

  async #sendMedia(media) {
    const groupId = this.group?.id;
    if (!groupId) return;
    const result = await sendGroupMedia(groupId, media);
    const message = result?.message || result;
    if (this.group?.id === groupId && message?.id) {
      this.messages.set(message.id, message);
      this.#render();
    }
  }

  #live({ type, message }) {
    if (!this.group || message?.group_id !== this.group.id) return;
    if (type === 'DELETE') {
      if (this.revealed.has(message.id)) return;
      this.messages.delete(message.id);
    }
    else {
      if (type === 'INSERT' && message.sender_id === auth.userId) {
        for (const [id, row] of this.messages) if (row.pending && row.body === message.body) this.messages.delete(id);
      }
      this.messages.set(message.id, message);
    }
    this.#render();
  }
}

class GroupManager {
  constructor({ onChanged, onDeleted, onLeave, onClearMessages }) {
    this.onChanged = onChanged;
    this.onDeleted = onDeleted;
    this.onLeave = onLeave;
    this.onClearMessages = onClearMessages;
    this.group = null;
    this.sheet = new Sheet({ title: t('groupManage'), className: 'group-manage-sheet' });
    this.content = h('div', { class: 'group-management' });
    this.sheet.body.append(this.content);
  }

  async open(group) {
    if (!group?.id) return;
    this.group = group;
    this.content.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    this.sheet.open();
    try {
      const data = await loadGroup(group.id);
      if (this.group?.id !== group.id) return;
      this.group = { ...group, ...data.group };
      const profilesById = await profiles.many((data.members || []).map(member => member.user_id));
      this.#render(data, profilesById);
    } catch (error) {
      this.content.replaceChildren(h('p', { class: 'muted center' }, error?.message || t('retry')));
    }
  }

  #render(data, profileMap) {
    const group = this.group;
    const elevated = ['admin', 'co_admin', 'owner'].includes(group.role);
    const creator = group.created_by === auth.userId;
    const active = data.members.filter(member => isActiveGroupMember(member, { createdBy: group.created_by }));
    const activeIds = new Set(active.map(member => member.user_id));
    const pending = data.members.filter(member => member.join_status === 'pending' && !activeIds.has(member.user_id));
    const canDelete = creator || ['admin', 'co_admin', 'owner'].includes(group.role);
    const members = h('div', { class: 'group-member-list' });
    for (const member of active) {
      const person = profileMap.get(member.user_id) || { name: 'MilkyWay', username: '', avatar: '' };
      const actions = h('span', { class: 'group-member-actions' });
      if (creator && member.user_id !== auth.userId) {
        actions.append(button(member.role === 'co_admin' ? t('removeCoAdmin') : t('makeCoAdmin'), () => this.#role(member.user_id, member.role === 'co_admin' ? 'member' : 'co_admin')));
      }
      if (elevated && member.user_id !== auth.userId && member.user_id !== group.created_by && member.role === 'member') {
        actions.append(button(t('removeMember'), () => this.#remove(member.user_id, false)));
        actions.append(button(t('banMember'), () => this.#remove(member.user_id, true)));
      }
      members.append(h('div', { class: 'group-member-row' },
        avatar(person, 34),
        h('span', { class: 'group-member-name' }, person.name || 'MilkyWay'),
        h('small', { class: 'muted' }, roleName(member.role)),
        actions));
    }

    const pendingList = h('div', { class: 'group-member-list' });
    for (const member of pending) {
      const person = profileMap.get(member.user_id) || { name: 'MilkyWay' };
      pendingList.append(h('div', { class: 'group-member-row' },
        h('span', { class: 'group-member-name' }, person.name || 'MilkyWay'),
        button(t('approve'), () => this.#decide(member.user_id, true), 'pill-btn hot'),
        button(t('reject'), () => this.#decide(member.user_id, false))));
    }

    this.content.replaceChildren(
      h('p', { class: 'group-meta' }, `${active.length} ${t('groupMembers').toLowerCase()} · ${t(`joinModeLabel_${group.join_mode}`)}`),
      creator ? this.#settingsForm(group) : null,
      (elevated || group.members_can_invite) ? this.#inviteForm() : null,
      sectionTitle(t('groupMembers')), members,
      elevated ? sectionTitle(`${t('joinRequests')} (${pending.length})`) : null,
      elevated ? (pending.length ? pendingList : h('p', { class: 'muted' }, t('noJoinRequests'))) : null,
      elevated ? h('section', { class: 'group-message-management' },
        sectionTitle(t('messageManagement')),
        button(t('clearGroupMessages'), () => this.#clearMessages(), 'pill-btn danger')) : null,
      canDelete ? button(t('deleteGroup'), () => this.#delete(), 'pill-btn danger') : null,
      button(t('leaveGroup'), () => this.#leave(), 'pill-btn'));
  }

  #settingsForm(group) {
    const name = h('input', { class: 'field', maxlength: '70', value: group.name, 'aria-label': t('groupName') });
    const caption = h('input', { class: 'field', maxlength: '120', value: group.caption || '', 'aria-label': t('groupCaption') });
    const avatarUrl = h('input', { class: 'field', type: 'url', value: group.avatar_url || '', placeholder: 'https://…', 'aria-label': t('groupAvatarUrl') });
    const mode = h('select', { class: 'field', 'aria-label': t('joinMode') },
      h('option', { value: 'open' }, t('joinOpen')),
      h('option', { value: 'request_approval' }, t('joinApproval')),
      h('option', { value: 'invite_only' }, t('joinInviteOnly')));
    mode.value = group.join_mode;
    const canInvite = h('input', { type: 'checkbox', checked: group.members_can_invite });
    const save = button(t('save'), async () => {
      save.disabled = true;
      try {
        await updateGroup({
          group: group.id, name: name.value.trim(), caption: caption.value.trim(),
          description: group.description || '', avatarUrl: avatarUrl.value.trim(),
          joinMode: mode.value, membersCanInvite: canInvite.checked,
        });
        toast(t('settingsSaved'));
        this.onChanged?.();
        await this.open(this.group);
      } catch (error) { toast(error?.message || t('groupActionFailed')); }
      finally { save.disabled = false; }
    }, 'pill-btn hot');
    return h('section', { class: 'group-settings' },
      sectionTitle(t('groupSettings')),
      h('label', { class: 'group-field' }, h('span', {}, t('groupName')), name),
      h('label', { class: 'group-field' }, h('span', {}, t('groupCaption')), caption),
      h('label', { class: 'group-field' }, h('span', {}, t('groupAvatarUrl')), avatarUrl),
      h('label', { class: 'group-field' }, h('span', {}, t('joinMode')), mode),
      h('label', { class: 'group-check' }, canInvite, h('span', {}, t('membersCanInvite'))),
      save);
  }

  #inviteForm() {
    const input = h('input', { class: 'field', type: 'search', placeholder: t('searchPeople'), autocomplete: 'off' });
    const results = h('div', { class: 'group-search-results' });
    let timer = 0, token = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const searchId = ++token;
        const query = input.value.trim();
        if (query.replace(/^@/, '').length < 2) { results.replaceChildren(); return; }
        try {
          const people = await searchPeople(query);
          if (searchId !== token) return;
          profiles.prime(people);
          results.replaceChildren(...people.map(person => h('button', {
            class: 'group-search-person', type: 'button',
            onclick: async () => {
              try {
                await addGroupMembers(this.group.id, [person.id]);
                toast(t('memberInvited'));
                input.value = ''; results.replaceChildren();
                this.onChanged?.(); await this.open(this.group);
              } catch (error) { toast(error?.message || t('groupActionFailed')); }
            },
          }, avatar(person, 30), h('span', {}, person.name), person.username ? h('small', { class: 'muted' }, `@${person.username}`) : null)));
        } catch (error) { if (searchId === token) results.replaceChildren(h('p', { class: 'muted' }, error?.message || t('retry'))); }
      }, 250);
    });
    return h('section', { class: 'group-invite' }, sectionTitle(t('inviteMembers')), input, results);
  }

  async #role(userId, role) {
    try {
      await setGroupRole(this.group.id, userId, role);
      this.onChanged?.(); await this.open(this.group);
    } catch (error) { toast(error?.message || t('groupActionFailed')); }
  }

  async #remove(userId, block) {
    if (!confirm(`${block ? t('banMember') : t('removeMember')}?`)) return;
    try {
      await removeGroupMember(this.group.id, userId, block);
      this.onChanged?.(); await this.open(this.group);
    } catch (error) { toast(error?.message || t('groupActionFailed')); }
  }

  async #decide(userId, approve) {
    try {
      await decideGroupRequest(this.group.id, userId, approve);
      this.onChanged?.(); await this.open(this.group);
    } catch (error) { toast(error?.message || t('groupActionFailed')); }
  }

  async #leave() {
    if (!confirm(`${t('leaveGroup')}?`)) return;
    try {
      await leaveGroup(this.group.id);
      this.sheet.close();
      this.onChanged?.();
      this.onLeave?.();
      toast(t('leftGroup'));
    } catch (error) { toast(error?.message || t('groupActionFailed')); }
  }

  async #delete() {
    if (!confirm(`${t('deleteGroup')}?`)) return;
    const groupId = this.group.id;
    this.onDeleted?.(groupId);
    try {
      await deleteGroup(groupId);
      this.sheet.close();
      this.onChanged?.();
      this.onLeave?.();
      toast(t('groupDeleted'));
    } catch (error) {
      this.onChanged?.();
      toast(error?.message || t('groupActionFailed'));
    }
  }

  async #clearMessages() {
    if (!confirm(`${t('clearGroupMessages')}?`)) return;
    try {
      await this.onClearMessages?.(this.group.id);
      toast(t('messagesCleared'));
    } catch (error) { toast(error?.message || t('groupActionFailed')); }
  }
}

export async function joinAndOpenGroup(group, onJoined, onPending) {
  try {
    const result = await joinGroup(group.id);
    if (['active', 'approved'].includes(String(result.status || '').toLowerCase())) onJoined?.(group);
    else onPending?.();
  } catch (error) { toast(error?.message || t('groupActionFailed')); }
}
