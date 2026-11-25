-- Ensure authenticated LIVE participants have table privileges while RLS limits each operation to active rooms.
begin;

create or replace function public.mw_live_room_is_active(room text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.mw_video_live_sessions as session
    where session.room_name = room
      and session.is_live is true
  );
$$;

revoke all on function public.mw_live_room_is_active(text) from public, anon, authenticated;
grant execute on function public.mw_live_room_is_active(text) to authenticated;

alter table public.mw_live_room_settings enable row level security;
alter table public.mw_live_room_members enable row level security;
alter table public.mw_live_room_messages enable row level security;

revoke all on public.mw_live_room_settings, public.mw_live_room_members, public.mw_live_room_messages
  from public, anon;
grant select, insert, update, delete
  on public.mw_live_room_settings, public.mw_live_room_members, public.mw_live_room_messages
  to authenticated;

drop policy if exists mw_live_settings_read on public.mw_live_room_settings;
create policy mw_live_settings_read on public.mw_live_room_settings
  for select to authenticated
  using (public.mw_live_room_is_active(room_name));
drop policy if exists mw_live_settings_host on public.mw_live_room_settings;
create policy mw_live_settings_host on public.mw_live_room_settings
  for all to authenticated
  using (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name))
  with check (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name) and host_id = auth.uid());

drop policy if exists mw_live_members_read on public.mw_live_room_members;
create policy mw_live_members_read on public.mw_live_room_members
  for select to authenticated
  using (public.mw_live_room_is_active(room_name));
drop policy if exists mw_live_members_self on public.mw_live_room_members;
create policy mw_live_members_self on public.mw_live_room_members
  for all to authenticated
  using (public.mw_live_room_is_active(room_name) and user_id = auth.uid())
  with check (
    public.mw_live_room_is_active(room_name)
    and user_id = auth.uid()
    and state in ('viewer', 'pending')
    and host_muted = false
  );
drop policy if exists mw_live_members_host on public.mw_live_room_members;
create policy mw_live_members_host on public.mw_live_room_members
  for all to authenticated
  using (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name))
  with check (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name));

drop policy if exists mw_live_messages_read on public.mw_live_room_messages;
create policy mw_live_messages_read on public.mw_live_room_messages
  for select to authenticated
  using (public.mw_live_room_is_active(room_name));
drop policy if exists mw_live_messages_insert on public.mw_live_room_messages;
create policy mw_live_messages_insert on public.mw_live_room_messages
  for insert to authenticated
  with check (public.mw_live_room_is_active(room_name) and user_id = auth.uid());
drop policy if exists mw_live_messages_host on public.mw_live_room_messages;
create policy mw_live_messages_host on public.mw_live_room_messages
  for update to authenticated
  using (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name))
  with check (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name));
drop policy if exists mw_live_messages_delete_host on public.mw_live_room_messages;
create policy mw_live_messages_delete_host on public.mw_live_room_messages
  for delete to authenticated
  using (public.mw_live_room_is_active(room_name) and public.mw_is_live_host(room_name));

commit;
notify pgrst, 'reload schema';
