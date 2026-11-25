-- Make LIVE request/approval access explicit and safe across deployments with stale member policies.
begin;

alter table public.mw_live_room_members enable row level security;
revoke all on public.mw_live_room_members from public, anon;
grant select, insert, update, delete on public.mw_live_room_members to authenticated;

drop policy if exists mw_live_members_read on public.mw_live_room_members;
create policy mw_live_members_read on public.mw_live_room_members
  for select to authenticated
  using (public.mw_live_room_is_active(room_name));

drop policy if exists mw_live_members_self on public.mw_live_room_members;
drop policy if exists mw_live_members_self_insert on public.mw_live_room_members;
create policy mw_live_members_self_insert on public.mw_live_room_members
  for insert to authenticated
  with check (
    public.mw_live_room_is_active(room_name)
    and user_id = (select auth.uid())
    and state in ('viewer', 'pending')
    and host_muted = false
  );

drop policy if exists mw_live_members_self_update on public.mw_live_room_members;
create policy mw_live_members_self_update on public.mw_live_room_members
  for update to authenticated
  using (
    public.mw_live_room_is_active(room_name)
    and user_id = (select auth.uid())
  )
  with check (
    public.mw_live_room_is_active(room_name)
    and user_id = (select auth.uid())
    and state in ('viewer', 'pending')
    and host_muted = false
  );

drop policy if exists mw_live_members_host on public.mw_live_room_members;
drop policy if exists mw_live_members_host_update on public.mw_live_room_members;
create policy mw_live_members_host_update on public.mw_live_room_members
  for update to authenticated
  using (
    public.mw_live_room_is_active(room_name)
    and public.mw_is_live_host(room_name)
  )
  with check (
    public.mw_live_room_is_active(room_name)
    and public.mw_is_live_host(room_name)
  );

drop policy if exists mw_live_members_self_delete on public.mw_live_room_members;
create policy mw_live_members_self_delete on public.mw_live_room_members
  for delete to authenticated
  using (
    public.mw_live_room_is_active(room_name)
    and user_id = (select auth.uid())
  );

drop policy if exists mw_live_members_host_delete on public.mw_live_room_members;
create policy mw_live_members_host_delete on public.mw_live_room_members
  for delete to authenticated
  using (
    public.mw_live_room_is_active(room_name)
    and public.mw_is_live_host(room_name)
  );

commit;
notify pgrst, 'reload schema';
