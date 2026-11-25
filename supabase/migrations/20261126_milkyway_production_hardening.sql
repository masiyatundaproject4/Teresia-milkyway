begin;

-- Group membership is created by the SECURITY DEFINER creation/invitation RPCs, or by an existing
-- administrator. A user can no longer insert their own membership row into an arbitrary group.
drop policy if exists mw_dm_members_add on public.mw_dm_group_members;
create policy mw_dm_members_add on public.mw_dm_group_members
  for insert to authenticated
  with check (public.mw_dm_is_group_admin(group_id, auth.uid()));

-- Policy helpers are callable RPCs; constrain their user argument to the authenticated caller so
-- they cannot be used to enumerate membership or administrator status for other people.
create or replace function public.mw_dm_is_group_member(gid uuid, uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and exists (
    select 1 from public.mw_dm_group_members where group_id = gid and user_id = uid
  )
$$;

create or replace function public.mw_dm_is_group_admin(gid uuid, uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and exists (
    select 1 from public.mw_dm_group_members where group_id = gid and user_id = uid and role = 'admin'
  )
$$;

revoke update on public.mw_dm_calls from authenticated;
grant update (status, answer, ended_at) on public.mw_dm_calls to authenticated;

create table if not exists public.mw_room_cleanup_queue (
  room_name text primary key,
  requested_by uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text not null default ''
);
alter table public.mw_room_cleanup_queue enable row level security;
revoke all on public.mw_room_cleanup_queue from public, anon, authenticated;

create or replace function public.mw_room_cleanup_enqueue(p_room_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  owner_allowed boolean := false;
  call_id uuid;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_room_name ~* '^mw-(audio|video)-live-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    select exists (
      select 1 from public.mw_video_live_sessions
      where room_name = p_room_name and host_id = me
    ) into owner_allowed;
  elsif p_room_name ~* '^mw-conversation-(audio|video)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    call_id := substring(p_room_name from '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$')::uuid;
    select exists (
      select 1 from public.mw_dm_calls
      where id = call_id and (caller_id = me or callee_id = me)
    ) into owner_allowed;
  end if;
  if not owner_allowed then raise exception 'Not allowed to close this room.' using errcode = '42501'; end if;
  insert into public.mw_room_cleanup_queue(room_name, requested_by)
    values (p_room_name, me)
    on conflict (room_name) do update set
      requested_by = excluded.requested_by,
      requested_at = now(), next_attempt_at = now(), lease_id = null, lease_until = null, last_error = '';
end
$$;
revoke all on function public.mw_room_cleanup_enqueue(text) from public, anon;
grant execute on function public.mw_room_cleanup_enqueue(text) to authenticated;

create or replace function public.mw_room_cleanup_claim(p_room_name text default null)
returns table(job_room_name text, job_lease_id uuid)
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  return query
    with candidate as (
      select q.room_name
      from public.mw_room_cleanup_queue q
      where q.requested_by = auth.uid()
        and (p_room_name is null or q.room_name = p_room_name)
        and q.next_attempt_at <= now()
        and (q.lease_until is null or q.lease_until < now())
      order by q.next_attempt_at, q.requested_at
      for update skip locked
      limit 1
    )
    update public.mw_room_cleanup_queue q
      set attempts = q.attempts + 1,
          lease_id = gen_random_uuid(),
          lease_until = now() + interval '30 seconds'
      from candidate
      where q.room_name = candidate.room_name
    returning q.room_name, q.lease_id;
end
$$;
revoke all on function public.mw_room_cleanup_claim(text) from public, anon;
grant execute on function public.mw_room_cleanup_claim(text) to authenticated;

create or replace function public.mw_room_cleanup_complete(p_room_name text, p_lease_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  delete from public.mw_room_cleanup_queue
    where room_name = p_room_name and lease_id = p_lease_id and requested_by = auth.uid();
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;
revoke all on function public.mw_room_cleanup_complete(text, uuid) from public, anon;
grant execute on function public.mw_room_cleanup_complete(text, uuid) to authenticated;

create or replace function public.mw_room_cleanup_retry(p_room_name text, p_lease_id uuid, p_error text default '')
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  update public.mw_room_cleanup_queue
    set next_attempt_at = now() + make_interval(secs => least(300, 5 * power(2, least(attempts, 6))::integer)),
        lease_id = null,
        lease_until = null,
        last_error = left(coalesce(p_error, ''), 240)
    where room_name = p_room_name and lease_id = p_lease_id and requested_by = auth.uid();
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;
revoke all on function public.mw_room_cleanup_retry(text, uuid, text) from public, anon;
grant execute on function public.mw_room_cleanup_retry(text, uuid, text) to authenticated;

-- A single transactional entry point owns moderation, idempotency, and slow-mode serialization.
create or replace function public.mw_live_room_send_message(p_id uuid, p_room_name text, p_body text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  host uuid;
  session_scope text;
  settings jsonb := '{}'::jsonb;
  profile_name text;
  profile_avatar text;
  message_body text := btrim(coalesce(p_body, ''));
  slow_seconds integer := 0;
  is_filtered boolean := false;
  existing public.mw_live_room_messages%rowtype;
  inserted public.mw_live_room_messages%rowtype;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_id is null or char_length(message_body) < 1 or char_length(message_body) > 300 then
    raise exception 'Message length must be 1-300 characters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_room_name || ':' || me::text, 0));

  select s.host_id, s.scope into host, session_scope
    from public.mw_video_live_sessions s
    where s.room_name = p_room_name and s.is_live is true;
  if host is null then raise exception 'This Live session has ended.' using errcode = 'P0002'; end if;
  select coalesce(s.settings, '{}'::jsonb) into settings
    from public.mw_live_room_settings s where s.room_name = p_room_name;

  if host <> me and coalesce(session_scope, '') not in ('public', 'everyone', 'followers') then
    raise exception 'This Live session is not available.' using errcode = '42501';
  end if;

  select * into existing from public.mw_live_room_messages where id = p_id;
  if found then
    if existing.room_name = p_room_name and existing.user_id = me and existing.body = message_body then
      return jsonb_build_object(
        'ok', true, 'filtered', existing.deleted, 'id', existing.id,
        'message', jsonb_build_object('id', existing.id, 'userId', existing.user_id, 'name', existing.name, 'body', existing.body, 'createdAt', existing.created_at)
      );
    end if;
    raise exception 'Message id has already been used.' using errcode = '23505';
  end if;

  if host <> me then
    if session_scope = 'followers' and not exists (
      select 1 from public.mw_follows f where f.follower_id = me and f.following_id = host
    ) then
      raise exception 'This session is for followers only.' using errcode = '42501';
    end if;
    if coalesce(settings -> 'blockedIds', '[]'::jsonb) ? lower(me::text) then
      raise exception 'The host removed you from this LIVE.' using errcode = '42501';
    end if;
    if coalesce(settings ->> 'comments', 'everyone') = 'off' then
      raise exception 'The host turned off comments.' using errcode = '42501';
    end if;
    if coalesce(settings -> 'mutedIds', '[]'::jsonb) ? lower(me::text) then
      raise exception 'The host muted your comments in this LIVE.' using errcode = '42501';
    end if;
    if coalesce(settings ->> 'comments', 'everyone') = 'followers'
       and not exists (
         select 1 from public.mw_follows f where f.follower_id = me and f.following_id = host
       ) then
      raise exception 'Only followers of the host can comment.' using errcode = '42501';
    end if;
    if coalesce(settings ->> 'slowMode', '') ~ '^[0-9]+$' then
      slow_seconds := least(3600, (settings ->> 'slowMode')::integer);
    end if;
    if slow_seconds > 0 and exists (
      select 1 from public.mw_live_room_messages m
      where m.room_name = p_room_name and m.user_id = me
        and m.created_at > now() - make_interval(secs => slow_seconds)
    ) then
      raise exception 'Slow mode is on: one comment every % seconds.', slow_seconds using errcode = 'P0001';
    end if;
  end if;

  is_filtered := coalesce(settings ->> 'filterLinks', 'false') = 'true'
    and message_body ~* '(https?://|www\\.|[[:alnum:]-]{2,}\\.(com|net|org|io|co|tz|ke|ug|me|ly|app|link|xyz|info|biz|site|online|shop))';
  if not is_filtered and host <> me then
    select exists (
      select 1 from jsonb_array_elements_text(coalesce(settings -> 'filterWords', '[]'::jsonb)) w
      where length(btrim(w)) >= 2 and position(lower(btrim(w)) in lower(message_body)) > 0
    ) into is_filtered;
  end if;

  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.username), ''), 'MilkyWay user'),
         coalesce(p.avatar_url, '')
    into profile_name, profile_avatar
    from public.mw_profiles p where p.id = me;
  profile_name := coalesce(profile_name, 'MilkyWay user');
  profile_avatar := coalesce(profile_avatar, '');

  insert into public.mw_live_room_messages(id, room_name, user_id, name, avatar, kind, body, deleted)
    values (p_id, p_room_name, me, left(profile_name, 80), left(profile_avatar, 500), 'chat', message_body, is_filtered)
    returning * into inserted;
  return jsonb_build_object(
    'ok', true, 'filtered', is_filtered, 'id', inserted.id,
    'message', jsonb_build_object('id', inserted.id, 'userId', inserted.user_id, 'name', inserted.name, 'body', inserted.body, 'createdAt', inserted.created_at)
  );
end
$$;
revoke all on function public.mw_live_room_send_message(uuid, text, text) from public, anon;
grant execute on function public.mw_live_room_send_message(uuid, text, text) to authenticated;

revoke insert on public.mw_live_room_messages from authenticated;

create table if not exists public.mw_live_room_likes (
  id uuid primary key,
  room_name text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  like_count smallint not null check (like_count between 1 and 50),
  created_at timestamptz not null default now()
);
create index if not exists mw_live_room_likes_room_created_idx
  on public.mw_live_room_likes(room_name, created_at desc);
create index if not exists mw_live_room_likes_created_idx
  on public.mw_live_room_likes(created_at);
alter table public.mw_live_room_likes enable row level security;
revoke all on public.mw_live_room_likes from public, anon, authenticated;

create or replace function public.mw_live_room_send_like(p_id uuid, p_room_name text, p_count integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  host uuid;
  session_scope text;
  settings jsonb := '{}'::jsonb;
  existing public.mw_live_room_likes%rowtype;
  inserted public.mw_live_room_likes%rowtype;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_id is null or p_count < 1 or p_count > 50 then
    raise exception 'Invalid like event.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_room_name || ':' || me::text, 0));
  select s.host_id, s.scope into host, session_scope
    from public.mw_video_live_sessions s where s.room_name = p_room_name and s.is_live is true;
  if host is null then raise exception 'This Live session has ended.' using errcode = 'P0002'; end if;
  if host <> me and coalesce(session_scope, '') not in ('public', 'everyone', 'followers') then
    raise exception 'This Live session is not available.' using errcode = '42501';
  end if;
  if host <> me and session_scope = 'followers' and not exists (
    select 1 from public.mw_follows f where f.follower_id = me and f.following_id = host
  ) then
    raise exception 'This session is for followers only.' using errcode = '42501';
  end if;
  select coalesce(s.settings, '{}'::jsonb) into settings
    from public.mw_live_room_settings s where s.room_name = p_room_name;
  if coalesce(settings -> 'blockedIds', '[]'::jsonb) ? lower(me::text) then
    raise exception 'The host removed you from this LIVE.' using errcode = '42501';
  end if;
  if coalesce(settings ->> 'likesEnabled', 'false') <> 'true' then
    raise exception 'Likes are turned off.' using errcode = '42501';
  end if;
  select * into existing from public.mw_live_room_likes where id = p_id;
  if found then
    if existing.room_name = p_room_name and existing.user_id = me then
      return jsonb_build_object('id', existing.id, 'userId', existing.user_id, 'count', existing.like_count, 'createdAt', existing.created_at);
    end if;
    raise exception 'Like event id has already been used.' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.mw_live_room_likes l
    where l.room_name = p_room_name and l.user_id = me and l.created_at > now() - interval '1 second'
  ) then
    raise exception 'Slow mode is on: likes are limited to one batch per second.' using errcode = 'P0001';
  end if;
  delete from public.mw_live_room_likes where created_at < now() - interval '10 minutes';
  insert into public.mw_live_room_likes(id, room_name, user_id, count)
    values (p_id, p_room_name, me, p_count) returning * into inserted;
  return jsonb_build_object('id', inserted.id, 'userId', inserted.user_id, 'count', inserted.like_count, 'createdAt', inserted.created_at);
end
$$;
revoke all on function public.mw_live_room_send_like(uuid, text, integer) from public, anon;
grant execute on function public.mw_live_room_send_like(uuid, text, integer) to authenticated;

create or replace function public.mw_live_room_like_status(p_id uuid, p_room_name text, p_sender uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
  host uuid;
  session_scope text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select s.host_id, s.scope into host, session_scope
    from public.mw_video_live_sessions s where s.room_name = p_room_name and s.is_live is true;
  if host is null then return null; end if;
  if host <> auth.uid() and coalesce(session_scope, '') not in ('public', 'everyone', 'followers') then
    raise exception 'This Live session is not available.' using errcode = '42501';
  end if;
  if host <> auth.uid() and session_scope = 'followers' and not exists (
    select 1 from public.mw_follows f where f.follower_id = auth.uid() and f.following_id = host
  ) then
    raise exception 'This session is for followers only.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', l.id, 'userId', l.user_id, 'count', l.like_count, 'createdAt', l.created_at
  ) into result
  from public.mw_live_room_likes l
  where l.id = p_id and l.room_name = p_room_name and l.user_id = p_sender
    and l.created_at > now() - interval '5 minutes';
  return result;
end
$$;
revoke all on function public.mw_live_room_like_status(uuid, text, uuid) from public, anon;
grant execute on function public.mw_live_room_like_status(uuid, text, uuid) to authenticated;

-- A transaction id is returned to the sender so viewers can verify a gift before rendering its data event.
create or replace function public.mw_wallet_send_gift(p_gift text, p_room text default null, p_post uuid default null, p_story uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public.mw_wallet_uid();
  gkey text := case when p_gift = 'taji-ya-masiyatunda' then 'taji-ya-milkyway' else p_gift end;
  price numeric;
  cut numeric;
  net numeric;
  receiver uuid;
  room_host uuid;
  room_scope text;
  target text;
  raw text;
  sender_w public.mw_wallets;
  gift_id uuid := gen_random_uuid();
begin
  if (case when nullif(p_room, '') is null then 0 else 1 end)
     + (case when p_post is null then 0 else 1 end)
     + (case when p_story is null then 0 else 1 end) <> 1 then
    raise exception 'Choose one place to send the gift.';
  end if;
  select c.coins into price from public.mw_gift_catalog c where c.gift_key = gkey and c.active;
  if price is null then raise exception 'Unknown gift.'; end if;
  select s.platform_cut_pct into cut from public.mw_wallet_settings s where s.id = 1;

  if nullif(p_room, '') is not null then
    target := 'live';
    select s.host_id, s.scope into receiver, room_scope from public.mw_video_live_sessions s
      where s.room_name = p_room and s.is_live is true;
    room_host := receiver;
  elsif p_post is not null then
    target := 'post';
    select p.author_id::text into raw from public.mw_posts p where p.id = p_post;
    if raw ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then receiver := raw::uuid; end if;
  else
    target := 'story';
    select s.user_id into receiver from public.mw_stories s where s.id = p_story;
  end if;
  if receiver is null then raise exception 'Gift target not found.'; end if;
  if receiver = u then raise exception 'You cannot send a gift to yourself.'; end if;
  if target = 'live' and room_host <> u then
    if coalesce(room_scope, '') not in ('public', 'everyone', 'followers') then
      raise exception 'This Live session is not available.' using errcode = '42501';
    end if;
    if room_scope = 'followers' and not exists (
      select 1 from public.mw_follows f where f.follower_id = u and f.following_id = room_host
    ) then
      raise exception 'This session is for followers only.' using errcode = '42501';
    end if;
  end if;

  insert into public.mw_wallets(user_id) values (u), (receiver) on conflict (user_id) do nothing;
  perform 1 from public.mw_wallets w where w.user_id in (u, receiver) order by w.user_id for update;
  select * into sender_w from public.mw_wallets w where w.user_id = u;
  if sender_w.coins < price then raise exception 'Not enough coins.'; end if;
  net := round(price * (100 - coalesce(cut, 0)) / 100, 2);

  insert into public.mw_gift_events(id, sender_id, receiver_id, gift_key, coins, earned, cut_pct, target, room_name, post_id, story_id)
    values (gift_id, u, receiver, gkey, price, net, coalesce(cut, 0), target,
      case when target = 'live' then p_room end, case when target = 'post' then p_post end, case when target = 'story' then p_story end);
  sender_w := public.mw_wallet_apply(u, -price, 0, 0, 'gift_sent', gift_id);
  perform public.mw_wallet_apply(receiver, 0, net, net, 'gift_received', gift_id);
  return jsonb_build_object('ok', true, 'id', gift_id, 'coins', sender_w.coins, 'earned', sender_w.earned, 'gift', gkey);
end
$$;
revoke all on function public.mw_wallet_send_gift(text, text, uuid, uuid) from public, anon;
grant execute on function public.mw_wallet_send_gift(text, text, uuid, uuid) to authenticated;

create or replace function public.mw_live_room_gift_status(p_id uuid, p_room_name text, p_sender uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
  host uuid;
  session_scope text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select s.host_id, s.scope into host, session_scope
    from public.mw_video_live_sessions s where s.room_name = p_room_name and s.is_live is true;
  if host is null then return null; end if;
  if host <> auth.uid() and coalesce(session_scope, '') not in ('public', 'everyone', 'followers') then
    raise exception 'This Live session is not available.' using errcode = '42501';
  end if;
  if host <> auth.uid() and session_scope = 'followers' and not exists (
    select 1 from public.mw_follows f where f.follower_id = auth.uid() and f.following_id = host
  ) then
    raise exception 'This session is for followers only.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.mw_video_live_sessions s where s.room_name = p_room_name and s.is_live is true
  ) then return null; end if;
  select jsonb_build_object(
    'id', g.id, 'sender', g.sender_id, 'gift', g.gift_key, 'createdAt', g.created_at
  ) into result
  from public.mw_gift_events g
  where g.id = p_id and g.room_name = p_room_name and g.sender_id = p_sender
    and g.created_at > now() - interval '5 minutes';
  return result;
end
$$;
revoke all on function public.mw_live_room_gift_status(uuid, text, uuid) from public, anon;
grant execute on function public.mw_live_room_gift_status(uuid, text, uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
