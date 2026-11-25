-- Allocate a guest seat atomically so concurrent joins and host approvals cannot overbook the stage.
begin;

create or replace function public.mw_live_room_allocate_guest_seat(
  p_room_name text,
  p_user_id text,
  p_name text,
  p_avatar text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me text := auth.uid()::text;
  live_host text;
  live_room_id text;
  room_settings jsonb := '{}'::jsonb;
  current_state text;
  seat_limit integer := 8;
  seated_count integer;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if coalesce(p_user_id, '') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    raise exception 'Invalid participant.' using errcode = '22023';
  end if;

  -- The room row is the shared lock for every seat allocation in this session.
  select session.host_id::text, session.id::text
    into live_host, live_room_id
  from public.mw_video_live_sessions as session
  where session.room_name = p_room_name
    and session.is_live is true
  for update;

  if live_host is null or live_room_id is null then
    raise exception 'This Live session has ended.' using errcode = 'P0002';
  end if;
  if lower(p_user_id) = lower(live_host) then
    raise exception 'The host is already on stage.' using errcode = '42501';
  end if;
  if lower(me) <> lower(live_host) and lower(p_user_id) <> lower(me) then
    raise exception 'Only the host can seat another participant.' using errcode = '42501';
  end if;

  select coalesce(settings.settings, '{}'::jsonb)
    into room_settings
  from public.mw_live_room_settings as settings
  where settings.room_name = p_room_name;

  if exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(room_settings -> 'blockedIds') = 'array'
          then room_settings -> 'blockedIds'
        else '[]'::jsonb
      end
    ) as blocked(user_id)
    where lower(blocked.user_id) = lower(p_user_id)
  ) then
    raise exception 'Unblock this person before inviting them on stage.' using errcode = '42501';
  end if;

  select member.state
    into current_state
  from public.mw_live_room_members as member
  where member.room_name = p_room_name
    and lower(member.user_id::text) = lower(p_user_id)
  for update;

  if current_state = 'speaker' then
    return 'speaker';
  end if;
  if lower(me) = lower(live_host) then
    if current_state is distinct from 'pending' then
      raise exception 'This person cancelled their request.' using errcode = '23514';
    end if;
  elsif coalesce(room_settings ->> 'admission', 'approval') <> 'open'
      or coalesce(room_settings ->> 'allowRequests', 'true') = 'false' then
    raise exception 'The host is not taking guest requests right now.' using errcode = '42501';
  elsif current_state is not null and current_state not in ('viewer', 'pending') then
    raise exception 'This person is not available to join.' using errcode = '23514';
  end if;

  seat_limit := greatest(1, least(8,
    (case
      when coalesce(room_settings ->> 'layout', '') ~ '^[0-9]+$' then (room_settings ->> 'layout')::integer
      else 9
    end) - 1
  ));
  select count(*)::integer
    into seated_count
  from public.mw_live_room_members as member
  where member.room_name = p_room_name
    and member.state = 'speaker'
    and lower(member.user_id::text) <> lower(p_user_id);

  if seated_count >= seat_limit then
    raise exception 'All guest seats are full.' using errcode = '23514';
  end if;

  insert into public.mw_live_room_members (
    room_id, room_name, user_id, name, avatar, state, host_muted, updated_at
  )
  values (
    live_room_id::uuid, p_room_name, p_user_id::uuid,
    left(coalesce(nullif(p_name, ''), 'MilkyWay user'), 80),
    left(coalesce(p_avatar, ''), 500), 'speaker', false, now()
  )
  on conflict (room_name, user_id) do update
    set name = excluded.name,
        avatar = excluded.avatar,
        state = 'speaker',
        host_muted = false,
        updated_at = now();

  return 'speaker';
end
$$;

revoke all on function public.mw_live_room_allocate_guest_seat(text, text, text, text) from public, anon;
grant execute on function public.mw_live_room_allocate_guest_seat(text, text, text, text) to authenticated;

commit;
notify pgrst, 'reload schema';
