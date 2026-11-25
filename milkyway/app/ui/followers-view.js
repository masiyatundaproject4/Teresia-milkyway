import { auth, supabase } from '../core/net.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { t } from '../core/i18n.js';
import { profiles } from '../data/profiles.js';
import { loadSuggestions } from '../data/promoted.js';
import { actions } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { avatar, h, icon, toast } from './dom.js';

const displayText = value => typeof value === 'string'
  ? value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '').replace(/\b(?:null|undefined)\b/gi, '').replace(/\s+/g, ' ').trim()
  : '';

const safePerson = row => ({
  id: String(row?.id || ''),
  name: displayText(row?.display_name || row?.name) || displayText(row?.username) || 'MilkyWay',
  username: displayText(row?.username).replace(/^@/, ''),
  avatar: typeof row?.avatar_url === 'string' && !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(row.avatar_url)
    ? row.avatar_url : displayText(row?.avatar),
  private: Boolean(row?.is_private ?? row?.private),
});

export class FollowersView {
  constructor({ openProfile, openLive, requireLogin }) {
    this.openProfile = openProfile;
    this.openLive = openLive;
    this.requireLogin = requireLogin;
    this.sheet = new Sheet({ title: t('connections'), className: 'connections-sheet', autoFocus: false });
    this.mode = 'connections';
    this.tab = 'followers';
    this.person = null;
    this.people = [];
    this.liveRooms = new Map();
    this.searchTerm = '';
    this.sort = 'recent';
    this.manage = false;
    this.dismissed = new Set();
    this.token = 0;
    this.#build();
    bus.on('follow', () => {
      if (this.sheet.isOpen && this.mode === 'connections') this.#renderRows();
    });
  }

  #build() {
    this.back = h('button', {
      class: 'connections-icon-btn', type: 'button', 'aria-label': t('back'), title: t('back'),
      onclick: () => this.sheet.close(),
    }, '‹');
    this.title = h('h2', { class: 'connections-title' }, t('connections'));
    this.activityButton = h('button', {
      class: 'connections-icon-btn', type: 'button', 'aria-label': t('activity'), title: t('activity'),
      onclick: () => { this.mode = this.mode === 'activity' ? 'connections' : 'activity'; this.#render(); },
    }, '◷');
    this.addButton = h('button', {
      class: 'connections-icon-btn', type: 'button', 'aria-label': t('suggestedAccounts'), title: t('suggestedAccounts'),
      onclick: () => { this.mode = 'connections'; this.#selectTab('suggested'); },
    }, h('span', { html: icon.plus }));
    this.header = h('header', { class: 'connections-header', 'data-no-swipe': true },
      this.back, this.title, h('div', { class: 'connections-header-actions' }, this.activityButton, this.addButton));

    this.tabs = h('div', { class: 'connections-tabs', role: 'tablist', 'aria-label': t('connections'), 'data-no-swipe': true },
      ...['following', 'followers', 'friends', 'suggested'].map(key => h('button', {
        type: 'button', role: 'tab', 'data-connections-tab': key, 'aria-selected': 'false',
        onclick: () => this.#selectTab(key),
      }, t(key === 'following' ? 'following' : key === 'followers' ? 'followers' : key === 'friends' ? 'friends' : 'suggested'))));
    this.search = h('input', {
      class: 'field connections-search', type: 'search', placeholder: t('searchConnections'),
      'aria-label': t('searchConnections'), autocomplete: 'off', 'data-no-swipe': true,
    });
    this.search.addEventListener('input', () => { this.searchTerm = this.search.value.trim().toLocaleLowerCase(); this.#renderRows(); });
    const sortOptions = [
      ['recent', t('sortRecent')],
      ['name', t('sortName')],
      ['live', t('sortLive')],
    ];
    this.sortMenu = h('div', {
      class: 'connections-sort-menu', role: 'menu',
      'aria-label': t('sortConnections'), 'data-no-swipe': true, hidden: true,
    }, ...sortOptions.map(([value, label]) => h('button', {
      class: 'connections-sort-option', type: 'button', role: 'menuitemradio',
      'aria-checked': String(this.sort === value), 'data-sort-value': value,
      onclick: () => {
        this.sort = value;
        this.sortButton.replaceChildren(h('span', {}, label), h('span', { class: 'connections-sort-chevron', 'aria-hidden': 'true' }, '⌄'));
        this.sortMenu.hidden = true;
        this.sortButton.setAttribute('aria-expanded', 'false');
        for (const option of this.sortMenu.querySelectorAll('[data-sort-value]')) {
          option.setAttribute('aria-checked', String(option.dataset.sortValue === value));
        }
        this.#renderRows();
      },
    }, h('span', {}, label), h('span', { class: 'connections-sort-check', 'aria-hidden': 'true' }, '✓'))));
    this.sortMenu.id = `connectionsSortMenu-${Math.random().toString(36).slice(2)}`;
    this.sortButton = h('button', {
      class: 'connections-sort', type: 'button', 'aria-label': t('sortConnections'),
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': this.sortMenu.id,
      'data-no-swipe': true,
      onclick: () => {
        this.sortMenu.hidden = !this.sortMenu.hidden;
        this.sortButton.setAttribute('aria-expanded', String(!this.sortMenu.hidden));
      },
    }, h('span', {}, t('sortRecent')), h('span', { class: 'connections-sort-chevron', 'aria-hidden': 'true' }, '⌄'));
    this.sortPicker = h('div', { class: 'connections-sort-wrap', 'data-no-swipe': true }, this.sortButton, this.sortMenu);
    this.manageButton = h('button', {
      class: 'connections-manage', type: 'button', 'aria-pressed': 'false', 'data-no-swipe': true,
      onclick: () => {
        this.manage = !this.manage;
        this.manageButton.setAttribute('aria-pressed', String(this.manage));
        this.manageButton.textContent = t(this.manage ? 'done' : 'manage');
        this.sheet.panel.toggleAttribute('data-manage', this.manage);
        this.#renderRows();
      },
    }, t('manage'));
    this.controls = h('div', { class: 'connections-controls', 'data-no-swipe': true }, this.sortPicker, this.manageButton);
    this.toolbar = h('div', { class: 'connections-tools', 'data-no-swipe': true }, this.search, this.controls);
    this.content = h('div', { class: 'connections-content', 'data-no-swipe': true });
    this.sheet.body.replaceChildren(this.header, this.tabs, this.toolbar, this.content);
  }

  async open(profile, { tab = 'followers', mode = 'connections' } = {}) {
    if (!profile?.id) return;
    const token = this.token = (this.token || 0) + 1;
    this.person = { ...safePerson(profile), id: String(profile.id) };
    this.own = this.person.id === String(auth.userId || '');
    this.mode = mode === 'activity' && this.own ? 'activity' : 'connections';
    this.tab = ['following', 'followers', 'friends', 'suggested'].includes(tab) ? tab : 'followers';
    this.search.value = '';
    this.searchTerm = '';
    this.manage = false;
    try {
      const key = `mw_connections_dismissed_${auth.userId || 'guest'}`;
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      this.dismissed = new Set(Array.isArray(saved) ? saved.map(String) : []);
    } catch { this.dismissed = new Set(); }
    this.sheet.panel.removeAttribute('data-manage');
    this.manageButton.setAttribute('aria-pressed', 'false');
    this.manageButton.textContent = t('manage');
    this.sheet.title = t('connections');
    this.title.textContent = t('connections');
    this.content.replaceChildren(h('p', { class: 'muted center', role: 'status' }, t('loading')));
    this.sheet.open();
    await this.#load(token);
  }

  #selectTab(tab) {
    this.tab = tab;
    this.mode = 'connections';
    this.search.value = '';
    this.searchTerm = '';
    for (const button of this.tabs.querySelectorAll('[data-connections-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.connectionsTab === tab));
    }
    this.#render();
  }

  async #load(token) {
    let cached = false;
    const cacheKey = `connections:${auth.userId || 'guest'}:${this.person?.id || ''}`;
    const saved = await store.get(cacheKey);
    if (token !== this.token) return;
    if (saved && Array.isArray(saved.people)) {
      this.followingIds = saved.followingIds || [];
      this.followerIds = saved.followerIds || [];
      this.followDates = new Map(saved.followDates || []);
      this.people = saved.people;
      this.peopleById = new Map(saved.people.map(person => [String(person.id), person]));
      this.liveRooms = new Map(saved.liveRooms || []);
      this.newPosts = new Map(saved.newPosts || []);
      this.requests = saved.requests || [];
      profiles.prime(saved.people);
      this.#render();
      cached = true;
    }
    try {
      const sb = await supabase();
      if (auth.signedIn()) {
        const { data: outgoing, error: outgoingError } = await sb.from('mw_follow_requests')
          .select('target_id').eq('requester_id', auth.userId).limit(500);
        if (outgoingError) throw outgoingError;
        (outgoing || []).forEach(row => profiles.setRequested(row.target_id, true));
      }
      const readEdges = async (column, ownerColumn) => {
        let result = await sb.from('mw_follows').select(`${column},created_at`)
          .eq(ownerColumn, this.person.id).order('created_at', { ascending: false }).limit(2000);
        if (result.error) {
          const schemaMismatch = ['PGRST204', '42703'].includes(String(result.error.code || ''))
            || /created_at.*(column|schema cache)|column.*created_at/i.test(String(result.error.message || ''));
          if (!schemaMismatch) throw result.error;
          console.warn('[connections] Follow timestamps are unavailable; recent ordering is limited.', result.error);
          result = await sb.from('mw_follows').select(column).eq(ownerColumn, this.person.id).limit(2000);
          if (result.error) throw result.error;
        }
        return result.data || [];
      };
      const [followingRows, followerRows] = await Promise.all([
        readEdges('following_id', 'follower_id'),
        readEdges('follower_id', 'following_id'),
      ]);
      if (token !== this.token) return;

      this.followingIds = [...new Set(followingRows.map(row => String(row.following_id || '')).filter(Boolean))];
      this.followerIds = [...new Set(followerRows.map(row => String(row.follower_id || '')).filter(Boolean))];
      const dateEntries = [
        ...followingRows.map(row => [String(row.following_id || ''), Date.parse(row.created_at || '')]),
        ...followerRows.map(row => [String(row.follower_id || ''), Date.parse(row.created_at || '')]),
      ].filter(([id, date]) => id && Number.isFinite(date));
      this.followDates = new Map(dateEntries);
      const ids = [...new Set([...this.followingIds, ...this.followerIds])];
      const { data: rows, error } = ids.length
        ? await sb.from('mw_profiles').select('id,display_name,username,avatar_url,is_private').in('id', ids)
        : { data: [], error: null };
      if (error) throw error;
      const peopleById = new Map((rows || []).map(row => [String(row.id), safePerson(row)]));
      this.peopleById = peopleById;
      const people = ids.map(id => peopleById.get(id) || profiles.peek(id)).filter(Boolean);
      profiles.prime(people);

      const liveResult = ids.length
        ? await sb.from('mw_video_live_sessions').select('host_id,room_name').eq('is_live', true).in('host_id', ids).limit(100)
        : { data: [], error: null };
      if (liveResult.error) console.warn('[connections] Could not load live status.', liveResult.error);
      this.liveRooms = new Map((liveResult.data || []).map(row => [String(row.host_id), String(row.room_name || '')]).filter(([, room]) => room));

      const countsResult = ids.length
        ? await sb.from('mw_posts').select('author_id').in('author_id', ids).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).limit(2000)
        : { data: [], error: null };
      if (countsResult.error) console.warn('[connections] Could not load recent post counts.', countsResult.error);
      this.newPosts = new Map();
      for (const row of countsResult.data || []) {
        const authorId = String(row.author_id || '');
        if (authorId) this.newPosts.set(authorId, (this.newPosts.get(authorId) || 0) + 1);
      }

      if (this.own) {
        const requestResult = await sb.from('mw_follow_requests').select('requester_id,created_at').eq('target_id', auth.userId).order('created_at', { ascending: false }).limit(200);
        if (requestResult.error) throw requestResult.error;
        this.requests = requestResult.data || [];
        const requestIds = this.requests.map(row => String(row.requester_id || '')).filter(Boolean);
        if (requestIds.length) {
          const { data: requestProfiles, error: requestProfileError } = await sb.from('mw_profiles')
            .select('id,display_name,username,avatar_url,is_private').in('id', requestIds);
          if (requestProfileError) throw requestProfileError;
          for (const row of requestProfiles || []) peopleById.set(String(row.id), safePerson(row));
        }
      } else {
        this.requests = [];
      }
      if (token !== this.token) return;
      this.people = people;
      this.#render();
      store.set(cacheKey, {
        followingIds: this.followingIds,
        followerIds: this.followerIds,
        followDates: [...this.followDates],
        people: [...peopleById.values()],
        liveRooms: [...this.liveRooms],
        newPosts: [...this.newPosts],
        requests: this.requests,
      });
    } catch (error) {
      if (token !== this.token) return;
      console.error('[connections] Could not load connections.', error);
      if (!cached) {
        this.content.replaceChildren(h('div', { class: 'connections-error', role: 'status' },
          h('b', {}, t('connectionLost')), h('span', {}, t('retry'))));
      }
    }
  }

  refresh() {
    if (!this.sheet.isOpen || !this.person) return Promise.resolve();
    return this.#load(this.token);
  }

  async #loadSuggested(token) {
    this.content.replaceChildren(h('p', { class: 'muted center', role: 'status' }, t('loading')));
    let suggestions;
    try {
      suggestions = await loadSuggestions();
    } catch (error) {
      if (token !== this.token) return;
      console.error('[connections] Suggested accounts could not be loaded.', error);
      this.suggestions = [];
      if (this.mode === 'activity') this.#renderActivity();
      else this.content.replaceChildren(h('p', { class: 'muted center', role: 'status' }, t('retry')));
      return;
    }
    if (token !== this.token) return;
    this.suggestions = suggestions.filter(person => person?.id && String(person.id) !== String(auth.userId || '')
      && !profiles.isFollowing(person.id) && !profiles.isRequested(person.id) && !this.dismissed.has(String(person.id)));
    this.suggestionPreviews = new Map();
    const ids = this.suggestions.slice(0, 20).map(person => String(person.id));
    if (ids.length) {
      try {
        const sb = await supabase();
        const { data, error } = await sb.from('mw_posts')
          .select('author_id,media_url,media_type').in('author_id', ids).not('media_url', 'is', null)
          .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        for (const post of data || []) {
          const id = String(post.author_id || '');
          const list = this.suggestionPreviews.get(id) || [];
          if (list.length < 3 && typeof post.media_url === 'string' && post.media_url) {
            list.push({ url: post.media_url, video: post.media_type === 'video' });
            this.suggestionPreviews.set(id, list);
          }
        }
      } catch (error) {
        console.warn('[connections] Suggested account previews could not be loaded.', error);
      }
    }
    if (token === this.token) {
      if (this.mode === 'activity') this.#renderActivity();
      else this.#renderRows();
    }
  }

  #render() {
    if (!this.person) return;
    this.title.textContent = this.mode === 'activity' ? t('activity') : t('connections');
    this.tabs.hidden = this.mode === 'activity';
    this.toolbar.hidden = this.mode === 'activity';
    this.activityButton.setAttribute('aria-pressed', String(this.mode === 'activity'));
    if (this.mode === 'activity') {
      this.#renderActivity();
      return;
    }
    for (const button of this.tabs.querySelectorAll('[data-connections-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.connectionsTab === this.tab));
    }
    if (this.tab === 'suggested') {
      const token = this.token;
      if (!this.suggestions) void this.#loadSuggested(token);
      else this.#renderRows();
      return;
    }
    this.#renderRows();
  }

  #renderActivity() {
    if (!this.own) {
      this.content.replaceChildren(h('p', { class: 'muted center' }, t('activityUnavailable')));
      return;
    }
    const requestRows = (this.requests || []).map(request => {
      const person = this.peopleById?.get(String(request.requester_id)) || { id: String(request.requester_id), name: 'MilkyWay' };
      const accept = h('button', {
        class: 'connection-action hot', type: 'button', onclick: async event => {
          event.stopPropagation();
          accept.disabled = true;
          try {
            const sb = await supabase();
            const { error } = await sb.rpc('mw_accept_follow_request', { requester: person.id });
            if (error) throw error;
            profiles.setFollowing(person.id, true);
            profiles.setRequested(person.id, false);
            toast(t('followRequestAccepted'));
            this.suggestions = null;
            await this.#load(this.token);
          } catch (error) {
            console.error('[connections] Could not accept follow request.', error);
            toast(t('retry'));
            accept.disabled = false;
          }
        },
      }, t('accept'));
      const dismiss = h('button', {
        class: 'connection-dismiss', type: 'button', 'aria-label': t('dismiss'), title: t('dismiss'),
        onclick: async event => {
          event.stopPropagation();
          dismiss.disabled = true;
          try {
            const sb = await supabase();
            const { error } = await sb.from('mw_follow_requests').delete().eq('target_id', auth.userId).eq('requester_id', person.id);
            if (error) throw error;
            this.requests = this.requests.filter(item => String(item.requester_id) !== person.id);
            this.#renderActivity();
          } catch (error) {
            console.error('[connections] Could not dismiss follow request.', error);
            toast(t('retry'));
            dismiss.disabled = false;
          }
        },
      }, '×');
      return this.#personRow(person, { trailing: h('div', { class: 'connection-actions' }, accept, dismiss), subtitle: t('followRequest') });
    });
    const newCutoff = Date.now() - 7 * 86400000;
    const followerIds = (this.followerIds || []).filter(id => id !== String(auth.userId))
      .filter(id => !this.followDates?.size || (this.followDates.get(id) || 0) >= newCutoff)
      .sort((a, b) => (this.followDates?.get(b) || 0) - (this.followDates?.get(a) || 0));
    const newFollowers = followerIds.slice(0, 20).map(id => {
      const person = this.peopleById?.get(id) || profiles.peek(id);
      return person ? this.#personRow(person, { subtitle: t('newFollower') }) : null;
    }).filter(Boolean);
    if (!this.suggestions) void this.#loadSuggested(this.token);
    const suggestedRows = (this.suggestions || []).slice(0, 8).map(person => this.#suggestionRow(person));
    this.content.replaceChildren(
      h('h3', { class: 'connections-section-title' }, t('followRequests')),
      ...(requestRows.length ? requestRows : [h('p', { class: 'muted center' }, t('noFollowRequests'))]),
      h('h3', { class: 'connections-section-title' }, t('newFollowers')),
      ...(newFollowers.length ? newFollowers : [h('p', { class: 'muted center' }, t('noNewFollowers'))]),
      h('h3', { class: 'connections-section-title' }, t('suggestedAccounts')),
      ...(suggestedRows.length ? suggestedRows : [h('p', { class: 'muted center' }, t('noSuggestions'))]),
    );
  }

  #renderRows() {
    if (!this.person) return;
    if (this.tab === 'suggested') {
      const items = (this.suggestions || []).filter(person => {
        const text = `${displayText(person.name)} ${displayText(person.username)}`.toLocaleLowerCase();
        return !this.searchTerm || text.includes(this.searchTerm.replace(/^@/, ''));
      });
      this.content.replaceChildren(...(items.length ? items.map(person => this.#suggestionRow(person)) : [h('p', { class: 'muted center' }, t('noSuggestions'))]));
      return;
    }
    const ids = this.tab === 'following' ? (this.followingIds || [])
      : this.tab === 'friends' ? (this.followingIds || []).filter(id => this.followerIds?.includes(id))
        : (this.followerIds || []);
    let rows = ids.map(id => this.peopleById?.get(id) || profiles.peek(id)).filter(Boolean);
    rows = rows.filter(person => {
      const text = `${displayText(person.name)} ${displayText(person.username)}`.toLocaleLowerCase();
      return !this.searchTerm || text.includes(this.searchTerm.replace(/^@/, ''));
    });
    if (this.sort === 'name') rows.sort((a, b) => displayText(a.name).localeCompare(displayText(b.name)));
    else if (this.sort === 'live') rows.sort((a, b) => Number(this.liveRooms.has(b.id)) - Number(this.liveRooms.has(a.id)));
    else rows.sort((a, b) => (this.followDates?.get(b.id) || 0) - (this.followDates?.get(a.id) || 0));
    this.content.replaceChildren(...(rows.length ? rows.map(person => this.#personRow(person)) : [h('p', { class: 'muted center' }, t('noneYet'))]));
  }

  #personRow(person, { trailing = null, subtitle = '' } = {}) {
    const id = String(person.id || '');
    const label = displayText(person.name) || displayText(person.username) || 'MilkyWay';
    const username = displayText(person.username).replace(/^@/, '');
    const row = h('article', { class: 'connection-row' });
    const liveRoom = this.liveRooms.get(id);
    const avatarButton = h('button', {
      class: `connection-avatar${liveRoom ? ' has-live' : ''}`, type: 'button',
      'aria-label': liveRoom ? `${label} · ${t('live')}` : label,
      onclick: () => liveRoom ? this.openLive?.(liveRoom) : this.openProfile?.(person),
    }, avatar({ ...person, name: label }, 46), liveRoom ? h('span', { class: 'connection-live-badge' }, 'LIVE') : null);
    const identity = h('button', {
      class: 'connection-identity', type: 'button', onclick: () => this.openProfile?.(person),
    }, h('b', {}, label), username ? h('small', { class: 'muted' }, `@${username}`) : null,
    subtitle ? h('small', { class: 'muted' }, subtitle) : null);
    const newCount = Number(this.newPosts?.get(id)) || 0;
    const newPosts = newCount > 0 ? h('span', { class: 'connection-new-posts' }, `${newCount} ${t('newPosts')}`) : null;
    const following = profiles.isFollowing(id);
    const friend = this.own && (this.followerIds || []).includes(id) && following;
    const requested = profiles.isRequested(id);
    const action = trailing || h('button', {
      class: `connection-action${following ? '' : ' hot'}`, type: 'button',
      'aria-pressed': String(following || requested),
      onclick: async event => {
        event.stopPropagation();
        if (!auth.signedIn()) { this.requireLogin?.(); return; }
        action.disabled = true;
        try {
          const next = !following && !requested;
          const result = await actions.follow(id, next);
          if (this.tab === 'suggested' && next) this.suggestions = null;
          if (result === 'requested') toast(t('followRequestSent'));
          this.#renderRows();
        } catch (error) {
          console.error('[connections] Follow action failed.', error);
          toast(t('retry'));
          action.disabled = false;
        }
      },
    }, friend ? t('friends') : requested ? t('requested')
      : following && this.manage ? t('remove')
        : following ? t('following') : t('follow'));
    const overflow = h('button', {
      class: 'connection-overflow', type: 'button', 'aria-label': t('moreOptions'), title: t('moreOptions'),
      onclick: event => {
        event.stopPropagation();
        const existing = row.querySelector('.connection-menu');
        if (existing) { existing.remove(); return; }
        const menu = h('div', { class: 'connection-menu', 'data-no-swipe': true },
          h('button', { type: 'button', onclick: () => this.openProfile?.(person) }, t('viewProfile')),
          following || requested ? h('button', { type: 'button', onclick: async () => {
            try { await actions.follow(id, false); this.#renderRows(); }
            catch (error) { console.error('[connections] Could not remove connection.', error); toast(t('retry')); }
          } }, requested ? t('cancelRequest') : t('unfollow')) : null);
        row.append(menu);
      },
    }, '⋯');
    row.append(avatarButton, identity, h('div', { class: 'connection-row-meta' }, newPosts), action, overflow);
    return row;
  }

  #suggestionRow(person) {
    const safe = safePerson(person);
    const row = this.#personRow(safe, { subtitle: Number(person.mutual) > 0 ? `${person.mutual} ${t('mutualConnections')}` : '' });
    row.classList.add('connection-suggestion');
    const previews = this.suggestionPreviews?.get(safe.id) || [];
    if (previews.length) {
      const strip = h('div', { class: 'connection-previews', 'aria-label': t('recentPosts'), 'data-no-swipe': true });
      for (const post of previews) strip.append(
        h('button', { type: 'button', 'aria-label': t('viewPost'), onclick: () => this.openProfile?.(safe) },
          h('img', { src: post.url, alt: '', loading: 'lazy', decoding: 'async' }),
          post.video ? h('span', { class: 'connection-preview-play', 'aria-hidden': 'true', html: icon.play }) : null),
      );
      row.append(strip);
    }
    const dismiss = h('button', {
      class: 'connection-dismiss suggestion-dismiss', type: 'button', 'aria-label': t('dismiss'), title: t('dismiss'),
      onclick: event => {
        event.stopPropagation();
        this.dismissed.add(safe.id);
        try {
          const key = `mw_connections_dismissed_${auth.userId || 'guest'}`;
          localStorage.setItem(key, JSON.stringify([...this.dismissed]));
        } catch (error) { console.warn('[connections] Could not store dismissed suggestion.', error); }
        this.suggestions = (this.suggestions || []).filter(item => String(item.id) !== safe.id);
        this.#renderRows();
      },
    }, '×');
    row.append(dismiss);
    return row;
  }
}
