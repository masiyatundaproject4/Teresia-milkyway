import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { enableNotifications, notificationPermission } from '../core/push.js';
import { playMessageAlert } from '../core/notification-sound.js';
import { api } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, ago, toast } from './dom.js';

const icons = { live: '🔴', post: '✦', message: '✉', group: '👥', call: '☎' };

export class NotificationsView {
  constructor({ onOpenLive, onOpenMessage, onOpenGroup, onOpenCall, onOpenPost } = {}) {
    this.onOpenLive = onOpenLive;
    this.onOpenMessage = onOpenMessage;
    this.onOpenGroup = onOpenGroup;
    this.onOpenCall = onOpenCall;
    this.onOpenPost = onOpenPost;
    this.onUnread = null;
    this.onDmUnread = null;
    this.alerts = [];
    this.sheet = new Sheet({ title: t('notifications'), className: 'notifications-sheet', autoFocus: false });
    this.body = h('div', { class: 'stack notifications-list' });
    this.sheet.body.append(this.body);
  }

  open() {
    this.sheet.open();
    void this.refresh();
  }

  preload() {
    void this.refresh();
  }

  refresh() {
    return this.#load();
  }

  async #load() {
    const token = (this.loadToken || 0) + 1;
    this.loadToken = token;
    const hadLoaded = this.loaded;
    if (!hadLoaded) {
      this.loaded = false;
      this.body.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    }
    const permissionRow = h('button', {
      class: 'nova-row',
      type: 'button',
      onclick: async () => {
        permissionRow.disabled = true;
        try {
          const permission = await enableNotifications();
          permissionRow.querySelector('.nova-row-detail').textContent = t(`notificationPermission_${permission}`);
        } catch (error) {
          permissionRow.querySelector('.nova-row-detail').textContent = error?.message || t('notificationSetupFailed');
          console.warn('[notifications] Permission setup failed.', error);
        } finally {
          permissionRow.disabled = false;
        }
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '🔔'),
    h('span', { class: 'nova-row-label' }, t('enableNotifications')),
    h('small', { class: 'muted nova-row-detail' }, t('loading')));
    const testSound = h('button', {
      class: 'nova-row',
      type: 'button',
      onclick: async () => {
        const played = await playMessageAlert();
        toast(played ? t('messageSoundTested') : t('soundTestBlocked'));
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '🔊'),
    h('span', { class: 'nova-row-label' }, t('testMessageSound')),
    h('small', { class: 'muted nova-row-detail' }, t('soundTestHint')));
    try {
      permissionRow.querySelector('.nova-row-detail').textContent = t(`notificationPermission_${await notificationPermission()}`);
    } catch (error) {
      permissionRow.querySelector('.nova-row-detail').textContent = error?.message || t('notificationSetupFailed');
      console.warn('[notifications] Permission status could not be read.', error);
    }

    try {
      const result = await api(`${config.api.base}/milkyway-notifications?action=alerts`, { timeout: 15000 });
      if (token !== this.loadToken) return;
      this.alerts = Array.isArray(result?.alerts) ? result.alerts : [];
      this.onUnread?.(Number(result?.unread) || 0);
      this.onDmUnread?.(Number(result?.dmUnread?.total) || 0);
    } catch (error) {
      if (token !== this.loadToken) return;
      if (hadLoaded) console.warn('[notifications] Could not refresh activity.', error);
      else this.body.replaceChildren(permissionRow, testSound, h('p', { class: 'muted center', role: 'status' }, error?.message || t('retry')));
      return;
    }

    this.permissionRow = permissionRow;
    this.testSound = testSound;
    this.loaded = true;
    this.#render();
  }

  async #markRead(alert) {
    const body = {};
    if (alert.type === 'live') body.rooms = [alert.room];
    if (alert.type === 'post') body.postIds = [alert.notificationId];
    if (alert.type === 'call') body.callIds = [alert.callId];
    if (!Object.keys(body).length) return;
    try {
      await api(`${config.api.base}/milkyway-notifications?action=read`, {
        method: 'POST', body, timeout: 10000,
      });
      alert.read = true;
      void this.refresh();
    } catch (error) {
      console.warn('[notifications] Could not mark notification as read.', error);
      toast(error?.message || t('retry'));
    }
  }

  #open(alert) {
    this.sheet.close();
    if (!alert.read) void this.#markRead(alert);
    if (alert.type === 'live') this.onOpenLive?.(alert.room);
    else if (alert.type === 'post') this.onOpenPost?.(alert.postId);
    else if (alert.type === 'message') this.onOpenMessage?.(alert.peerId);
    else if (alert.type === 'group') this.onOpenGroup?.(alert.groupId);
    else if (alert.type === 'call') this.onOpenCall?.(alert.callId, alert.status, alert.callerId);
  }

  #render() {
    if (!this.loaded) return;
    const items = this.alerts.map(alert => {
      const title = alert.type === 'call'
        ? `${alert.title} · ${t(alert.status === 'incoming' ? 'incomingCall' : 'missedCall')}`
        : alert.type === 'message'
          ? `${alert.title} · ${alert.count} ${t('unreadMessages')}`
          : alert.type === 'group'
            ? `${alert.title} · ${alert.count} ${t('unreadMessages')}`
            : alert.type === 'post'
              ? `${alert.title} · ${t('publishedNewPost')}`
              : alert.title || `${alert.hostName || 'MilkyWay'} · ${t('live')}`;
      const detail = alert.type === 'post' ? alert.caption
        : alert.type === 'message' ? t('inbox')
          : alert.type === 'group' ? t('groupChat')
            : alert.type === 'call' ? alert.status === 'incoming' ? t('incomingCall') : t('missedCall')
              : ago(alert.createdAt);
      return h('button', {
        class: `nova-row notification-item${alert.read ? '' : ' unread'}`,
        type: 'button',
        onclick: () => this.#open(alert),
      },
      h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, icons[alert.type] || '•'),
      h('span', { class: 'nova-row-label' }, title),
      h('small', { class: 'muted nova-row-detail' }, detail || ago(alert.createdAt)));
    });
    this.body.replaceChildren(
      this.permissionRow,
      this.testSound,
      h('p', { class: 'nova-section' }, t('recentNotifications')),
      ...(items.length ? items : [h('p', { class: 'muted center', role: 'status' }, t('noNotifications'))]),
    );
  }
}
