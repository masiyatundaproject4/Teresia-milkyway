-- Reinstall the guest-request RPC with text-normalized ID comparisons for databases
-- where legacy member/session ID columns differ between text and uuid.
begin;

create or replace function public.mw_live_room_request(
  p_room_name text,
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
  invite_value text;
  invited_at numeric;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select session.host_id::text,
         session.id::text
    into live_host,
         live_room_id
  from public.mw_video_live_sessions as session
  where session.room_name = p_room_name
    and session.is_live is true;

  if live_host is null or live_room_id is null then
    raise exception 'This Live session has ended.' using errcode = 'P0002';
  end if;
  if live_host::text = me::text then
    raise exception 'The host is already on stage.' using errcode = '42501';
  end if;

  select coalesce(settings.settings, '{}'::jsonb)
    into room_settings
  from public.mw_live_room_settings as settings
  where settings.room_name = p_room_name;

  if jsonb_typeof(room_settings -> 'invites') = 'object' then
    select invite.invited_at_text::text
      into invite_value
    from jsonb_each_text(room_settings -> 'invites') as invite(user_id_text, invited_at_text)
    where lower(invite.user_id_text::text) = lower(me::text)
    limit 1;
  end if;

  if coalesce(invite_value, '') ~ '^[0-9]+$' then
    invited_at := invite_value::numeric;
  end if;

  if (invited_at is null or floor(extract(epoch from now()) * 1000) - invited_at >= 180000)
     and (coalesce(room_settings ->> 'admission', 'approval') = 'broadcast'
       or room_settings ->> 'allowRequests' = 'false') then
    raise exception 'The host is not taking guest requests right now.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(room_settings -> 'blockedIds') = 'array'
          then room_settings -> 'blockedIds'
        else '[]'::jsonb
      end
    ) as blocked(user_id)
    where lower(blocked.user_id::text) = lower(me::text)
  ) then
    raise exception 'The host removed you from this LIVE.' using errcode = '42501';
  end if;

  select member.state
    into current_state
  from public.mw_live_room_members as member
  where member.room_name = p_room_name
    and member.user_id::text = me::text
  for update;

  if current_state = 'speaker' then
    return 'speaker';
  end if;
  if current_state = 'pending' then
    return 'pending';
  end if;

  insert into public.mw_live_room_members (
    room_id, room_name, user_id, name, avatar, state, host_muted, updated_at
  )
  values (
    live_room_id::uuid, p_room_name, me::uuid,
    left(coalesce(nullif(p_name, ''), 'MilkyWay user'), 80),
    left(coalesce(p_avatar, ''), 500), 'pending', false, now()
  )
  on conflict (room_name, user_id) do update
    set name = excluded.name,
        avatar = excluded.avatar,
        state = 'pending',
        host_muted = false,
        updated_at = now();

  return 'pending';
end
$$;

revoke all on function public.mw_live_room_request(text, text, text) from public, anon;
grant execute on function public.mw_live_room_request(text, text, text) to authenticated;

commit;
notify pgrst, 'reload schema';
