-- Authorize cleanup for deterministic, participant-pair DM LiveKit rooms.
begin;

create or replace function public.mw_room_cleanup_enqueue(p_room_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  owner_allowed boolean := false;
  call_id uuid;
  room_users text[];
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
  elsif p_room_name ~* '^dm-call-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    room_users := regexp_match(
      p_room_name,
      '^dm-call-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$',
      'i'
    );
    select room_users[1]::uuid < room_users[2]::uuid and exists (
      select 1 from public.mw_dm_calls
      where (
        (caller_id = room_users[1]::uuid and callee_id = room_users[2]::uuid)
        or (caller_id = room_users[2]::uuid and callee_id = room_users[1]::uuid)
      )
      and (caller_id = me or callee_id = me)
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

commit;
notify pgrst, 'reload schema';
