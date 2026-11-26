// Tests for the rebuilt MilkyWay core: the single-request feed API and the non-blocking app shell.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import feed from '../api/milkyway-feed.js';
import liveRoom from '../api/milkyway-live-room.js';
import callApi from '../api/milkyway-call.js';
import livekitToken from '../api/milkyway-livekit-token.js';
import { runApi } from '../api/_lib/fetch-adapter.js';
import { accessToken, closeRoom, livekitConfigurationError, livekitConfigured, livekitUrl, livekitUsable, SCREEN_SHARE } from '../api/_lib/livekit.js';
import { postShareResponse } from '../api/_lib/post-share.js';
import { assertRoomAccess } from '../milkyway/app/core/livekit-access.js';
import { identifyMediaFile, mediaInfo, openFilePicker } from '../milkyway/app/core/media-files.js';
import { checkDeployment } from '../milkyway/app/core/update-check.js';

const A = '11111111-1111-4111-8111-111111111111'; // public author
const B = '22222222-2222-4222-8222-222222222222'; // private author
const P = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

test('people search prioritizes new profiles, separates unique handles from names, and excludes contact details', () => {
  const search = readFileSync(new URL('../milkyway/app/data/messages.js', import.meta.url), 'utf8');
  const profiles = readFileSync(new URL('../milkyway/app/data/profiles.js', import.meta.url), 'utf8');
  const usernames = readFileSync(new URL('../milkyway/app/data/usernames.js', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../milkyway/app/ui/auth-sheet.js', import.meta.url), 'utf8');
  assert.match(search, /select=id,display_name,username,avatar_url&or=\(username\.ilike\.\$\{pattern\},display_name\.ilike\.\$\{pattern\}\)&order=created_at\.desc&limit=1000/);
  assert.match(search, /containsPrivateContact\(rawQuery\)/);
  assert.match(search, /name: safePublicText\(row\.display_name\)/);
  assert.match(search, /username: safePublicText\(row\.username\)/);
  assert.match(search, /profiles\.matching\(q\)/);
  assert.doesNotMatch(search, /select=[^`]*(?:email|phone)/i);
  assert.match(usernames, /PHONE_PATTERN/);
  assert.match(usernames, /safePublicText\(value\)/);
  assert.match(profiles, /matching\(query\)/);
  assert.match(profiles, /normalize\(saved\)/);
  assert.match(usernames, /requestedDisplayName = ''/);
  assert.match(usernames, /safePublicText\(requestedDisplayName\)/);
  assert.match(usernames, /usernameAvailable\(sb, requested, excludeId\)/);
  assert.doesNotMatch(usernames, /usernameAvailable\(sb,\s*displayName/);
  assert.match(auth, /requestedDisplayName: displayName\.value/);
  assert.match(auth, /profiles\.update\(\{/);
});

test('group management schema and UI implement guarded joins, invitations and co-admin tools', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261207_milkyway_dm_group_management.sql', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/milkyway-groups.js', import.meta.url), 'utf8');
  const inbox = readFileSync(new URL('../milkyway/app/ui/inbox-view.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../milkyway/app/ui/group-view.js', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../milkyway/app/data/groups.js', import.meta.url), 'utf8');
  const longPress = readFileSync(new URL('../milkyway/app/ui/long-press.js', import.meta.url), 'utf8');
  const approvalMigration = readFileSync(new URL('../supabase/migrations/20261211_milkyway_group_approved_owner.sql', import.meta.url), 'utf8');
  const moderationMigration = readFileSync(new URL('../supabase/migrations/20261212_milkyway_group_message_moderation.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(migration, /join_mode in \('open', 'request_approval', 'invite_only'\)/);
  assert.match(migration, /add column if not exists avatar_url text not null default ''/);
  assert.match(migration, /add column if not exists join_mode text not null default 'invite_only'/);
  assert.match(migration, /role in \('admin', 'co_admin', 'member'\)/);
  assert.match(migration, /members_can_invite/);
  assert.match(migration, /mw_group_join_request_decide/);
  assert.match(migration, /Only the group creator can change administrator roles/);
  assert.match(migration, /Only the group creator can remove an admin or co-admin/);
  assert.match(migration, /Only group members can invite people/);
  assert.match(migration, /mw_group_create_advanced\(\s*p_name, p_caption, p_description, '', 'invite_only'/);
  assert.match(migration, /join_status in \('active', 'invited'\)/);
  assert.match(api, /mw_group_create_advanced/);
  assert.match(api, /'decide-request'/);
  assert.match(api, /groupJoinMode/);
  assert.match(inbox, /discoverGroups/);
  assert.match(inbox, /joinAndOpenGroup/);
  assert.match(view, /makeCoAdmin/);
  assert.match(view, /this\.avatarUrl/);
  assert.match(view, /decideGroupRequest/);
  assert.match(view, /sendGroupMessage/);
  assert.match(data, /mw_dm_group_messages/);
  assert.match(api, /missingGroupColumn/);
  assert.match(api, /\['id', 'name', 'caption', \.\.\.optionalColumns, 'created_at'\]/);
  assert.match(api, /optionalColumns\.delete\(missing\)/);
  assert.match(api, /created_by: group\.created_by/);
  assert.match(api, /listCreatedGroups/);
  assert.match(inbox, /isActiveGroupMember\(group\)/);
  assert.match(view, /isActiveGroupMember\(member/);
  assert.match(view, /canDelete = creator \|\| \['admin', 'co_admin', 'owner'\]\.includes\(group\.role\)/);
  assert.match(view, /deleteGroup\(groupId\)/);
  assert.match(inbox, /bindLongPress\(row, \(\) => this\.#openGroupActions\(group\)\)/);
  assert.match(view, /bindLongPress\(bubble, \(\) => this\.#openMessageActions\(row\)\)/);
  assert.match(view, /clearGroupMessages\(groupId\)/);
  assert.match(view, /deleteGroupMessage\(groupId, selected\.id\)/);
  assert.match(api, /'clear-messages': async/);
  assert.match(api, /'delete-message': async/);
  assert.match(api, /Only group admins or the creator can clear messages/);
  assert.match(api, /Only the sender or a group admin can delete this message/);
  assert.match(data, /request\('clear-messages'/);
  assert.match(data, /request\('delete-message'/);
  assert.match(longPress, /pointerdown/);
  assert.match(longPress, /contextmenu/);
  assert.match(moderationMigration, /sender_id = auth\.uid\(\)\s+or public\.mw_dm_is_group_admin/);
  assert.match(moderationMigration, /role in \('admin', 'co_admin', 'owner'\)/);
  assert.match(approvalMigration, /join_status in \('active', 'approved', 'pending', 'invited'\)/);
  assert.match(approvalMigration, /role in \('admin', 'co_admin', 'member', 'owner'\)/);
  assert.match(approvalMigration, /Only group admins or the creator can delete the group/);
  assert.match(repair, /supabase\/migrations\/20261212_milkyway_group_message_moderation\.sql/);
  assert.match(repair, /supabase\/migrations\/20261211_milkyway_group_approved_owner\.sql/);
  assert.match(repair, /Only group admins or the creator can delete the group/);
});

test('DM media notes include private one-view storage and recording controls', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261208_milkyway_dm_media_notes.sql', import.meta.url), 'utf8');
  const composer = readFileSync(new URL('../milkyway/app/ui/chat-composer.js', import.meta.url), 'utf8');
  const media = readFileSync(new URL('../milkyway/app/data/chat-media.js', import.meta.url), 'utf8');
  const direct = readFileSync(new URL('../milkyway/app/ui/inbox-view.js', import.meta.url), 'utf8');
  const group = readFileSync(new URL('../milkyway/app/ui/group-view.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/milkyway-message.js', import.meta.url), 'utf8');
  assert.match(migration, /values \(\s*'mw-dm-ephemeral', 'mw-dm-ephemeral', false/i);
  assert.match(migration, /mw_message_consume_once/);
  assert.match(migration, /mw_message_complete_once/);
  assert.match(migration, /mw_dm_ephemeral_media_allowed/);
  assert.match(composer, /MediaRecorder/);
  assert.match(composer, /getUserMedia/);
  assert.match(composer, /dm-waveform/);
  assert.match(composer, /video-note-playback/);
  assert.match(composer, /viewOnce/);
  assert.match(composer, /recordingStarting/);
  assert.match(composer, /cancelRecording\(\)/);
  assert.match(composer, /dm-composer-actions/);
  assert.match(media, /mw-dm-ephemeral/);
  assert.match(media, /consume-once/);
  assert.match(direct, /sendDirectMedia/);
  assert.match(direct, /this\.composer\.cancelRecording\(\)/);
  assert.match(group, /sendGroupMedia/);
  assert.match(group, /this\.composer\.cancelRecording\(\)/);
  assert.match(api, /mw_message_send_once/);
  assert.match(api, /mw_message_complete_once/);
});

test('Walkie-Talkie uses hold-to-record controls and sends through DM and protected group pipelines', () => {
  const walkie = readFileSync(new URL('../milkyway/app/ui/walkie-talkie.js', import.meta.url), 'utf8');
  const groups = readFileSync(new URL('../milkyway/app/data/groups.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const composer = readFileSync(new URL('../milkyway/app/ui/chat-composer.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(walkie, /pointerdown/);
  assert.match(walkie, /pointerup/);
  assert.match(walkie, /sendDirectMedia/);
  assert.match(walkie, /sendGroupWalkie/);
  assert.match(walkie, /loadLatestGroupWalkie/);
  assert.match(walkie, /downloadGroupWalkie/);
  assert.match(walkie, /#stopGroupListening/);
  assert.match(groups, /filter: `group_id=eq\.\$\{id\}`/);
  assert.match(groups, /removeChannel\(entry\.channel\)/);
  assert.match(walkie, /cancelRecording\(\)/);
  assert.match(main, /#walkieEntry/);
  assert.match(shell, /id="walkieEntry"/);
  assert.match(shell, /class="walkie-label"[^>]*>Walkie-Talkie<\/span>/);
  assert.match(composer, /chat-video-note/);
  assert.match(styles, /\.dm-composer-actions \.chat-video-note \{[^}]*#c92f50/);
  assert.match(styles, /\.walkie-label \{[^}]*font-size: 9px/);
  assert.match(styles, /\.walkie-entry\.hide-label \.walkie-label \{ display: none; \}/);
  assert.match(styles, /\.walkie-talk-button/);
});

test('Group Walkie audio is membership-authorized and stored privately', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261210_milkyway_group_walkie.sql', import.meta.url), 'utf8');
  const groups = readFileSync(new URL('../api/milkyway-groups.js', import.meta.url), 'utf8');
  const media = readFileSync(new URL('../milkyway/app/data/chat-media.js', import.meta.url), 'utf8');
  assert.match(migration, /'mw-group-walkie', 'mw-group-walkie', false/);
  assert.match(migration, /mw_dm_is_group_member/);
  assert.match(groups, /requireActiveGroupMember/);
  assert.match(groups, /body\.storagePath !== storagePath/);
  assert.match(groups, /walkie-history/);
  assert.match(media, /from\('mw-group-walkie'\)\.download/);
  assert.match(media, /from\('mw-group-walkie'\)\.upload/);
});

test('Watch Together synchronizes authorized chat playback and cleans up its player', () => {
  const watch = readFileSync(new URL('../milkyway/app/ui/watch-party.js', import.meta.url), 'utf8');
  const direct = readFileSync(new URL('../milkyway/app/ui/inbox-view.js', import.meta.url), 'utf8');
  const group = readFileSync(new URL('../milkyway/app/ui/group-view.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261209_milkyway_watch_party.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  assert.ok(watch.includes("`mw-watch:dm:${[auth.userId, this.roomId].sort().join(':')}`"));
  assert.match(watch, /\.on\('broadcast', \{ event: 'watch-party' \}/);
  assert.match(watch, /'play', 'pause', 'seek', 'sync'/);
  assert.match(watch, /youtube-nocookie\.com\/embed/);
  assert.match(watch, /removeChannel\(channel\)/);
  assert.match(watch, /player\.pause\(\)[\s\S]*player\.removeAttribute\('src'\)/);
  assert.match(direct, /watchParty\.join\('dm'/);
  assert.match(direct, /watchableUrl\(row\.body\)/);
  assert.match(group, /watchParty\.join\('group'/);
  assert.match(group, /watchableUrl\(row\.body\)/);
  assert.match(migration, /mw_watch_party_channel_access/);
  assert.match(migration, /realtime\.messages/);
  assert.match(migration, /mw_dm_is_group_member/);
  assert.match(repair, /20261209_milkyway_watch_party\.sql/);
  assert.match(worker, /ui\/watch-party\.js/);
});

test('voice presets process chat recordings and published Live audio with deterministic cleanup', () => {
  const effects = readFileSync(new URL('../milkyway/app/ui/voice-effects.js', import.meta.url), 'utf8');
  const composer = readFileSync(new URL('../milkyway/app/ui/chat-composer.js', import.meta.url), 'utf8');
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  for (const preset of ['normal', 'child', 'female', 'male', 'robot', 'chipmunk', 'monster', 'radio']) {
    assert.match(effects, new RegExp(`id: '${preset}'`));
  }
  assert.match(effects, /createScriptProcessor/);
  assert.match(effects, /createMediaStreamDestination/);
  assert.match(effects, /close\(\)[\s\S]*context\.close/);
  assert.match(composer, /createVoiceEffects\(stream, this\.voicePreset\)/);
  assert.match(composer, /effects\?\.close\(\)/);
  assert.match(liveSession, /publishTrack\(capture\.track, \{ source: this\.sdk\.Track\.Source\.Microphone \}\)/);
  assert.match(liveSession, /setVoicePreset\(id\)/);
  assert.match(liveSession, /#releaseVoiceCapture/);
  assert.match(liveView, /data-act': 'voice'/);
  assert.match(liveView, /voicePicker\(session\)/);
  assert.match(worker, /ui\/voice-effects\.js/);
});

test('ordinary LiveKit token checks avoid RoomService management requests', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  let requests = 0;
  process.env.LIVEKIT_URL = 'wss://live.example.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected LiveKit management request.'); };
  try {
    assert.equal(await livekitUsable(), true);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('LiveKit reads Cloudflare bindings first and identifies missing credentials by name', () => {
  const bindings = {
    LIVEKIT_URL: 'wss://binding-live.example.test',
    LIVEKIT_API_KEY: 'binding-key',
    LIVEKIT_API_SECRET: 'binding-secret',
  };
  assert.equal(livekitConfigured(bindings), true);
  assert.equal(livekitUrl(bindings), bindings.LIVEKIT_URL);
  assert.equal(livekitConfigurationError({ LIVEKIT_URL: bindings.LIVEKIT_URL, LIVEKIT_API_KEY: '' }),
    'LiveKit is not configured. Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET. Set LIVEKIT_URL in [vars] and LIVEKIT_API_KEY / LIVEKIT_API_SECRET as Cloudflare secrets.');
  assert.match(livekitConfigurationError({ ...bindings, LIVEKIT_URL: 'not-a-url' }), /LIVEKIT_URL is invalid/);
  const claims = JSON.parse(Buffer.from(accessToken({ identity: A, room: `dm-call-${A}-${B}`, canPublish: true }, bindings).split('.')[1], 'base64url'));
  assert.equal(claims.iss, bindings.LIVEKIT_API_KEY);
  assert.equal(claims.sub, A);
  assert.equal(claims.video.room, `dm-call-${A}-${B}`);
});

test('Hosted API routes dispatch DM video-call tokens to the configured LiveKit signer', async () => {
  assert.equal(SCREEN_SHARE, 3);
  const fetchAdapter = readFileSync(new URL('../api/_lib/fetch-adapter.js', import.meta.url), 'utf8');
  const cloudflareApi = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');
  const netlifyApi = readFileSync(new URL('../netlify/functions/milkyway-api.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(fetchAdapter, /'milkyway-call': call/);
  assert.match(cloudflareApi, /runApi\(name, request, env\)/);
  assert.match(netlifyApi, /runApi\(context\.params\.name, request\)/);
  assert.match(netlifyApi, /path: '\/api\/:name'/);
  assert.match(server, /app\.all\('\/api\/:name'/);

  const originalFetch = globalThis.fetch;
  const callId = P(81);
  const call = {
    id: callId, caller_id: A, callee_id: B, status: 'accepted',
    offer: { mode: 'video', callType: 'video', videoEnabled: true }, created_at: new Date().toISOString(),
  };
  globalThis.fetch = async address => {
    const url = String(address);
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: A }), { status: 200 });
    if (url.includes('/rest/v1/mw_dm_calls?')) return new Response(JSON.stringify([call]), { status: 200 });
    if (url.includes('/rest/v1/mw_profiles?')) return new Response('[]', { status: 200 });
    throw new Error(`Unexpected DM token request: ${url}`);
  };
  try {
    const response = await runApi('milkyway-call', new Request(`https://www.masiyatunda.com/api/milkyway-call?action=token`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-session', apikey: 'test-public-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: callId, name: 'Caller' }),
    }), {
      LIVEKIT_URL: 'wss://binding-live.example.test',
      LIVEKIT_API_KEY: 'binding-key',
      LIVEKIT_API_SECRET: 'binding-secret',
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.serverUrl, 'wss://binding-live.example.test');
    assert.equal(payload.callType, 'video');
    assert.equal(payload.videoEnabled, true);
    const [headerPart, claimsPart, signature] = payload.token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url'));
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url'));
    assert.equal(header.alg, 'HS256');
    assert.equal(signature, createHmac('sha256', 'binding-secret').update(`${headerPart}.${claimsPart}`).digest('base64url'));
    assert.equal(claims.iss, 'binding-key');
    assert.equal(claims.sub, A);
    assert.equal(claims.video.room, `dm-call-${A}-${B}`);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canSubscribe, true);
    assert.equal(claims.video.canPublishData, true);
    assert.deepEqual(claims.video.canPublishSources, ['camera', 'microphone', 'screen_share']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(claims.metadata), { avatar: '', callType: 'video', videoEnabled: true });
    const missingResponse = await runApi('milkyway-call', new Request('https://www.masiyatunda.com/api/milkyway-call?action=start', {
      method: 'POST',
      headers: { authorization: 'Bearer test-session', apikey: 'test-public-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ callee: B, mode: 'audio' }),
    }), { LIVEKIT_URL: 'wss://binding-live.example.test' });
    const missing = await missingResponse.json();
    assert.equal(missingResponse.status, 503);
    assert.match(missing.error, /Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creator service cache repair and push delivery cover post and incoming-call notifications', () => {
  const creatorMigration = readFileSync(new URL('../supabase/migrations/20261127_milkyway_creator_services_schema_cache.sql', import.meta.url), 'utf8');
  const pushMigration = readFileSync(new URL('../supabase/migrations/20261127_milkyway_push_delivery.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  const pushClient = readFileSync(new URL('../milkyway/app/core/push.js', import.meta.url), 'utf8');
  const pushApi = readFileSync(new URL('../api/fcm.js', import.meta.url), 'utf8');
  assert.match(creatorMigration, /alter table public\.mw_creator_services[\s\S]*notify pgrst, 'reload schema'/i);
  assert.match(creatorMigration, /grant usage on schema public to anon, authenticated/i);
  assert.match(creatorMigration, /grant select on public\.mw_creator_services to anon, authenticated/i);
  assert.match(pushMigration, /vault\.decrypted_secrets/);
  assert.match(pushMigration, /mw_post_notifications_push/);
  assert.match(pushMigration, /mw_dm_calls_push/);
  assert.match(pushApi, /createCipheriv/);
  assert.match(pushApi, /FCM_WEBHOOK_SECRET/);
  assert.match(pushClient, /applicationServerKey/);
  assert.match(worker, /data\.post/);
  assert.match(worker, /data\.call/);
  assert.match(repair, /mw_push_delivery_relay/);
});

function fakeSupabase(routes) {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    const match = routes.find(([pattern]) => address.includes(pattern));
    const body = match ? match[1] : [];
    return new Response(JSON.stringify(typeof body === 'function' ? body(address) : body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

async function call(query) {
  let status = 200, payload;
  const res = { headersSent: false, setHeader() { return res; }, status(code) { status = code; return res; }, json(value) { payload = value; res.headersSent = true; return res; } };
  await feed({ method: 'GET', headers: {}, query }, res);
  return { status, payload };
}

test('group creation API validates join mode and delegates creation to the secure RPC', async () => {
  const originalFetch = globalThis.fetch;
  const groupId = P(95);
  const calls = fakeSupabase([
    ['/auth/v1/user', { id: A, email: 'member@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }],
    ['/rpc/mw_group_create_advanced', groupId],
    ['/rest/v1/mw_dm_groups?', [{ id: groupId, name: 'Community', join_mode: 'open', created_by: A }]],
  ]);
  try {
    const response = await runApi('milkyway-groups', new Request('https://www.masiyatunda.com/api/milkyway-groups?action=create', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Community', joinMode: 'open', membersCanInvite: true }),
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.group.id, groupId);
    assert.equal(result.group.join_mode, 'open');
    assert.ok(calls.some(url => url.includes('/rpc/mw_group_create_advanced')));

    const invalid = await runApi('milkyway-groups', new Request('https://www.masiyatunda.com/api/milkyway-groups?action=create', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Community', joinMode: 'automatic' }),
    }));
    assert.equal(invalid.status, 400);
  } finally { globalThis.fetch = originalFetch; }
});

test('group list keeps Walkie-Talkie conversations available when newer group columns are missing', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async input => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: A }), { status: 200 });
    if (url.includes('/rest/v1/mw_dm_group_members?')) {
      if (url.includes('avatar_url')) {
        return new Response(JSON.stringify({
          code: '42703',
          message: 'column mw_dm_groups_1.avatar_url does not exist',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('join_mode')) {
        return new Response(JSON.stringify({
          code: '42703',
          message: 'column mw_dm_groups_1.join_mode does not exist',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([{
        role: 'member',
        join_status: 'active',
        mw_dm_groups: { id: P(97), name: 'Community', caption: '' },
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const response = await runApi('milkyway-groups', new Request('https://www.masiyatunda.com/api/milkyway-groups?action=list', {
      headers: { authorization: 'Bearer test-token' },
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.groups[0].name, 'Community');
    assert.equal(result.groups[0].avatar_url, '');
    assert.equal(result.groups[0].join_mode, 'open');
    const groupQueries = urls.filter(url => url.includes('/rest/v1/mw_dm_group_members?'));
    assert.equal(groupQueries.length, 3);
    assert.match(groupQueries[0], /avatar_url/);
    assert.match(groupQueries[1], /join_mode/);
    assert.doesNotMatch(groupQueries[1], /avatar_url/);
    assert.doesNotMatch(groupQueries[2], /avatar_url|join_mode/);
  } finally { globalThis.fetch = originalFetch; }
});

test('one-view DM API requires a private consume RPC and deletes media before returning bytes', async () => {
  const originalFetch = globalThis.fetch;
  const id = P(96);
  const path = `${A}/${id}.webm`;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: B }), { status: 200 });
    if (url.includes('/rpc/mw_message_consume_once')) {
      return new Response(JSON.stringify({
        message: { id, message_type: 'voice_note' },
        payload: { bucket: 'mw-dm-ephemeral', object_path: path, content_type: 'audio/webm', body: '', metadata: {} },
      }), { status: 200 });
    }
    if (url.includes('/storage/v1/object/mw-dm-ephemeral/') && (init.method || 'GET') === 'GET') {
      return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'Content-Type': 'audio/webm' } });
    }
    if (url.includes('/storage/v1/object/mw-dm-ephemeral') && init.method === 'DELETE') {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/rpc/mw_message_complete_once')) return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ message: 'Unexpected request' }), { status: 500 });
  };
  try {
    const response = await runApi('milkyway-message', new Request('https://www.masiyatunda.com/api/milkyway-message?action=consume-once', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0');
    assert.equal(response.headers.get('content-type'), 'audio/webm');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [82, 73, 70, 70]);
    assert.ok(calls.some(call => call.url.includes('/storage/v1/object/mw-dm-ephemeral') && call.method === 'DELETE'));
    assert.ok(calls.some(call => call.url.includes('/rpc/mw_message_complete_once')));
  } finally { globalThis.fetch = originalFetch; }
});

test('feed page returns ready-to-render posts with counts and hides private and audience-restricted posts', async () => {
  const rows = [
    { id: P(1), author_id: A, author_name: 'Asha', caption: 'hi', media_url: 'https://x/photo.webp', media_type: 'image', media_items: ['https://x/photo.webp'], media_preview_items: ['https://x/photo-preview.webp'], audio_url: 'https://x/music.mp3', slideshow_style: 'cinema', created_at: '2026-11-14T10:00:00Z' },
    { id: P(2), author_id: B, author_name: 'Bo', caption: 'secret', media_url: null, media_type: null, created_at: '2026-11-14T09:00:00Z' },
    { id: P(3), author_id: A, author_name: 'Asha', caption: 'only me', media_url: null, media_type: null, created_at: '2026-11-14T08:00:00Z' },
  ];
  const calls = fakeSupabase([
    ['/rest/v1/mw_posts?', rows],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: 'https://x/a.jpg' }]],
    ['/rpc/mw_privacy_flags', { [B]: { private: true } }],
    ['/rpc/mw_post_audiences', [{ post_id: P(3), owner_id: A, audience: 'only_me', can_see: false }]],
    ['/rest/v1/mw_signals?', [{ post_id: P(1), user_id: 'x' }, { post_id: P(1), user_id: 'y' }]],
    ['/rest/v1/mw_echoes?', [{ post_id: P(1) }]],
  ]);
  const { status, payload } = await call({ action: 'page', limit: '5' });
  assert.equal(status, 200);
  assert.doesNotMatch(calls.find(url => url.includes('/mw_posts?')), /author_id=/, 'the For You page is global, not limited to the caller');
  assert.deepEqual(payload.posts.map(post => post.id), [P(1)]);
  assert.deepEqual(payload.posts[0], {
    id: P(1), author: { id: A, name: 'Asha K', username: 'asha', avatar: 'https://x/a.jpg' }, caption: 'hi',
    media: { url: 'https://x/photo.webp', type: 'image', items: ['https://x/photo.webp'], previewItems: ['https://x/photo-preview.webp'], audioUrl: 'https://x/music.mp3', style: 'cinema' }, createdAt: '2026-11-14T10:00:00Z', likes: 2, comments: 1, liked: false, saved: false,
  });
  assert.equal(payload.next, null);
  // One posts read, then every lookup in parallel — never per-post requests.
  assert.equal(calls.filter(url => url.includes('/mw_posts?')).length, 1);
});

test('shared-post metadata returns public content and excludes private or audience-restricted posts', async () => {
  const row = {
    id: P(9), author_id: A, author_name: 'Asha', title: 'Post title', caption: 'A lovely <post>',
    media_url: 'https://x/photo.webp', media_type: 'image', media_items: [], media_preview_items: ['https://x/preview.webp'],
    created_at: '2026-11-14T10:00:00Z',
  };
  fakeSupabase([
    ['/rest/v1/mw_posts?', [row]],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: '' }]],
    ['/rpc/mw_privacy_flags', {}],
    ['/rpc/mw_post_audiences', []],
  ]);
  const { status, payload } = await call({ action: 'share', id: P(9) });
  assert.equal(status, 200);
  assert.equal(payload.post.title, 'Post title');
  assert.equal(payload.post.author.name, 'Asha K');
  assert.equal(payload.post.caption, 'A lovely <post>');
  assert.equal(payload.post.media.previewItems[0], 'https://x/preview.webp');

  fakeSupabase([
    ['/rest/v1/mw_posts?', [{ ...row, author_id: B }]],
    ['/rest/v1/mw_profiles?', []],
    ['/rpc/mw_privacy_flags', { [B]: { private: true } }],
    ['/rpc/mw_post_audiences', []],
  ]);
  const hidden = await call({ action: 'share', id: P(9) });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.payload.post, null);

  fakeSupabase([
    ['/rest/v1/mw_posts?', [row]],
    ['/rest/v1/mw_profiles?', [{ id: A, display_name: 'Asha K', username: 'asha', avatar_url: '' }]],
    ['/rpc/mw_privacy_flags', {}],
    ['/rpc/mw_post_audiences', [{ post_id: P(9), can_see: false }]],
  ]);
  const audienceHidden = await call({ action: 'share', id: P(9) });
  assert.equal(audienceHidden.payload.post, null);
});

test('shared-post metadata falls back when older schemas lack title and slideshow columns', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/rest/v1/mw_posts?') && address.includes('select=title,')) {
      return new Response(JSON.stringify({ message: "Could not find the 'title' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (address.includes('/rest/v1/mw_posts?') && !address.includes('media_preview_items')) {
      return new Response(JSON.stringify([{
        id: P(11), author_id: A, caption: 'Legacy caption', media_url: null, media_type: null,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (address.includes('/rest/v1/mw_posts?')) {
      return new Response(JSON.stringify({ message: "Could not find the 'media_preview_items' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'share', id: P(11) });
  assert.equal(status, 200);
  assert.equal(payload.post.title, '');
  assert.equal(payload.post.caption, 'Legacy caption');
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 3);
});

test('post share page emits escaped post-specific Open Graph metadata and a useful app fallback', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    post: {
      id: P(10), title: 'A post title', author: { name: 'Asha & Co' }, caption: 'A <great> view',
      media: { type: 'image', url: 'https://x/post.webp', previewItems: [] },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const response = await postShareResponse(`https://milkyway.test/share/${P(10)}`, P(10));
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /property="og:image" content="https:\/\/x\/post\.webp"/);
  assert.match(body, /property="og:title" content="A post title"/);
  assert.match(body, /property="og:description" content="A &lt;great&gt; view"/);
  assert.match(body, /http-equiv="refresh" content="0;url=https:\/\/milkyway\.test\/milkyway\/\?post=/);
  assert.match(body, /<img src="https:\/\/x\/post\.webp"/);
  assert.match(body, /Open this post in MilkyWay/);
  assert.match(body, /property="og:url" content="https:\/\/milkyway\.test\/share\//);

  const crawler = await postShareResponse(`https://milkyway.test/share/${P(10)}`, P(10), 'WhatsApp');
  const crawlerBody = await crawler.text();
  assert.doesNotMatch(crawlerBody, /http-equiv="refresh"/);
  assert.match(crawlerBody, /property="og:image" content="https:\/\/x\/post\.webp"/);
});

test('feed cursor resumes right after the last returned post', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: P(i + 1), author_id: A, caption: '', media_url: null, media_type: null, created_at: `2026-11-14T0${9 - i}:00:00Z` }));
  fakeSupabase([['/rest/v1/mw_posts?', rows], ['/rpc/mw_privacy_flags', {}]]);
  const { payload } = await call({ action: 'page', limit: '4', before: '2026-11-15T00:00:00Z' });
  assert.equal(payload.posts.length, 4);
  assert.equal(payload.next, payload.posts[3].createdAt);
});

test('Orbit feed falls back to core post columns when slideshow columns are absent', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/auth/v1/user')) return new Response('{}', { status: 401 });
    if (address.includes('/rest/v1/mw_posts?')) {
      if (address.includes('media_items')) {
        return new Response(JSON.stringify({ message: "Could not find the 'media_items' column of 'mw_posts' in the schema cache" }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([{
        id: P(4), author_id: A, author_name: 'Asha', caption: 'Existing post',
        media_url: null, media_type: null, created_at: '2026-11-14T10:00:00Z',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload.posts.map(post => post.id), [P(4)]);
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 2);
  assert.match(calls[0], /media_items/);
  assert.doesNotMatch(calls[1], /media_items|audio_url|slideshow_style/);
  assert.doesNotMatch(calls[1], /author_id=/, 'the For You query remains global');
});

test('Orbit feed falls back when scheduled_at is absent from an older posts schema', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/auth/v1/user')) return new Response('{}', { status: 401 });
    if (address.includes('/rest/v1/mw_posts?') && address.includes('scheduled_at')) {
      return new Response(JSON.stringify({ message: "Could not find the 'scheduled_at' column of 'mw_posts' in the schema cache" }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (address.includes('/rest/v1/mw_posts?')) return new Response('[]', { status: 200 });
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload, { posts: [], next: null });
  assert.equal(calls.filter(url => url.includes('/rest/v1/mw_posts?')).length, 2);
  assert.match(calls[0], /scheduled_at/);
  assert.doesNotMatch(calls[1], /scheduled_at/);
  assert.doesNotMatch(calls[1], /author_id=/, 'the For You query remains global');
});

test('Orbit feed treats an empty posts table as a successful empty page', async () => {
  fakeSupabase([['/rest/v1/mw_posts?', []]]);
  const { status, payload } = await call({ action: 'page', scope: 'foryou', limit: '5' });
  assert.equal(status, 200);
  assert.deepEqual(payload, { posts: [], next: null });

  const strings = readFileSync(new URL('../milkyway/app/core/i18n.js', import.meta.url), 'utf8');
  assert.match(strings, /empty:\s*'No posts yet\. Be the first to post!'/);
});

test('Orbit feed subscribes to global post changes and Supabase publishes mw_posts', () => {
  const feed = readFileSync(new URL('../milkyway/app/data/feed.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261116_milkyway_orbit_feed_realtime.sql', import.meta.url), 'utf8');
  const repository = readFileSync(new URL('../api/milkyway-feed.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../milkyway/app/core/sync.js', import.meta.url), 'utf8');
  assert.match(feed, /table:\s*'mw_posts'/);
  assert.match(feed, /active\?\.refresh\(\)/);
  assert.match(repository, /scope === 'following'[\s\S]*author_id=\$\{inList\(authors\)\}/);
  assert.match(repository, /public feed includes every author|POST_FIELDS/);
  assert.match(migration, /using \(public\.mw_profile_posts_visible\(author_id::text\)\)/);
  assert.doesNotMatch(migration, /using\s*\(true\)/i, 'public posts must continue to respect account privacy');
  assert.match(migration, /alter table public\.mw_posts enable row level security/i);
  assert.match(migration, /grant select on public\.mw_posts to anon, authenticated/i);
  assert.match(migration, /mw_posts_orbit_read/);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_posts/i);
  assert.match(view, /source\.load\(\)\.then\(\(\) => source\.refresh\(\)\)/);
  assert.match(view, /source\?\.source\.error[\s\S]*feedLoadFailed/);
  assert.match(sync, /get error\(\) \{ return error; \}/);
});

test('DM call schema migration repairs call columns and reloads PostgREST schema', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261123_milkyway_dm_calls_schema.sql', import.meta.url), 'utf8');
  for (const column of ['caller_id', 'callee_id', 'created_at', 'status']) {
    assert.match(migration, new RegExp(`add column if not exists ${column}\\b`, 'i'));
  }
  assert.match(migration, /created_at set not null/i);
  assert.match(migration, /status set not null/i);
  assert.match(migration, /mw_dm_calls_incoming_idx/);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});

test('LIVE room member updated_at is selected, repaired, and reloaded into PostgREST cache', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261124_milkyway_live_member_updated_at.sql', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/milkyway-live-room.js', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists updated_at timestamptz/i);
  assert.match(migration, /set updated_at = now\(\)\s+where updated_at is null/i);
  assert.match(migration, /alter column updated_at set default now\(\)/i);
  assert.match(migration, /alter column updated_at set not null/i);
  assert.match(migration, /mw_live_room_members_updated_idx/);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(api, /mw_live_room_members\?[^`]*select=room_name,user_id,name,avatar,state,host_muted,updated_at&order=updated_at\.desc/);
});

test('LIVE room UPSERT targets have unique indexes after duplicate rows are reconciled', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_live_upsert_keys.sql', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/milkyway-live-room.js', import.meta.url), 'utf8');
  assert.match(api, /mw_live_room_members\?on_conflict=room_name,user_id/);
  assert.match(api, /mw_live_room_settings\?on_conflict=room_name/);
  assert.match(migration, /partition by room_name, user_id[\s\S]*row_number > 1/);
  assert.match(migration, /create unique index if not exists mw_live_room_members_room_user_uidx[\s\S]*on public\.mw_live_room_members \(room_name, user_id\)/i);
  assert.match(migration, /partition by room_name[\s\S]*row_number > 1/);
  assert.match(migration, /create unique index if not exists mw_live_room_settings_room_name_uidx[\s\S]*on public\.mw_live_room_settings \(room_name\)/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});

test('DM call connection uses authenticated LiveKit tokens and reports server configuration failures', () => {
  const callView = readFileSync(new URL('../milkyway/app/ui/call-view.js', import.meta.url), 'utf8');
  const callCss = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  const liveKit = readFileSync(new URL('../api/_lib/livekit.js', import.meta.url), 'utf8');
  const callApi = readFileSync(new URL('../api/milkyway-call.js', import.meta.url), 'utf8');
  const translations = readFileSync(new URL('../milkyway/app/core/i18n.js', import.meta.url), 'utf8');
  assert.match(callApi, /livekitConfigurationError\(ctx\.env\)/);
  assert.doesNotMatch(callApi, /functions\/v1\/livekit-token/);
  assert.match(callApi, /serverUrl:\s*livekitUrl\(ctx\.env\)/);
  assert.match(callApi, /const dmRoomName = call => `dm-call-/);
  assert.match(callApi, /const roomName = dmRoomName\(call\)/);
  assert.match(liveKit, /LIVEKIT_URL.*LIVEKIT_API_KEY.*LIVEKIT_API_SECRET/);
  assert.match(liveKit, /const validLivekitUrl = environment =>/);
  assert.match(liveKit, /environment \? environment\[name\] \?\? '' : process\.env\[name\]/);
  assert.match(liveKit, /ctx\.env/);
  assert.match(liveKit, /url\.pathname === '\/'.*!url\.username/);
  assert.match(callView, /callAccessToken\(roomName, this\.call\.id, auth\.name\)/);
  assert.match(callApi, /offer: \{ transport: 'livekit', mode: callType, callType, videoEnabled, name \}/);
  assert.match(callApi, /payload: \{ id, kind, callType, videoEnabled: callType === 'video' \}/);
  assert.match(callApi, /roomJoin: true, canSubscribe: true, canPublishData: true, canPublish/);
  assert.match(callView, /callTypeOf = call => .*videoEnabled/);
  assert.match(callView, /this\.camOn = this\.callType === 'video'/);
  assert.match(callView, /callType, videoEnabled, name: auth\.name/);
  assert.match(callView, /#startRingtone/);
  assert.match(callView, /#stopRingtone/);
  assert.match(callView, /track\.attach\(element\)/);
  assert.match(callView, /element\.autoplay = true/);
  assert.match(callView, /element\.playsInline = true/);
  assert.match(callView, /#showMediaError\(error, 'camera publishing'\)/);
  assert.match(callView, /#showMediaError\(error, 'camera toggle'\)/);
  assert.match(callView, /CALL_TOKEN_ENDPOINT = `\$\{config\.api\.base\}\/milkyway-call\?action=token`/);
  assert.match(callView, /action === 'token' \? CALL_TOKEN_ENDPOINT/);
  assert.match(callView, /\.\.\.\(action === 'token' \? \{ cache: 'no-store' \} : \{\}\)/);
  assert.match(callView, /participantIdentity: auth\.userId/);
  assert.match(callView, /roomName: this\.roomName/);
  assert.match(callView, /errorCode: callErrorCode\(error\)/);
  assert.match(callView, /console\.error\(`\[call\] \$\{operation\} failed`, diagnostics, error\)/);
  assert.match(callView, /this\.errorMessage\.textContent = `\$\{operation === 'camera publishing'/);
  assert.match(callView, /insufficient permissions\\D\*\(\\d\+\)/);
  assert.doesNotMatch(callCss, /\.call-layer\[data-mode="audio"\] \.call-local/);
  assert.doesNotMatch(callView, /await directCallToken/);
  assert.doesNotMatch(callView, /directTokenEndpoint|directCallToken/);
  assert.match(callView, /await room\.connect\(access\.serverUrl, access\.token/);
  assert.match(callView, /setMicrophoneEnabled\(this\.micOn\)/);
  assert.match(callView, /setCameraEnabled\(this\.camOn/);
  assert.match(callView, /await room\.localParticipant\.setCameraEnabled\(true,[\s\S]*?#showMediaError\(error, 'camera publishing'\)/);
  assert.match(callView, /publication\.track\?\.detach\(\)/);
  assert.match(callView, /room\.disconnect\(\)/);
  assert.match(callView, /playAudioBtn/);
  assert.match(callView, /#enableRemoteAudio/);
  assert.match(callView, /assertRoomAccess/);
  assert.match(callView, /isUsageLimitError/);
  assert.match(callView, /LiveKit usage limit reached/);
  assert.doesNotMatch(callView, /if \(isUsageLimitError\(error\)\) throw error/);
  assert.match(callView, /const access = await callApi\('token', \{ id: callId, name \}\)/);
  assert.match(callView, /this\.retryBtn\.hidden = false/);
  assert.doesNotMatch(callView, /this\.hangUp\('disconnected'\)/);
  assert.match(callView, /callServiceLimited/);
  assert.match(liveKit, /management API usage limit reached/);
  assert.match(translations, /callServiceLimited:/);
});

test('profile post queries fall back across optional schema columns and normalize absent media', () => {
  const profile = readFileSync(new URL('../milkyway/app/ui/profile-view.js', import.meta.url), 'utf8');
  assert.match(profile, /PROFILE_POST_REQUIRED = \['id', 'author_id', 'caption', 'media_url', 'media_type', 'created_at'\]/);
  assert.match(profile, /PROFILE_POST_OPTIONAL = \['scheduled_at', 'slideshow_style', 'audio_url', 'media_items', 'media_preview_items'\]/);
  assert.match(profile, /missingProfileColumn\(result\.error, optional\)/);
  assert.match(profile, /optional\.splice\(optional\.indexOf\(missing\), 1\)/);
  assert.match(profile, /Array\.isArray\(result\.data\) \? result\.data : \[\]/);
  assert.match(profile, /media_url: mediaUrl, media_type: mediaType, media_items: mediaItems, media_preview_items: previews/);
  assert.match(profile, /Array\.isArray\(post\.media_preview_items\)/);
  assert.match(profile, /postsError \|\| t\('retry'\)/);
});

test('profile photo upload is scoped, saved to the profile, and refreshed in the shared cache', () => {
  const profileView = readFileSync(new URL('../milkyway/app/ui/profile-view.js', import.meta.url), 'utf8');
  const profileData = readFileSync(new URL('../milkyway/app/data/profiles.js', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../milkyway/app/ui/settings-view.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261206_milkyway_profile_avatar_storage.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(profileView, /event\.currentTarget\.files\?\.\[0\] \|\| null/);
  assert.match(profileView, /PROFILE_PHOTO_TYPES = new Set\(\['image\/jpeg', 'image\/png', 'image\/webp', 'image\/heic'/);
  assert.match(profileView, /storage\.from\('portfolio'\)\.upload\(uploadedPath, selectedPhoto/);
  assert.match(profileView, /changes\.avatar_url = avatarUrl/);
  assert.match(profileView, /profiles\.update\(updatedProfile\)/);
  assert.match(profileView, /profile-avatar-shortcut/);
  assert.match(profileView, /openFilePicker\(photoInput\)/);
  assert.match(profileView, /openForPhoto\(file\)/);
  assert.match(profileData, /bus\.emit\('profile', profile\)/);
  assert.match(settings, /bus\.on\('profile'/);
  assert.match(settings, /nova-profile-photo-button/);
  assert.match(settings, /openFilePicker\(this\.photoShortcutInput\)/);
  assert.match(main, /openProfilePhoto: file =>[\s\S]*view\.openForPhoto\(file\)/);
  assert.match(migration, /on conflict \(id\) do update set public = true/i);
  assert.match(migration, /\(storage\.foldername\(name\)\)\[2\] = auth\.uid\(\)::text/);
  assert.match(repair, /mw_profile_avatar_insert/);
});

test('media picker detects device file extensions and signatures when MIME types are missing', async () => {
  assert.deepEqual(mediaInfo({ name: 'camera.HEIC', type: '' }), { kind: 'image', type: 'image/heic', extension: 'heic' });
  assert.deepEqual(mediaInfo({ name: 'clip.MOV', type: 'application/octet-stream' }), { kind: 'video', type: 'video/quicktime', extension: 'mov' });
  const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
  Object.defineProperty(png, 'name', { value: 'camera-file' });
  assert.deepEqual(await identifyMediaFile(png), { kind: 'image', type: 'image/png', extension: 'png' });
  const heic = new Blob([new TextEncoder().encode('0000ftypheix0000')]);
  Object.defineProperty(heic, 'name', { value: 'camera-file' });
  assert.deepEqual(await identifyMediaFile(heic), { kind: 'image', type: 'image/heic', extension: 'heic' });
  let clicked = false;
  openFilePicker({ showPicker() { throw new Error('Unsupported in this WebView.'); }, click() { clicked = true; } });
  assert.equal(clicked, true);
});

test('compose upload normalizes MIME type and reports storage transport errors with upload phase', () => {
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const optimizer = readFileSync(new URL('../milkyway/app/core/media-optimizer.js', import.meta.url), 'utf8');
  assert.match(compose, /identifyMediaFile\(file\)/);
  assert.match(compose, /contentType: info\.type/);
  assert.match(compose, /openFilePicker\(input\)/);
  assert.match(compose, /postNetworkFailed'\)\} \(\$\{phase\}\): \$\{message/);
  assert.match(optimizer, /decodeImage\(file\)/);
  assert.match(optimizer, /isHeic/);
  assert.match(optimizer, /video\.videoWidth > 4096 \|\| video\.videoHeight > 4096/);
  assert.match(optimizer, /messageerror/);
  assert.match(optimizer, /Timed out while preparing the selected photo/);
});

test('DM room cleanup RPC is installed and token issuance avoids cleanup management calls', () => {
  const cleanupMigration = readFileSync(new URL('../supabase/migrations/20261127_milkyway_room_cleanup_enqueue_schema_cache.sql', import.meta.url), 'utf8');
  const cleanupRepair = readFileSync(new URL('../supabase/migrations/20261128_milkyway_room_cleanup_enqueue_repair.sql', import.meta.url), 'utf8');
  const dmRoomsMigration = readFileSync(new URL('../supabase/migrations/20261213_milkyway_dm_livekit_rooms.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const callApi = readFileSync(new URL('../api/milkyway-call.js', import.meta.url), 'utf8');
  const livekit = readFileSync(new URL('../api/_lib/livekit.js', import.meta.url), 'utf8');
  assert.match(cleanupMigration, /create or replace function public\.mw_room_cleanup_enqueue\(p_room_name text\)/i);
  assert.match(cleanupMigration, /grant execute on function public\.mw_room_cleanup_enqueue\(text\) to authenticated/i);
  assert.match(cleanupMigration, /notify pgrst, 'reload schema'/i);
  assert.match(cleanupRepair, /create or replace function public\.mw_room_cleanup_enqueue\(p_room_name text\)/i);
  assert.match(cleanupRepair, /notify pgrst, 'reload schema'/i);
  assert.match(repair, /create or replace function public\.mw_room_cleanup_enqueue\(p_room_name text\)/i);
  assert.match(dmRoomsMigration, /dm-call-\[a-f0-9\]/);
  assert.match(dmRoomsMigration, /room_users\[1\]::uuid < room_users\[2\]::uuid/);
  assert.match(repair, /supabase\/migrations\/20261213_milkyway_dm_livekit_rooms\.sql/);
  assert.match(repair, /room_users\[1\]::uuid < room_users\[2\]::uuid/);
  assert.doesNotMatch(callApi, /retryRoomCleanups/);
  assert.match(callApi, /closeRoom\(ctx, oldRoom, \{ immediate: false \}\)/);
  assert.match(callApi, /closeRoom\(ctx, dmRoomName\(call\), \{ immediate: false \}\)/);
  assert.match(livekit, /if \(!immediate\) return false/);
});

test('LiveKit access tokens are pinned to the expected room and server across fallbacks', () => {
  const claims = Buffer.from(JSON.stringify({ video: { room: 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roomJoin: true } })).toString('base64url');
  const access = {
    token: `header.${claims}.signature`,
    roomName: 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serverUrl: 'wss://live.example.test',
  };
  assert.equal(assertRoomAccess(access, access.roomName, 'wss://live.example.test/'), access);
  assert.throws(() => assertRoomAccess(access, 'mw-video-live-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), /different room/);
  assert.throws(() => assertRoomAccess(access, access.roomName, 'wss://other.example.test'), /different server/);
});

test('LIVE and DM calls keep LiveKit default ICE and retry only in their assigned room', () => {
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  const callView = readFileSync(new URL('../milkyway/app/ui/call-view.js', import.meta.url), 'utf8');
  assert.match(liveSession, /assertRoomAccess\(payload, live\.room\)/);
  assert.match(liveSession, /assertRoomAccess\(fresh, this\.live\.room, token\.serverUrl\)/);
  assert.match(liveSession, /\.on\(RoomEvent\.Reconnecting/);
  assert.match(liveSession, /async reconnect\(\)/);
  assert.match(callView, /assertRoomAccess\(retry, roomName, access\.serverUrl\)/);
  assert.match(callView, /RoomEvent\.Reconnecting/);
  assert.match(callView, /this\.#showConnectionError\(new Error\(`LiveKit disconnected/);
  assert.doesNotMatch(liveSession + callView, /iceServers\s*:/);
});

test('feed videos use tap-to-show scrubbers and post photos pinch to zoom', () => {
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const pager = readFileSync(new URL('../milkyway/app/ui/pager.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(feed, /class: 'video-seek', type: 'range'/);
  assert.match(feed, /video\.currentTime = video\.duration \* Number\(seek\.value\) \/ 1000/);
  assert.match(feed, /this\.#showVideoControls\(slide\)/);
  assert.match(feed, /}, 2600\)/);
  assert.doesNotMatch(feed, /video-seek-btn|currentTime \+ seconds/);
  assert.match(styles, /\.slide\.controls-visible \.video-controls/);
  assert.doesNotMatch(styles, /\.video-controls \{[^}]*backdrop-filter/);
  assert.match(feed, /media\.addEventListener\('pointerdown'/);
  assert.match(feed, /Math\.min\(4, imagePinch\.scale/);
  assert.match(pager, /event\.isPrimary === false/);
  assert.match(pager, /\.image-zoomed/);
  assert.match(viewer, /pointerdown/);
  assert.match(viewer, /this\.#pointerDistance\(\)/);
  assert.match(viewer, /Math\.min\(4,/);
  assert.match(viewer, /this\.image\.style\.scale/);
  assert.match(viewer, /this\.image\.style\.translate/);
  assert.match(styles, /\.pv-media\.has-image \{ touch-action: none; \}/);
});

test('LIVE guest stage grants publisher permissions and renders allocated guest seats', () => {
  const roomApi = readFileSync(new URL('../api/milkyway-live-room.js', import.meta.url), 'utf8');
  const tokenApi = readFileSync(new URL('../api/milkyway-livekit-token.js', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const liveControls = readFileSync(new URL('../milkyway/app/ui/live-controls.js', import.meta.url), 'utf8');
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  const seatAllocation = readFileSync(new URL('../supabase/migrations/20261205_milkyway_live_guest_seat_allocation.sql', import.meta.url), 'utf8');
  assert.match(roomApi, /setPublish\(room\.roomName, userId, true, room\.audio\)/);
  assert.match(roomApi, /canPublish: sources\.length > 0, canPublishData: true, canPublishSources: sources/);
  assert.match(tokenApi, /const approvedGuest = !isHost && member\?\.state === 'speaker'/);
  assert.doesNotMatch(tokenApi, /body\.stage === true[\s\S]*member\?\.state === 'speaker'/);
  assert.match(tokenApi, /approvedGuest \? \(audio \? \(member\.host_muted \? \[\] : \[MIC\]\) : \(member\.host_muted \? \[CAMERA\] : \[CAMERA, MIC\]\)\)/);
  const stageButton = liveView.match(/function paintStageButton\(slide, session\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(stageButton, /r\.stageBtn\.disabled = stage === 'joining' \|\| !!session\.stageAction/);
  assert.doesNotMatch(stageButton, /allowRequests|admission|canAsk/);
  assert.match(liveView, /const guestSeats = settings\.showGuestSlots[\s\S]*data-seat/);
  assert.match(liveView, /\['approval', t\('admissionApproval'\)\], \['open', t\('admissionDirect'\)\]/);
  assert.match(liveControls, /\['approval', t\('admissionApproval'\)\], \['open', t\('admissionDirect'\)\]/);
  assert.match(roomApi, /settings\.admission === 'open'[\s\S]*mw_live_room_allocate_guest_seat/);
  assert.match(seatAllocation, /for update[\s\S]*seated_count >= seat_limit[\s\S]*state = 'speaker'/i);
  assert.match(liveControls, /toggleRow\(t\('showGuestSlots'\)/);
  assert.match(liveSession, /adaptiveStream: true,[\s\S]*dynacast: true,[\s\S]*publishDefaults:/);
  assert.match(liveSession, /static warm\(live\)/);
});

test('LIVE hidden-tab lifecycle rests viewers, keeps audio during grace, and ends inactive hosts', () => {
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../milkyway/app/config.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  assert.match(config, /viewerHiddenGraceMs: 60_000/);
  assert.match(config, /hostHiddenGraceMs: 60_000/);
  assert.match(config, /hostIdleGraceMs: 300_000/);
  assert.match(liveView, /document\.addEventListener\('visibilitychange'/);
  assert.match(liveView, /window\.addEventListener\('blur'/);
  assert.match(liveView, /slide\.classList\.add\('resting'\)/);
  assert.match(liveView, /setTimeout\(\(\) => \{[\s\S]*this\.#leave\(\);[\s\S]*VIEWER_HIDDEN_GRACE_MS/);
  assert.match(liveView, /HOST_HIDDEN_GRACE_MS/);
  assert.match(liveView, /HOST_IDLE_GRACE_MS/);
  assert.match(liveView, /const localLeave = session\.leave\(\);[\s\S]*session\.end\(\)\.catch[\s\S]*endSession\(room\)\.catch[\s\S]*await localLeave/);
  assert.match(liveView, /removeEventListener\('visibilitychange', onHostVisibility\)/);
  assert.match(css, /\.live-resting-art svg/);
  assert.match(css, /--mw-live-rest-image/);
  assert.match(index, /app\/app\.css\?v=30/);
  assert.match(worker, /milkyway-v241-guest-view-only/);
  assert.match(worker, /app\/app\.css\?v=30/);
});

test('LIVE settings persist guest slots and featured host backgrounds with schema repair', async () => {
  const hostId = A;
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const saved = [];
  globalThis.fetch = async (input, init = {}) => {
    const address = String(input);
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: hostId }), { status: 200 });
    if (address.includes('/mw_video_live_sessions?')) return new Response(JSON.stringify([{ id: P(1), host_id: hostId, is_live: true, title: 'Test' }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?room_name=') && init.method !== 'POST') return new Response(JSON.stringify([{ settings: { layout: 9 } }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?on_conflict=')) {
      saved.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected LIVE settings request: ${address}`);
  };
  const callSettings = async body => {
    let status = 200, payload;
    const response = { headersSent: false, setHeader() { return response; }, status(code) { status = code; return response; }, json(value) { payload = value; response.headersSent = true; return response; } };
    await liveRoom({ method: 'POST', headers: { authorization: 'Bearer test-token', apikey: 'test-public-key' }, query: {}, body: { action: 'settings', room, ...body } }, response);
    return { status, payload };
  };
  try {
    const result = await callSettings({ layout: 12, showGuestSlots: true, layoutStyle: 'featured', hostBackground: 'https://example.test/backdrop.mp4', hostBackgroundKind: 'video' });
    assert.equal(result.status, 200);
    assert.equal(saved[0].settings.layout, 9, 'the room allows at most eight guest seats');
    assert.equal(saved[0].settings.showGuestSlots, true);
    assert.equal(saved[0].settings.layoutStyle, 'featured');
    assert.equal(saved[0].settings.hostBackground, 'https://example.test/backdrop.mp4');
    assert.equal(saved[0].settings.hostBackgroundKind, 'video');
    assert.equal((await callSettings({ hostBackground: 'http://example.test/backdrop.mp4' })).status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_live_settings_host_id.sql', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists host_id uuid/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(liveView, /dataset\.layout = layoutStyle/);
  assert.match(liveView, /live-host-background/);
  assert.match(css, /grid-template-columns: minmax\(0, 2\.2fr\) minmax\(52px, \.8fr\)/);
});

test('composer and post viewer support client-assisted photo slideshows with optional audio', () => {
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const optimizer = readFileSync(new URL('../milkyway/app/core/media-optimizer.js', import.meta.url), 'utf8');
  const imageOptimizer = readFileSync(new URL('../milkyway/app/core/media-image.js', import.meta.url), 'utf8');
  const feedView = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const mediaMigration = readFileSync(new URL('../supabase/migrations/20261119_milkyway_media_previews.sql', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../milkyway/app/ui/profile-view.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  const transitions = readFileSync(new URL('../supabase/migrations/20261118_milkyway_slideshow_transitions.sql', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const giftTray = readFileSync(new URL('../milkyway/app/ui/gift-tray.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_post_slideshows.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(compose, /multiple:\s*true/);
  assert.match(compose, /MAX_PHOTOS = 8/);
  assert.match(compose, /createImageBitmap/);
  assert.match(compose, /value: 'page'.*stylePage/);
  assert.match(compose, /value: 'slide'.*styleSlide/);
  assert.match(compose, /media_items:\s*mediaItems,[\s\S]*audio_url,[\s\S]*slideshow_style/);
  assert.match(compose, /media_preview_items:\s*mediaPreviewItems/);
  assert.match(compose, /optimizeImage\(file\)/);
  assert.match(compose, /createVideoPreview\(videoFile\)/);
  assert.match(imageOptimizer, /MAX_IMAGE_EDGE = 2048/);
  assert.match(imageOptimizer, /PREVIEW_EDGE = 640/);
  assert.match(imageOptimizer, /fullBlob\.size < file\.size/);
  assert.match(optimizer, /video\.removeAttribute\('src'\)/);
  assert.match(feedView, /post\.media\.previewItems\?\.\[0\]/);
  assert.match(feedView, /: 'lazy'/);
  assert.match(mediaMigration, /add column if not exists media_preview_items jsonb not null default '\[\]'::jsonb/i);
  assert.match(mediaMigration, /notify pgrst, 'reload schema'/i);
  assert.match(viewer, /#stepImage\(delta\)/);
  assert.match(viewer, /#renderSoundtrack\(post\)/);
  assert.match(viewer, /#toggleSlideshow/);
  assert.match(viewer, /#preloadImages\(items, index\)/);
  assert.match(viewer, /preloaded\?\.decode\?\.\(\)/);
  assert.match(styles, /pv-image-page[\s\S]*@keyframes pvPageTurn/);
  assert.match(styles, /pv-image-slide[\s\S]*@keyframes pvSlide/);
  assert.match(profile, /PROFILE_POST_OPTIONAL = \['scheduled_at', 'slideshow_style', 'audio_url', 'media_items', 'media_preview_items'\]/);
  assert.match(profile, /media_preview_items/);
  assert.match(migration, /add column if not exists media_items jsonb/i);
  assert.match(migration, /add column if not exists audio_url text/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(transitions, /'fade', 'zoom', 'cinema', 'page', 'slide'/);
  assert.match(transitions, /validate constraint mw_posts_slideshow_style_check/i);
  assert.match(repair, /supabase\/migrations\/20261118_milkyway_slideshow_transitions\.sql/);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_post_slideshows.sql/);
  assert.match(liveView, /data-act': 'gift'[\s\S]*html: icon\.gift/);
  assert.match(liveView, /openGifts\(\{ room: live\.room, to: live\.host, session: this\.session \}\)/);
  assert.match(giftTray, /target\.session\.gift\(key\)/);
  assert.match(giftTray, /this\.sendButton = h\('button'.*t\('send'\)/);
  assert.match(giftTray, /open\(target\) \{[\s\S]*this\.sheet\.open\(\)/);
  assert.doesNotMatch(giftTray.match(/open\(target\) \{([\s\S]*?)\n  \}/)?.[1] || '', /ensureWalletProfile/);
  assert.match(giftTray, /#sendSelected\(\)[\s\S]*ensureWalletProfile/);
  assert.match(giftTray, /topUpPrompt.*hidden: true/);
  assert.match(giftTray, /error\?\.status === 402[\s\S]*topUpPrompt\.hidden = false/);
  assert.match(giftTray, /#select\(button\.dataset\.gift\)/);
});

test('post publishing migration and errors cover slideshow schema and network failures', () => {
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_post_slideshows.sql', import.meta.url), 'utf8');
  const publishMigration = readFileSync(new URL('../supabase/migrations/20261129_milkyway_post_publish_permissions.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists media_items jsonb not null default '\[\]'::jsonb/i);
  assert.match(migration, /add column if not exists audio_url text/i);
  assert.match(migration, /add column if not exists slideshow_style text not null default 'fade'/i);
  assert.match(migration, /validate constraint mw_posts_slideshow_style_check/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_post_slideshows\.sql/);
  assert.match(publishMigration, /grant insert \([\s\S]*scheduled_at[\s\S]*?\)\s*on public\.mw_posts to authenticated/i);
  assert.match(publishMigration, /create policy mw_posts_insert_own[\s\S]*author_id = \(select auth\.uid\(\)\)/i);
  assert.match(publishMigration, /coalesce\(\(to_jsonb\(profile\)->>'is_banned'\)::boolean, false\)/i);
  assert.match(repair, /supabase\/migrations\/20261129_milkyway_post_publish_permissions\.sql/);
  assert.match(compose, /\.select\('id,author_id,created_at'\)\.single\(\)/);
  assert.match(compose, /if \(!savedPost\?\.id \|\| savedPost\.author_id !== auth\.userId\)/);
  assert.match(compose, /const failedPhase = error\?\.publishPhase \|\| phase/);
  assert.match(compose, /postNetworkFailed/);
  assert.match(compose, /postSchemaFailed/);
  assert.match(compose, /console\.error\('\[compose\] post publication failed'/);
});

test('app shell has no render-blocking scripts and loads the core as a module', () => {
  const html = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 1);
  for (const attrs of scripts) assert.match(attrs, /type="module"/, 'every script is a deferred ES module');
  assert.match(html, /app\/main\.js/);
  assert.doesNotMatch(html, /supabase-js|livekit-client/, 'SDKs load lazily, never from the shell');
});

test('Explore video tiles fall back to extracted frames and retain a dark creator placeholder', () => {
  const discovery = readFileSync(new URL('../milkyway/app/ui/discovery-view.js', import.meta.url), 'utf8');
  const media = readFileSync(new URL('../milkyway/app/core/media.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  assert.match(discovery, /extractVideoThumbnail\(media\.url\)/);
  assert.match(discovery, /media\?\.previewItems\?\.\[0\]/);
  assert.match(discovery, /mediaKind\(post\) === 'video'/);
  assert.match(discovery, /class:\s*'explore-post-author'/);
  assert.match(media, /video\.crossOrigin = 'anonymous'/);
  assert.match(media, /context\.drawImage\(video/);
  assert.match(media, /canvas\.toDataURL\('image\/jpeg'/);
  assert.match(styles, /\.explore-post\.is-video-fallback/);
  assert.match(styles, /\.explore-post\.is-video::after/);
  assert.match(styles, /\.explore-post-author/);
});

test('bottom navigation opens Explore discovery and keeps LIVE reachable outside the nav', () => {
  const html = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const navigation = html.match(/<nav class="bottombar"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.match(navigation, /data-nav="home"[\s\S]*data-nav="explore"/);
  assert.doesNotMatch(navigation, /data-nav="live"/);
  assert.match(navigation, /data-nav="explore"[\s\S]*data-i18n="explore">Explore/);
  assert.match(html, /id="exploreView"/);

  const main = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  const discovery = readFileSync(new URL('../milkyway/app/ui/discovery-view.js', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../milkyway/app/ui/settings-view.js', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  assert.match(main, /else if \(nav === 'explore'\) showExplore\(\)/);
  assert.match(main, /function showExplore\(\)[\s\S]*discoveryView\(\)\.then/);
  assert.match(discovery, /searchPeople\(query\)/);
  assert.match(discovery, /HASHTAG/);
  assert.match(discovery, /post\.media\?\.audioUrl/);
  assert.match(discovery, /action: 'page'/);
  assert.match(settings, /querySelector\('#liveEntry'\)/);
  assert.match(serviceWorker, /app\/ui\/discovery-view\.js/);
});

test('homepage APK download is a native static-file link', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="appDownload" href="\/MilkyWay\.apk" download="MilkyWay\.apk"/);
  assert.doesNotMatch(html, /apk-link\.js/);
  const build = readFileSync(new URL('./build-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(build, /copyFileSync\(join\(downloads, 'MilkyWay\.apk'\), join\(out, 'MilkyWay\.apk'\)\)/);
  assert.match(build, /url: versionedApkUrl, apk: versionedApkUrl/);
  assert.match(build, /const homepage = join\(out, 'index\.html'\)/);
  assert.match(build, /versionedApkUrl\}"/);
  assert.match(build, /Accept-Ranges: bytes/);
  assert.match(build, /\/MilkyWay\.apk\n  Content-Type: application\/vnd\.android\.package-archive\n  Content-Disposition: attachment; filename="MilkyWay\.apk"\n  Accept-Ranges: bytes\n  Cache-Control: no-cache, no-transform/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/MilkyWay\.apk'.*sendFile/);
  assert.match(server, /'Content-Type': 'application\/vnd\.android\.package-archive'/);
});

test('mobile homepage keeps its content and shows a direct APK download button', () => {
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(homepage, /location\.replace\('\/milkyway\//);
  assert.match(homepage, /class="mobile-apk-download" href="\/MilkyWay\.apk" download="MilkyWay\.apk" type="application\/vnd\.android\.package-archive"/);
  assert.match(homepage, /Download Android App \(APK\)/);
  assert.match(homepage, /@media \(max-width: 767px\)[\s\S]*?\.mobile-apk-download\s*\{[^}]*position: fixed/);
  assert.match(serviceWorker, /version: 'v14'/);
});

test('share sheets fit the screen and support native sharing or copy fallback', () => {
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const share = readFileSync(new URL('../milkyway/app/ui/share-sheet.js', import.meta.url), 'utf8');
  const sheet = readFileSync(new URL('../milkyway/app/ui/sheet.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  for (const source of [feed, viewer, live]) assert.match(source, /openShare\(/);
  assert.match(share, /platformOptions\(current\)/);
  assert.match(share, /https:\/\/wa\.me\/\?text=/);
  assert.match(share, /facebook\.com\/sharer\/sharer\.php/);
  assert.match(share, /https:\/\/t\.me\/share\/url/);
  assert.match(share, /twitter\.com\/intent\/tweet/);
  assert.match(share, /sms:\?body=/);
  for (const platform of ['WhatsApp', 'Facebook', 'Telegram', 'X', 'sms']) assert.match(share, new RegExp(platform, 'i'));
  assert.match(share, /share-option/);
  assert.match(share, /capacitor\.Plugins\?\.Share \|\| capacitor\.registerPlugin\?\.\('Share'\)/);
  assert.match(share, /plugin\.share\(\{ \.\.\.data, dialogTitle: t\('share'\) \}\)/);
  assert.match(share, /navigator\.canShare/);
  assert.match(share, /result = navigator\.share\(data\)/);
  assert.match(share, /native\.addEventListener\('click', \(\) => shareWithDevice\(tray\)\)/);
  assert.match(share, /navigator\.clipboard\?\.writeText/);
  assert.match(share, /document\.execCommand\('copy'\)/);
  assert.match(share, /autoFocus: false/);
  assert.match(sheet, /if \(this\.autoFocus\)/);
  assert.match(sheet, /constructor\(\{ title = '', className = '', onClose, autoFocus = true \}/);
  assert.match(styles, /\.share-sheet/);
  assert.match(feed, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(feed, /video\.addEventListener\('error'/);
  assert.match(viewer, /video\.addEventListener\('error'/);
  assert.match(viewer, /mediaPlaceholder\(t\('imageUnavailable'\)\)/);
  assert.match(styles, /\.media-missing-icon/);
});

test('LIVE settings schema and follower post notifications have an idempotent Realtime migration', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261117_milkyway_live_settings_and_post_notifications.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const notifications = readFileSync(new URL('../milkyway/app/data/post-notifications.js', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists settings jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /having count\(distinct host_id\) = 1/i);
  assert.match(migration, /create policy mw_live_settings_host[\s\S]*mw_is_live_host\(room_name\)[\s\S]*host_id = auth\.uid\(\)/i);
  assert.match(migration, /create table if not exists public\.mw_post_notifications/i);
  assert.match(migration, /create trigger mw_posts_notify_followers/i);
  assert.match(migration, /follow\.following_id::text = new\.author_id::text/i);
  assert.match(migration, /recipient_id = auth\.uid\(\)/i);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_post_notifications/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(repair, /supabase\/migrations\/20261117_milkyway_live_settings_and_post_notifications\.sql/);
  assert.match(notifications, /table: 'mw_post_notifications'/);
  assert.match(notifications, /filter: `recipient_id=eq\.\$\{currentRecipient\}`/);
  assert.match(entry, /import\('\.\/data\/post-notifications\.js'\)/);
});

test('LIVE room table privileges are granted to authenticated users and limited to active rooms by RLS', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261125_milkyway_live_room_rls.sql', import.meta.url), 'utf8');
  const requestMigration = readFileSync(new URL('../supabase/migrations/20261130_milkyway_live_member_request_rls.sql', import.meta.url), 'utf8');
  const requestRpc = readFileSync(new URL('../supabase/migrations/20261130_milkyway_live_guest_request_rpc.sql', import.meta.url), 'utf8');
  const requestRpcUuidFix = readFileSync(new URL('../supabase/migrations/20261201_milkyway_live_guest_request_uuid_fix.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  const roomApi = readFileSync(new URL('../api/milkyway-live-room.js', import.meta.url), 'utf8');
  assert.match(migration, /grant select, insert, update, delete[\s\S]*mw_live_room_settings, public\.mw_live_room_members, public\.mw_live_room_messages[\s\S]*to authenticated/i);
  assert.match(migration, /create or replace function public\.mw_live_room_is_active\(room text\)[\s\S]*session\.is_live is true/i);
  assert.match(migration, /create policy mw_live_members_self[\s\S]*user_id = auth\.uid\(\)[\s\S]*state in \('viewer', 'pending'\)/i);
  assert.match(migration, /create policy mw_live_members_host[\s\S]*mw_live_room_is_active\(room_name\)[\s\S]*mw_is_live_host\(room_name\)/i);
  assert.match(migration, /create policy mw_live_messages_delete_host[\s\S]*for delete to authenticated[\s\S]*mw_is_live_host\(room_name\)/i);
  assert.match(requestMigration, /create policy mw_live_members_self_insert[\s\S]*for insert to authenticated[\s\S]*state in \('viewer', 'pending'\)/i);
  assert.match(requestMigration, /create policy mw_live_members_self_update[\s\S]*for update to authenticated[\s\S]*state in \('viewer', 'pending'\)/i);
  assert.match(requestMigration, /create policy mw_live_members_host_update[\s\S]*for update to authenticated[\s\S]*mw_is_live_host\(room_name\)/i);
  assert.match(requestRpc, /create or replace function public\.mw_live_room_request\([\s\S]*security definer[\s\S]*auth\.uid\(\)[\s\S]*session\.is_live is true[\s\S]*state = 'pending'/i);
  assert.match(requestRpc, /me text := auth\.uid\(\)::text/);
  assert.match(requestRpc, /select session\.host_id::text[\s\S]*if live_host = me/);
  assert.match(requestRpc, /member\.user_id::text = me/);
  assert.match(requestRpc, /room_settings -> 'blockedIds'.*lower\(me\)/);
  assert.match(requestRpc, /p_room_name, me::uuid,/);
  assert.match(requestRpcUuidFix, /me text := auth\.uid\(\)::text/);
  assert.match(requestRpcUuidFix, /member\.user_id::text = me::text/);
  assert.match(requestRpcUuidFix, /session\.host_id::text/);
  assert.match(requestRpcUuidFix, /session\.id::text[\s\S]*into live_host,\s*live_room_id/);
  assert.match(requestRpcUuidFix, /live_host::text = me::text/);
  assert.match(requestRpcUuidFix, /lower\(invite\.user_id_text::text\) = lower\(me::text\)/);
  assert.match(requestRpcUuidFix, /lower\(blocked\.user_id::text\) = lower\(me::text\)/);
  assert.match(requestRpcUuidFix, /room_id, room_name, user_id/);
  assert.match(requestRpcUuidFix, /live_room_id::uuid, p_room_name, me::uuid,/);
  assert.match(requestRpcUuidFix, /notify pgrst, 'reload schema'/i);
  assert.match(requestRpc, /grant execute on function public\.mw_live_room_request\(text, text, text\) to authenticated/i);
  assert.match(roomApi, /ctx\.rpc\('mw_live_room_request', \{[\s\S]*p_room_name: room\.roomName/);
  assert.match(repair, /supabase\/migrations\/20261130_milkyway_live_member_request_rls\.sql/);
  assert.match(repair, /supabase\/migrations\/20261130_milkyway_live_guest_request_rpc\.sql/);
  assert.match(repair, /supabase\/migrations\/20261125_milkyway_live_room_rls\.sql/);
});

test('LIVE host guest requests refresh from member realtime and expose accept and decline actions', () => {
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('../milkyway/app/ui/live-controls.js', import.meta.url), 'utf8');
  const liveView = readFileSync(new URL('../milkyway/app/ui/live-view.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261202_milkyway_live_member_realtime.sql', import.meta.url), 'utf8');
  const repair = readFileSync(new URL('../supabase/milkyway-schema-repair.sql', import.meta.url), 'utf8');
  assert.match(liveSession, /\.on\('postgres_changes',\s*\{[\s\S]*table: 'mw_live_room_members'[\s\S]*filter: `room_name=eq\.\$\{this\.live\.room\}`[\s\S]*this\.#refreshSoon\(\)/);
  assert.match(controls, /openGuests\(\)\s*\{[\s\S]*this\.guestSheet\.open\(\);[\s\S]*this\.session\.refresh\(\)/);
  assert.match(controls, /actionBtn\(t\('accept'\),\s*\(\) => run\(s, 'approve'/);
  assert.match(controls, /actionBtn\(t\('decline'\),\s*\(\) => run\(s, 'reject'/);
  assert.match(liveView, /approve\.addEventListener\('click'[\s\S]*handleRequestAction\(slide, session, 'approve'/);
  assert.match(liveView, /reject\.addEventListener\('click'[\s\S]*handleRequestAction\(slide, session, 'reject'/);
  assert.match(migration, /alter publication supabase_realtime add table public\.mw_live_room_members/i);
  assert.match(repair, /20261202_milkyway_live_member_realtime\.sql/);
});

test('LIVE guest request uses the authenticated request RPC and returns its persisted state', async () => {
  const viewerId = '22222222-2222-4222-8222-222222222222';
  const hostId = '11111111-1111-4111-8111-111111111111';
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const rpcCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const address = String(input);
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: viewerId }), { status: 200 });
    if (address.includes('/rest/v1/mw_video_live_sessions?')) {
      return new Response(JSON.stringify([{ host_id: hostId, scope: 'public', is_live: true }]), { status: 200 });
    }
    if (address.includes('/rest/v1/mw_live_room_settings?')) {
      return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
    }
    if (address.includes('/rest/v1/mw_live_room_members?')) return new Response('[]', { status: 200 });
    if (address.includes('/rest/v1/mw_profiles?')) {
      return new Response(JSON.stringify([{ display_name: 'Viewer', avatar_url: '' }]), { status: 200 });
    }
    if (address.includes('/rest/v1/rpc/')) {
      const body = JSON.parse(init.body || '{}');
      rpcCalls.push({ address, body });
      return new Response(JSON.stringify(address.endsWith('/mw_live_room_request') ? 'pending' : []), { status: 200 });
    }
    throw new Error(`Unexpected LIVE request API call: ${address}`);
  };

  try {
    let status = 200, payload;
    const response = {
      headersSent: false,
      setHeader() { return response; },
      status(code) { status = code; return response; },
      json(value) { payload = value; response.headersSent = true; return response; },
    };
    await liveRoom({
      method: 'POST',
      headers: { authorization: 'Bearer test-token', apikey: 'test-public-key' },
      query: {},
      body: { room, action: 'request' },
    }, response);
    assert.equal(status, 200);
    assert.deepEqual(payload, { state: 'pending', invited: false });
    assert.deepEqual(rpcCalls.at(-1), {
      address: 'https://wpclkhgizbvxuvbhbwzs.supabase.co/rest/v1/rpc/mw_live_room_request',
      body: { p_room_name: room, p_name: 'Viewer', p_avatar: '' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LIVE open admission allocates a stage seat without creating a pending request', async () => {
  const viewerId = '22222222-2222-4222-8222-222222222222';
  const hostId = '11111111-1111-4111-8111-111111111111';
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  const rpcCalls = [];
  const livekitCalls = [];
  process.env.LIVEKIT_URL = 'http://livekit.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  globalThis.fetch = async (input, init = {}) => {
    const address = String(input);
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: viewerId }), { status: 200 });
    if (address.includes('/rest/v1/mw_video_live_sessions?')) {
      return new Response(JSON.stringify([{ host_id: hostId, scope: 'public', is_live: true }]), { status: 200 });
    }
    if (address.includes('/rest/v1/mw_live_room_settings?')) {
      return new Response(JSON.stringify([{ settings: { admission: 'open', allowRequests: true, layout: 3 } }]), { status: 200 });
    }
    if (address.includes('/rest/v1/mw_live_room_members?')) return new Response('[]', { status: 200 });
    if (address.includes('/rest/v1/mw_profiles?')) {
      return new Response(JSON.stringify([{ display_name: 'Viewer', avatar_url: '' }]), { status: 200 });
    }
    if (address.includes('/twirp/livekit.RoomService/UpdateParticipant')) {
      livekitCalls.push({ address, body: JSON.parse(init.body || '{}') });
      return new Response('{}', { status: 200 });
    }
    if (address.includes('/rest/v1/rpc/')) {
      const body = JSON.parse(init.body || '{}');
      rpcCalls.push({ address, body });
      return new Response(JSON.stringify(address.endsWith('/mw_live_room_allocate_guest_seat') ? 'speaker' : []), { status: 200 });
    }
    throw new Error(`Unexpected open seating API call: ${address}`);
  };

  try {
    let status = 200, payload;
    const response = {
      headersSent: false,
      setHeader() { return response; },
      status(code) { status = code; return response; },
      json(value) { payload = value; response.headersSent = true; return response; },
    };
    await liveRoom({
      method: 'POST',
      headers: { authorization: 'Bearer open-seat-test-token', apikey: 'test-public-key' },
      query: {},
      body: { room, action: 'request' },
      headers: { authorization: `Bearer ${viewerId}`, apikey: 'test-public-key' },
    }, response);
    assert.equal(status, 200);
    assert.deepEqual(payload, { state: 'speaker', invited: false });
    assert.equal(livekitCalls.length, 1);
    assert.equal(livekitCalls[0].body.identity, viewerId);
    assert.ok(rpcCalls.some(call => call.address.endsWith('/mw_live_room_allocate_guest_seat')));
    assert.ok(!rpcCalls.some(call => call.address.endsWith('/mw_live_room_request')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('public Supabase content uses DOM text nodes and validates media URLs', () => {
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const publicMedia = readFileSync(new URL('../milkyway/public-media.js', import.meta.url), 'utf8');
  const publicArts = readFileSync(new URL('../milkyway/public-arts.js', import.meta.url), 'utf8');
  const artsChat = readFileSync(new URL('../milkyway/public-arts-chat.js', import.meta.url), 'utf8');
  const moderation = readFileSync(new URL('../milkyway/moderation.html', import.meta.url), 'utf8');
  assert.doesNotMatch(homepage, /innerHTML\s*=/);
  for (const source of [publicMedia, publicArts, artsChat]) {
    assert.doesNotMatch(source, /innerHTML\s*=|insertAdjacentHTML/);
    assert.match(source, /textContent/);
  }
  for (const source of [homepage, publicMedia, publicArts]) {
    assert.match(source, /https:/);
    assert.match(source, /safe\w*MediaUrl|safeMediaUrl/);
  }
  assert.doesNotMatch(moderation, /innerHTML\s*=/);
  assert.match(moderation, /textContent/);
});

test('registration prompts on protected actions without persistent guest feed buttons', () => {
  const auth = readFileSync(new URL('../milkyway/app/ui/auth-sheet.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../milkyway/index.html', import.meta.url), 'utf8');
  const authCss = readFileSync(new URL('../milkyway/app/app.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../milkyway/app/main.js', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const comments = readFileSync(new URL('../milkyway/app/ui/comments-sheet.js', import.meta.url), 'utf8');
  assert.match(auth, /auth\.signUp/);
  assert.match(auth, /emailRedirectTo/);
  assert.match(auth, /passwordMismatch/);
  assert.match(auth, /confirmEmailSent/);
  assert.match(auth, /auth-field-error/);
  assert.match(auth, /auth-close/);
  assert.match(auth, /this\.setMode\(mode === 'signup' \? 'signup' : 'signin'\)/);
  assert.doesNotMatch(shell, /data-auth-entry|class="auth-entry"/);
  assert.doesNotMatch(authCss, /\.auth-entry/);
  assert.match(main, /function showLive\(room = null\) \{\s*if \(!requireLogin\(\)\) return;/);
  assert.match(main, /function requireLogin\(force = false\) \{\s*if \(!force && auth\.signedIn\(\)\) return true;/);
  assert.match(main, /if \(target\.id === 'walkieEntry'\) \{\s*if \(requireLogin\(\)\)/);
  assert.match(main, /nav === 'inbox'.*requireLogin\(\)/);
  assert.match(main, /else if \(nav === 'me'\) openProfile\(\)/);
  assert.match(feed, /#like\(post, on\) \{\s*if \(!this\.hooks\.requireLogin\(\)\) return;/);
  assert.match(comments, /if \(!body \|\| !this\.requireLogin\(\)\) return;/);
  const policy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  const deletion = readFileSync(new URL('../account-deletion.html', import.meta.url), 'utf8');
  assert.match(policy, /account-deletion\.html/);
  assert.match(deletion, /mailto:masiyatunda@gmail\.com/);
  const appSettings = readFileSync(new URL('../milkyway/app/ui/settings-view.js', import.meta.url), 'utf8');
  assert.match(appSettings, /\/privacy\.html/);
  assert.match(appSettings, /\/account-deletion\.html/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('./build-cloudflare.mjs', import.meta.url), 'utf8');
  for (const page of ['privacy.html', 'account-deletion.html']) {
    assert.ok(server.includes(page), `${page} is served by server.js`);
    assert.ok(build.includes(page), `${page} is included in the static build`);
  }
});

test('feed likes and saves require sign-in, send authenticated writes, and preserve failed-write reasons', () => {
  const feedData = readFileSync(new URL('../milkyway/app/data/feed.js', import.meta.url), 'utf8');
  const feedView = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const postViewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const network = readFileSync(new URL('../milkyway/app/core/net.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/_lib/supa.js', import.meta.url), 'utf8');
  const saves = readFileSync(new URL('../api/_lib/saves.js', import.meta.url), 'utf8');
  const saveMigration = readFileSync(new URL('../supabase/migrations/20261115_milkyway_saves_rls.sql', import.meta.url), 'utf8');
  assert.match(feedView, /if \(act === 'save'\) \{ if \(this\.hooks\.requireLogin\(\)\)/);
  assert.match(feedView, /#like\(post, on\) \{\s*if \(!this\.hooks\.requireLogin\(\)\) return;/);
  assert.match(feedView, /if \(error\?\.status === 401 \|\| !auth\.signedIn\(\)\) \{ this\.hooks\.requireLogin\(true\); return; \}/);
  assert.match(postViewer, /if \(!post \|\| !this\.hooks\.requireLogin\?\.\(\)\) return;/);
  assert.match(postViewer, /if \(error\?\.status === 401 \|\| !auth\.signedIn\(\)\) \{ this\.hooks\.requireLogin\?\.\(true\); return; \}/);
  assert.match(feedData, /if \(!auth\.userId\) return Promise\.reject\(friendly\(\{ status: 401 \}/);
  assert.match(feedData, /rest\('mw_signals\?on_conflict=post_id,user_id,kind'.*body: \{ post_id: op\.post, user_id: op\.user, kind: 'light' \}/);
  assert.match(feedData, /api\(`\$\{config\.api\.feed\}\?action=save`, \{ method: 'POST', body: \{ post: op\.post, on: op\.on \}/);
  assert.match(feedData, /throw writeError\(error\)/);
  assert.match(feedData, /const writeError = error => error\?\.status === 401 \? friendly\(error, 'likeFailed'\) : error/);
  assert.match(feedData, /current\.liked === on \? previous : \{\}/);
  assert.match(feedData, /current\.saved === on \? \{ saved: wasSaved \} : \{\}/);
  assert.match(network, /if \(token\) init\.headers\.Authorization = `Bearer \$\{token\}`/);
  assert.match(network, /data\?\.details, data\?\.hint/);
  assert.match(api, /data\.details, data\.hint/);
  assert.match(api, /throw new ApiError\(status, message \|\| 'Request failed\.'/);
  assert.match(saves, /mw_saves\?on_conflict=post_id,user_id/);
  assert.match(saveMigration, /create unique index if not exists mw_saves_post_user_key on public\.mw_saves \(post_id, user_id\)/);
  assert.match(saves, /String\(error\?\.message \|\| 'Saved posts are unavailable right now\.'/);
});

test('LIVE token keeps viewers subscribed until the server records host approval', async () => {
  const hostId = '11111111-1111-4111-8111-111111111111';
  const viewerId = '22222222-2222-4222-8222-222222222222';
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  let memberState = 'pending';
  process.env.LIVEKIT_URL = 'wss://live.example.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  globalThis.fetch = async input => {
    const address = String(input);
    if (address.includes('/twirp/livekit.RoomService/ListRooms')) return new Response('{"rooms":[]}', { status: 200 });
    if (address.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: viewerId }), { status: 200 });
    if (address.includes('/mw_video_live_sessions?')) return new Response(JSON.stringify([{ host_id: hostId, scope: 'public', is_live: true }]), { status: 200 });
    if (address.includes('/mw_live_room_settings?')) return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
    if (address.includes('/mw_live_room_members?')) return new Response(JSON.stringify([{ state: memberState, host_muted: false }]), { status: 200 });
    if (address.includes('/mw_profiles?')) return new Response(JSON.stringify([]), { status: 200 });
    throw new Error(`Unexpected LIVE token request: ${address}`);
  };
  const call = async body => {
    let status = 200, payload;
    const response = { setHeader() { return response; }, status(code) { status = code; return response; }, json(value) { payload = value; return response; } };
    await livekitToken({ method: 'POST', headers: { authorization: 'Bearer test-user-token', apikey: 'test-public-key' }, body: { room, identity: viewerId, role: 'viewer', ...body } }, response);
    assert.equal(status, 200);
    return JSON.parse(Buffer.from(payload.token.split('.')[1], 'base64url').toString('utf8')).video;
  };

  try {
    assert.equal((await call({ stage: true })).canPublish, false, 'a viewer cannot self-promote by requesting a stage token');
    memberState = 'speaker';
    assert.equal((await call({ stage: true })).canPublish, true, 'the server grants publishing only after the member is approved');
    assert.equal((await call({})).canPublish, true, 'an approved guest receives publishing rights even without a client stage flag');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('service worker precaches every core module', () => {
  const sw = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  for (const folder of ['core', 'data', 'ui']) {
    for (const file of readdirSync(new URL(`../milkyway/app/${folder}/`, import.meta.url))) {
      assert.ok(sw.includes(`./app/${folder}/${file}`), `${folder}/${file} is precached`);
    }
  }
  assert.ok(sw.includes('./app/core/update-check.js'));
  assert.doesNotMatch(sw, /VIDEO_STORAGE/, 'video fetch handler uses the current storage URL matcher');
});

test('app checks deployment version without caching and offers refresh for stale clients', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ buildId: 'deploy-new' });
  };
  assert.equal(await checkDeployment('deploy-old', fetchImpl), 'deploy-new');
  assert.equal(await checkDeployment('deploy-new', fetchImpl), null);
  assert.equal(requests[0].init.cache, 'no-store');
  assert.match(requests[0].url, /\/milkyway\/app\/app-version\.json$/);

  const updater = readFileSync(new URL('../milkyway/app/core/update-check.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  const cache = readFileSync(new URL('../sw-cache.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../tools/build-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(updater, /registration\.update\(\)/);
  assert.match(updater, /controllerchange/);
  assert.match(updater, /mw-update-notice/);
  assert.match(worker, /update-check\.js/);
  assert.match(cache, /\['no-store', 'reload', 'no-cache'\]/);
  assert.match(cache, /async function freshAsset\(event, name\)/);
  assert.match(cache, /request\.destination === 'script' \|\| request\.destination === 'style'/);
  assert.match(cache, /fetch\(request, \{ cache: 'reload' \}\)/);
  assert.match(cache, /if \(saved\)\s*\{\s*keep\(event, refresh\.catch\(\(\) => \{\}\)\);\s*return saved;/);
  assert.match(build, /CF_PAGES_COMMIT_SHA/);
  assert.match(build, /app-version\.json/);
  assert.match(build, /versionedWorker/);
});

test('media uploads compress asynchronously and feed media is cached progressively', () => {
  const optimizer = readFileSync(new URL('../milkyway/app/core/media-optimizer.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../milkyway/app/core/media-worker.js', import.meta.url), 'utf8');
  const imageOptimizer = readFileSync(new URL('../milkyway/app/core/media-image.js', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../milkyway/app/ui/compose-sheet.js', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../milkyway/app/ui/feed-view.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../milkyway/app/ui/post-viewer.js', import.meta.url), 'utf8');
  const cache = readFileSync(new URL('../sw-cache.js', import.meta.url), 'utf8');
  const updater = readFileSync(new URL('../milkyway/app/core/update-check.js', import.meta.url), 'utf8');
  assert.match(optimizer, /new Worker\(new URL\('\.\/media-worker\.js'/);
  assert.match(optimizer, /export async function optimizeVideo/);
  assert.match(optimizer, /videoBitsPerSecond:\s*1_500_000/);
  assert.match(worker, /optimizeImageFile\(file\)/);
  assert.match(imageOptimizer, /new OffscreenCanvas/);
  assert.match(compose, /optimizeVideo\(selectedVideo/);
  assert.match(compose, /mapConcurrent\(this\.files,\s*2/);
  assert.match(feed, /r\.img\.loading = index === this\.pager\.index \? 'eager' : 'lazy'/);
  assert.match(viewer, /photoPreviewItems\(post\)\[index\]/);
  assert.match(viewer, /device\.saveData \? 0 : device\.slowNetwork \? 1 : 2/);
  assert.match(cache, /response\.ok \|\| response\.type === 'opaque'/);
  assert.match(cache, /cache\.put\(request, response\.clone\(\)\)/);
  assert.doesNotMatch(cache, /IMAGE_LIMIT|IMAGE_MAX_BYTES/);
  assert.match(cache, /address\.pathname\.startsWith\('\/storage\/v1\/object\/public\/portfolio\/'\)/);
  assert.match(updater, /navigator\.storage\?\.persist/);
});

test('provider keys are configured in one place', () => {
  const source = readFileSync(new URL('../milkyway/app/config.js', import.meta.url), 'utf8');
  for (const key of ['supabase', 'livekit', 'cloudinary', 'MW_CONFIG']) assert.ok(source.includes(key));
  assert.match(source, /import\.meta\.env\?\.VITE_SUPABASE_URL/);
  assert.match(source, /resolved\.livekit\.directTokenEndpoint/);
  for (const folder of ['core', 'data', 'ui']) {
    for (const file of readdirSync(new URL(`../milkyway/app/${folder}/`, import.meta.url))) {
      const code = readFileSync(new URL(`../milkyway/app/${folder}/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /sb_publishable_|supabase\.co/, `${folder}/${file} reads keys from config.js`);
    }
  }
});

test('Supabase URL environment is used by browser builds and server handlers', () => {
  const appConfig = readFileSync(new URL('../milkyway/app/config.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../tools/build-cloudflare.mjs', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../api/_lib/supa.js', import.meta.url), 'utf8');
  const edge = readFileSync(new URL('../supabase/functions/_shared/milkyway-token.ts', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../milkyway/sw.js', import.meta.url), 'utf8');
  const moderation = readFileSync(new URL('../milkyway/moderation.html', import.meta.url), 'utf8');
  assert.match(build, /process\.env\.VITE_SUPABASE_URL/);
  assert.match(build, /process\.env\.SUPABASE_URL/);
  assert.match(build, /without quotes or brackets/);
  assert.match(build, /window\.MW_CONFIG/);
  assert.match(adapter, /'VITE_SUPABASE_URL'/);
  assert.match(edge, /Deno\.env\.get\('VITE_SUPABASE_URL'\)/);
  assert.match(appConfig, /normalizeSupabaseUrl/);
  assert.match(serviceWorker, /isPublicStorageUrl/);
  assert.doesNotMatch(serviceWorker, /wpclkhgizbvxuvbhbwzs\.supabase\.co/);
  assert.match(moderation, /createClient\(config\.supabase\.url,config\.supabase\.anonKey\)/);
  assert.doesNotMatch(moderation, /wpclkhgizbvxuvbhbwzs\.supabase\.co/);
});

test('Cloudflare build accepts configured Supabase origin and rejects malformed URL before cleaning dist', () => {
  const buildPath = new URL('../tools/build-cloudflare.mjs', import.meta.url);
  const source = readFileSync(buildPath, 'utf8');
  assert.ok(source.indexOf('configuredSupabaseUrl') < source.indexOf('rmSync(out'));
  assert.match(source, /process\.env\.VITE_SUPABASE_URL\?\.trim\(\) \|\| process\.env\.SUPABASE_URL/);
  assert.match(source, /new URL\(configuredSupabaseUrl\)/);
  assert.match(source, /plain HTTPS origin without quotes or brackets/);
});

test('Cloudflare Pages routes production hosts to the primary custom domain', async () => {
  const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const apiMiddleware = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');
  const fetchAdapter = readFileSync(new URL('../api/_lib/fetch-adapter.js', import.meta.url), 'utf8');
  const supa = readFileSync(new URL('../api/_lib/supa.js', import.meta.url), 'utf8');
  const supabase = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const middleware = await import('../functions/_middleware.js');
  assert.match(wrangler, /^name = "milkyway-project"$/m);
  assert.match(wrangler, /^LIVEKIT_URL = "wss:\/\/masiyatunda-milkyway-live-mgh6b1np\.livekit\.cloud"$/m);
  assert.match(apiMiddleware, /onRequest = \(\{ request, env \}\)/);
  assert.match(apiMiddleware, /runApi\(name, request, env\)/);
  assert.match(fetchAdapter, /runApi\(name, request, environment = null\)/);
  assert.match(fetchAdapter, /env: environment/);
  assert.match(supa, /makeContext\(user, token, key, request\.env\)/);
  assert.match(supabase, /site_url = "https:\/\/www\.masiyatunda\.com"/);
  assert.match(supabase, /"https:\/\/milkyway-project\.pages\.dev\/\*\*"/);
  assert.match(homepage, /rel="canonical" href="https:\/\/www\.masiyatunda\.com\/"/);

  for (const host of ['masiyatunda.com', 'milkyway-project.pages.dev']) {
    const response = await middleware.onRequest({
      request: new Request(`https://${host}/milkyway/?from=old-host`),
      next: () => { throw new Error('non-canonical host must redirect'); },
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://www.masiyatunda.com/milkyway/?from=old-host');
  }
  const response = await middleware.onRequest({
    request: new Request('https://www.masiyatunda.com/api/milkyway-health'),
    next: () => new Response('ok'),
  });
  assert.equal(await response.text(), 'ok');
});

test('Cloudflare API rejects oversized JSON bodies before parsing', async () => {
  const body = JSON.stringify({ value: 'x'.repeat(16 * 1024) });
  const response = await runApi('milkyway-health', new Request('https://www.masiyatunda.com/api/milkyway-health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));
  assert.equal(response.status, 413);
  assert.match(response.headers.get('x-request-id') || '', /^[a-z0-9-]{36}$/i);
});

test('LiveKit cleanup worker consumes the database RPC lease shape and completes the job', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  const room = 'mw-video-live-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const leaseId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const calls = [];
  process.env.LIVEKIT_URL = 'wss://live.example.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  globalThis.fetch = async address => {
    calls.push(String(address));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const ctx = {
    async rpc(name, args) {
      calls.push(`${name}:${JSON.stringify(args)}`);
      if (name === 'mw_room_cleanup_claim') return [{ job_room_name: room, job_lease_id: leaseId }];
      return true;
    },
  };
  try {
    assert.equal(await closeRoom(ctx, room), true);
    assert.ok(calls.some(call => call === `mw_room_cleanup_complete:${JSON.stringify({ p_room_name: room, p_lease_id: leaseId })}`));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('expired ringing calls are ended and cannot obtain a LiveKit token', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY'].map(key => [key, process.env[key]]));
  const userId = '11111111-1111-4111-8111-111111111111';
  const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const call = {
    id: callId, caller_id: userId, callee_id: '22222222-2222-4222-8222-222222222222',
    status: 'ringing', offer: { mode: 'video' }, created_at: new Date(Date.now() - 120000).toISOString(),
  };
  const calls = [];
  process.env.SUPABASE_URL = 'https://unit.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'test-key';
  globalThis.fetch = async (address, init = {}) => {
    const url = String(address);
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes('/rpc/mw_room_cleanup_claim')) return new Response('[]', { status: 200 });
    if (url.includes('/rpc/mw_room_cleanup_enqueue')) return new Response('null', { status: 200 });
    if (url.includes('/rest/v1/mw_dm_calls?') && init.method === 'PATCH') return new Response('[]', { status: 200 });
    if (url.includes('/rest/v1/mw_dm_calls?')) return new Response(JSON.stringify([call]), { status: 200 });
    throw new Error(`Unexpected call-token request: ${url}`);
  };
  let status = 200, payload;
  const response = {
    headersSent: false,
    setHeader() { return response; },
    status(code) { status = code; return response; },
    json(value) { payload = value; response.headersSent = true; return response; },
  };
  try {
    await callApi({
      method: 'POST', headers: { authorization: 'Bearer test-token', apikey: 'test-key', 'x-request-id': 'test-request-id' },
      query: { action: 'token' }, body: { id: callId },
    }, response);
    assert.equal(status, 409);
    assert.match(payload.error, /call has ended/i);
    const update = calls.find(item => item.method === 'PATCH' && item.url.includes('/rest/v1/mw_dm_calls?'));
    assert.deepEqual(update.body.answer, { outcome: 'missed' });
    assert.ok(calls.every(item => !item.url.includes('twirp/livekit.RoomService')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('production hardening scopes cleanup leases and uses short locale-aware lifecycle formatting', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261126_milkyway_production_hardening.sql', import.meta.url), 'utf8');
  const liveToken = readFileSync(new URL('../api/milkyway-livekit-token.js', import.meta.url), 'utf8');
  const edgeToken = readFileSync(new URL('../supabase/functions/_shared/milkyway-token.ts', import.meta.url), 'utf8');
  const dom = readFileSync(new URL('../milkyway/app/ui/dom.js', import.meta.url), 'utf8');
  const liveSession = readFileSync(new URL('../milkyway/app/ui/live-session.js', import.meta.url), 'utf8');
  assert.match(migration, /requested_by uuid not null references auth\.users/);
  assert.match(migration, /where q\.requested_by = auth\.uid\(\)/);
  assert.match(migration, /mw_live_room_send_like/);
  assert.match(migration, /mw_live_room_like_status/);
  assert.match(liveToken, /ttlSeconds:\s*60/);
  assert.doesNotMatch(edgeToken, /ttl:\s*'1h'|'10m'/);
  assert.match(edgeToken, /milkyway-project\.pages\.dev/);
  assert.match(dom, /Intl\.DateTimeFormat/);
  assert.match(dom, /Intl\.NumberFormat/);
  assert.match(dom, /Intl\.RelativeTimeFormat/);
  assert.match(liveSession, /'like-status'/);
  assert.match(liveSession, /status\.isLive === false/);
});
