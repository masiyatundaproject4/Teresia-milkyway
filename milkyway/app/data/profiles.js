// Profile cache: authors seen in the feed / Lives / inbox are kept on the device, so names and avatars render
// instantly (and offline) everywhere. Follow state is remembered per account.
import { store } from '../core/store.js';
import { rest, auth } from '../core/net.js';
import { scoped } from '../core/sync.js';
import { bus } from '../core/events.js';
import { safePublicText } from './usernames.js';

const memory = new Map();
const following = new Set();
const requested = new Set();
let followLoaded = false;
let followingRefresh = null;

const normalize = row => row && ({
  id: String(row.id), name: safePublicText(row.name || row.display_name) || safePublicText(row.username) || 'MilkyWay',
  username: safePublicText(row.username).replace(/^@/, '').toLowerCase(),
  avatar: safePublicText(row.avatar || row.avatar_url),
  private: row.private == null && row.is_private == null ? null : Boolean(row.private ?? row.is_private),
});

export const profiles = {
  /** Seed from data that already arrived with a feed page / Live list (no extra request). */
  prime(list) {
    for (const item of list || []) {
      const profile = normalize(item);
      if (!profile?.id) continue;
      const before = memory.get(profile.id);
      memory.set(profile.id, profile);
      if (!before || before.avatar !== profile.avatar || before.name !== profile.name
        || before.username !== profile.username || before.private !== profile.private) store.set(`profile:${profile.id}`, profile);
    }
  },
  update(item) {
    const profile = normalize(item);
    if (!profile?.id) return;
    memory.set(profile.id, profile);
    store.set(`profile:${profile.id}`, profile);
    bus.emit('profile', profile);
  },
  peek: id => memory.get(String(id)) || null,
  matching(query) {
    const needle = safePublicText(query).replace(/^@/, '').toLocaleLowerCase();
    if (needle.length < 2) return [];
    return [...memory.values()].filter(profile =>
      `${profile.name} ${profile.username}`.toLocaleLowerCase().includes(needle));
  },
  /** Many at once: memory → device → one network request for the rest. */
  async many(ids) {
    const wanted = [...new Set(ids.map(String))];
    const missing = [];
    for (const id of wanted) {
      if (memory.has(id)) continue;
      const saved = await store.get(`profile:${id}`);
      if (saved) {
        const profile = normalize(saved);
        if (profile?.id) {
          memory.set(id, profile);
          store.set(`profile:${id}`, profile);
        } else missing.push(id);
      } else missing.push(id);
    }
    if (missing.length) {
      try {
        const rows = await rest(`mw_profiles?id=in.(${missing.slice(0, 100).join(',')})&select=id,display_name,username,avatar_url`);
        profiles.prime(rows || []);
      } catch { /* offline: initials are shown */ }
    }
    return new Map(wanted.map(id => [id, memory.get(id) || null]));
  },
  isFollowing: id => following.has(String(id)),
  isRequested: id => requested.has(String(id)),
  setRequested(id, on) {
    on ? requested.add(String(id)) : requested.delete(String(id));
    bus.emit('follow', { id: String(id), on: following.has(String(id)), requested: on });
  },
  setFollowing(id, on) {
    on ? following.add(String(id)) : following.delete(String(id));
    store.set(scoped('following'), [...following]);
    bus.emit('follow', { id: String(id), on });
  },
  /** Who the signed-in user follows (cached; refreshed quietly). */
  async loadFollowing() {
    if (!auth.signedIn()) { following.clear(); return following; }
    if (!followLoaded) {
      followLoaded = true;
      (await store.get(scoped('following')) || []).forEach(id => following.add(id));
    }
    void profiles.refreshFollowing();
    return following;
  },
  async refreshFollowing() {
    if (!auth.signedIn()) { following.clear(); return false; }
    if (followingRefresh) return followingRefresh;
    const userId = auth.userId;
    followingRefresh = rest(`mw_follows?follower_id=eq.${userId}&select=following_id&limit=2000`)
      .then(rows => {
        if (auth.userId !== userId) return false;
        following.clear();
        (rows || []).forEach(row => following.add(String(row.following_id)));
        store.set(scoped('following'), [...following]);
        bus.emit('follow', null);
        return true;
      })
      .catch(error => {
        if (navigator.onLine !== false) console.warn('[profiles] following list refresh failed', error);
        return false;
      })
      .finally(() => { followingRefresh = null; });
    return followingRefresh;
  },
};
bus.on('auth', () => { following.clear(); requested.clear(); followLoaded = false; followingRefresh = null; profiles.loadFollowing(); });
