begin;

alter table public.mw_dm_groups
  add column if not exists avatar_url text not null default '',
  add column if not exists join_mode text not null default 'invite_only',
  add column if not exists members_can_invite boolean not null default true;

alter table public.mw_dm_group_members
  add column if not exists join_status text not null default 'active',
  add column if not exists invited_by uuid references auth.users(id) on delete set null;

do $$
declare item record;
begin
  for item in
    select conname from pg_constraint
    where conrelid = 'public.mw_dm_group_members'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.mw_dm_group_members drop constraint %I', item.conname);
  end loop;
end $$;
alter table public.mw_dm_group_members
  drop constraint if exists mw_dm_group_members_role_check,
  drop constraint if exists mw_dm_group_members_join_status_check;
alter table public.mw_dm_group_members
  add constraint mw_dm_group_members_role_check check (role in ('admin', 'co_admin', 'member')),
  add constraint mw_dm_group_members_join_status_check check (join_status in ('active', 'pending', 'invited'));
alter table public.mw_dm_groups drop constraint if exists mw_dm_groups_join_mode_check;
alter table public.mw_dm_groups
  add constraint mw_dm_groups_join_mode_check check (join_mode in ('open', 'request_approval', 'invite_only'));
create index if not exists mw_dm_group_members_user_status_idx
  on public.mw_dm_group_members(user_id, join_status, joined_at desc);

create or replace function public.mw_dm_is_group_member(gid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and exists (
    select 1 from public.mw_dm_group_members
    where group_id = gid and user_id = uid and join_status = 'active'
  )
$$;

create or replace function public.mw_dm_is_group_admin(gid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and exists (
    select 1 from public.mw_dm_group_members
    where group_id = gid and user_id = uid and join_status = 'active'
      and role in ('admin', 'co_admin')
  )
$$;

drop policy if exists mw_dm_groups_read on public.mw_dm_groups;
create policy mw_dm_groups_read on public.mw_dm_groups for select to authenticated
  using (
    join_mode in ('open', 'request_approval')
    or created_by = auth.uid()
    or public.mw_dm_is_group_member(id, auth.uid())
    or exists (
      select 1 from public.mw_dm_group_members gm
      where gm.group_id = id and gm.user_id = auth.uid() and gm.join_status in ('pending', 'invited')
    )
  );
drop policy if exists mw_dm_members_read on public.mw_dm_group_members;
create policy mw_dm_members_read on public.mw_dm_group_members for select to authenticated
  using (
    (user_id = auth.uid() and join_status in ('pending', 'invited'))
    or public.mw_dm_is_group_member(group_id, auth.uid())
    or public.mw_dm_is_group_admin(group_id, auth.uid())
  );
drop policy if exists mw_dm_members_add on public.mw_dm_group_members;
create policy mw_dm_members_add on public.mw_dm_group_members for insert to authenticated
  with check (public.mw_dm_is_group_admin(group_id, auth.uid()));

create or replace function public.mw_group_create_advanced(
  p_name text, p_caption text, p_description text, p_avatar_url text,
  p_join_mode text, p_members_can_invite boolean, p_members uuid[]
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  gid uuid;
  group_name text := btrim(coalesce(p_name, ''));
  mode text := coalesce(p_join_mode, 'invite_only');
  avatar text := btrim(coalesce(p_avatar_url, ''));
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if char_length(group_name) < 1 or char_length(group_name) > 70 then
    raise exception 'Group name must be 1-70 characters.' using errcode = '22023';
  end if;
  if mode not in ('open', 'request_approval', 'invite_only') then
    raise exception 'Invalid join mode.' using errcode = '22023';
  end if;
  if avatar <> '' and avatar !~* '^https://[^[:space:]]+$' then
    raise exception 'Group avatar must be an HTTPS URL.' using errcode = '22023';
  end if;
  insert into public.mw_dm_groups(name, caption, description, avatar_url, join_mode, members_can_invite, created_by)
  values (
    group_name, left(btrim(coalesce(p_caption, '')), 120),
    left(btrim(coalesce(p_description, '')), 1000), avatar, mode,
    coalesce(p_members_can_invite, true), me
  ) returning id into gid;
  insert into public.mw_dm_group_members(group_id, user_id, role, join_status)
    values (gid, me, 'admin', 'active');
  insert into public.mw_dm_group_members(group_id, user_id, role, join_status, invited_by)
    select gid, u.id, 'member',
      case when mode = 'invite_only' then 'invited' else 'active' end, me
    from auth.users u
    where u.id = any(coalesce(p_members, '{}'::uuid[])) and u.id <> me
      and not exists (
        select 1 from public.mw_blocks b
        where (b.blocker_id = me and b.blocked_id = u.id)
           or (b.blocker_id = u.id and b.blocked_id = me)
      )
    limit 255
    on conflict do nothing;
  return gid;
end $$;

-- Keep the original RPC safe for older clients that still call it directly.
create or replace function public.mw_group_create(p_name text, p_caption text, p_description text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  return public.mw_group_create_advanced(
    p_name, p_caption, p_description, '', 'invite_only', true, p_members
  );
end $$;

create or replace function public.mw_group_update_settings(
  p_group uuid, p_name text, p_caption text, p_description text,
  p_avatar_url text, p_join_mode text, p_members_can_invite boolean
) returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  group_name text := btrim(coalesce(p_name, ''));
  avatar text := btrim(coalesce(p_avatar_url, ''));
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (
    select 1 from public.mw_dm_groups where id = p_group and created_by = me
  ) then raise exception 'Only the group creator can edit group settings.' using errcode = '42501'; end if;
  if char_length(group_name) < 1 or char_length(group_name) > 70 then
    raise exception 'Group name must be 1-70 characters.' using errcode = '22023';
  end if;
  if coalesce(p_join_mode, '') not in ('open', 'request_approval', 'invite_only') then
    raise exception 'Invalid join mode.' using errcode = '22023';
  end if;
  if avatar <> '' and avatar !~* '^https://[^[:space:]]+$' then
    raise exception 'Group avatar must be an HTTPS URL.' using errcode = '22023';
  end if;
  update public.mw_dm_groups set
    name = group_name, caption = left(btrim(coalesce(p_caption, '')), 120),
    description = left(btrim(coalesce(p_description, '')), 1000),
    avatar_url = avatar, join_mode = p_join_mode,
    members_can_invite = coalesce(p_members_can_invite, true)
  where id = p_group;
end $$;

create or replace function public.mw_group_join(p_group uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  mode text;
  current_status text;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select join_mode into mode from public.mw_dm_groups where id = p_group for update;
  if mode is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.mw_dm_group_blocks where group_id = p_group and user_id = me) then
    raise exception 'You cannot join this group.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.mw_blocks b join public.mw_dm_groups g on g.id = p_group
    where (b.blocker_id = me and b.blocked_id = g.created_by)
       or (b.blocker_id = g.created_by and b.blocked_id = me)
  ) then raise exception 'You cannot join this group.' using errcode = '42501'; end if;
  select join_status into current_status
    from public.mw_dm_group_members where group_id = p_group and user_id = me;
  if current_status = 'active' then return 'active'; end if;
  if current_status = 'pending' then return 'pending'; end if;
  if current_status = 'invited' then
    update public.mw_dm_group_members set join_status = 'active', joined_at = now()
      where group_id = p_group and user_id = me;
    return 'active';
  end if;
  if mode = 'invite_only' then raise exception 'This group is invite-only.' using errcode = '42501'; end if;
  if (select count(*) from public.mw_dm_group_members
      where group_id = p_group and join_status in ('active', 'invited')) >= 256 then
    raise exception 'This group is full.' using errcode = '22023';
  end if;
  insert into public.mw_dm_group_members(group_id, user_id, role, join_status)
    values (p_group, me, 'member', case when mode = 'open' then 'active' else 'pending' end);
  return case when mode = 'open' then 'active' else 'pending' end;
end $$;

create or replace function public.mw_group_add_members(p_group uuid, p_users uuid[])
returns integer language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); room integer; added integer := 0; inviter_allowed boolean; mode text;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select g.members_can_invite, g.join_mode into inviter_allowed, mode
    from public.mw_dm_groups g where g.id = p_group for update;
  if mode is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  if not public.mw_dm_is_group_member(p_group, me) then
    raise exception 'Only group members can invite people.' using errcode = '42501';
  end if;
  if not public.mw_dm_is_group_admin(p_group, me) and not inviter_allowed then
    raise exception 'Member invitations are disabled.' using errcode = '42501';
  end if;
  select 256 - count(*) into room from public.mw_dm_group_members
    where group_id = p_group and join_status in ('active', 'invited');
  if room <= 0 then raise exception 'This group is full.' using errcode = '22023'; end if;
  with ins as (
    insert into public.mw_dm_group_members(group_id, user_id, role, join_status, invited_by)
    select p_group, u.id, 'member',
      case when mode = 'invite_only' then 'invited' else 'active' end, me
    from auth.users u
    where u.id = any(coalesce(p_users, '{}'::uuid[]))
      and u.id <> me
      and not exists (select 1 from public.mw_dm_group_blocks b where b.group_id = p_group and b.user_id = u.id)
      and not exists (
        select 1 from public.mw_blocks b
        where (b.blocker_id = me and b.blocked_id = u.id)
           or (b.blocker_id = u.id and b.blocked_id = me)
      )
    limit room
    on conflict do nothing returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

create or replace function public.mw_group_join_request_decide(p_group uuid, p_user uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  target_role text;
  active_count integer;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not public.mw_dm_is_group_admin(p_group, me) then
    raise exception 'Only admins and co-admins can review requests.' using errcode = '42501';
  end if;
  perform 1 from public.mw_dm_groups where id = p_group for update;
  select role into target_role from public.mw_dm_group_members
    where group_id = p_group and user_id = p_user and join_status = 'pending';
  if target_role is null then raise exception 'Join request not found.' using errcode = 'P0002'; end if;
  if p_approve then
    select count(*) into active_count from public.mw_dm_group_members
      where group_id = p_group and join_status in ('active', 'invited');
    if active_count >= 256 then raise exception 'This group is full.' using errcode = '22023'; end if;
    update public.mw_dm_group_members set join_status = 'active', joined_at = now()
      where group_id = p_group and user_id = p_user;
  else
    delete from public.mw_dm_group_members where group_id = p_group and user_id = p_user;
  end if;
end $$;

create or replace function public.mw_group_set_role(p_group uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); creator uuid; target_role text;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_role not in ('admin', 'co_admin', 'member') then raise exception 'Invalid role.' using errcode = '22023'; end if;
  select created_by into creator from public.mw_dm_groups where id = p_group;
  if creator is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  select role into target_role from public.mw_dm_group_members
    where group_id = p_group and user_id = p_user and join_status = 'active';
  if target_role is null then raise exception 'Not an active member.' using errcode = 'P0002'; end if;
  if p_role in ('admin', 'co_admin') or target_role in ('admin', 'co_admin') then
    if me <> creator then raise exception 'Only the group creator can change administrator roles.' using errcode = '42501'; end if;
  elsif not public.mw_dm_is_group_admin(p_group, me) then
    raise exception 'Only admins can change member roles.' using errcode = '42501';
  end if;
  if p_user = creator and p_role <> 'admin' then raise exception 'The creator must remain the primary admin.' using errcode = '42501'; end if;
  update public.mw_dm_group_members set role = p_role where group_id = p_group and user_id = p_user;
end $$;

create or replace function public.mw_group_remove_member(p_group uuid, p_user uuid, p_block boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  creator uuid;
  target_role text;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not public.mw_dm_is_group_admin(p_group, me) then
    raise exception 'Only admins and co-admins can remove members.' using errcode = '42501';
  end if;
  if p_user = me then raise exception 'Use leave instead.' using errcode = '22023'; end if;
  select created_by into creator from public.mw_dm_groups where id = p_group;
  if creator is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  if p_user = creator then raise exception 'The creator cannot be removed.' using errcode = '42501'; end if;
  select role into target_role from public.mw_dm_group_members
    where group_id = p_group and user_id = p_user;
  if target_role is null then raise exception 'Not a group member.' using errcode = 'P0002'; end if;
  if target_role in ('admin', 'co_admin') and me <> creator then
    raise exception 'Only the group creator can remove an admin or co-admin.' using errcode = '42501';
  end if;
  delete from public.mw_dm_group_members where group_id = p_group and user_id = p_user;
  if coalesce(p_block, false) then
    insert into public.mw_dm_group_blocks(group_id, user_id, blocked_by)
      values (p_group, p_user, me) on conflict do nothing;
  end if;
end $$;

create or replace function public.mw_group_update(p_group uuid, p_name text, p_caption text, p_description text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  group_name text := btrim(coalesce(p_name, ''));
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (select 1 from public.mw_dm_groups where id = p_group and created_by = me) then
    raise exception 'Only the group creator can edit group settings.' using errcode = '42501';
  end if;
  if char_length(group_name) < 1 or char_length(group_name) > 70 then
    raise exception 'Group name must be 1-70 characters.' using errcode = '22023';
  end if;
  update public.mw_dm_groups set
    name = group_name,
    caption = left(btrim(coalesce(p_caption, '')), 120),
    description = left(btrim(coalesce(p_description, '')), 1000)
  where id = p_group;
end $$;

create or replace function public.mw_group_leave(p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); was_admin boolean; was_creator boolean; successor uuid;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select role in ('admin', 'co_admin') into was_admin
    from public.mw_dm_group_members
    where group_id = p_group and user_id = me and join_status = 'active';
  if was_admin is null then raise exception 'You are not in this group.' using errcode = '42501'; end if;
  select created_by = me into was_creator from public.mw_dm_groups where id = p_group;
  delete from public.mw_dm_group_members where group_id = p_group and user_id = me;
  if was_admin and not exists (
    select 1 from public.mw_dm_group_members where group_id = p_group and join_status = 'active' and role = 'admin'
  ) then
    select user_id into successor from public.mw_dm_group_members
      where group_id = p_group and join_status = 'active' order by joined_at, user_id limit 1;
    if successor is not null then
      update public.mw_dm_group_members set role = 'admin' where group_id = p_group and user_id = successor;
      if was_creator then
        update public.mw_dm_groups set created_by = successor where id = p_group;
      end if;
    end if;
  end if;
  if not exists (select 1 from public.mw_dm_group_members where group_id = p_group and join_status = 'active') then
    delete from public.mw_dm_groups where id = p_group;
  end if;
end $$;

create or replace function public.mw_group_delete(p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (select 1 from public.mw_dm_groups where id = p_group and created_by = auth.uid()) then
    raise exception 'Only the group creator can delete the group.' using errcode = '42501';
  end if;
  delete from public.mw_dm_groups where id = p_group;
end $$;

revoke all on function public.mw_dm_is_group_member(uuid, uuid) from public, anon;
revoke all on function public.mw_dm_is_group_admin(uuid, uuid) from public, anon;
revoke all on function public.mw_group_create_advanced(text, text, text, text, text, boolean, uuid[]) from public, anon;
revoke all on function public.mw_group_update_settings(uuid, text, text, text, text, text, boolean) from public, anon;
revoke all on function public.mw_group_join(uuid) from public, anon;
revoke all on function public.mw_group_add_members(uuid, uuid[]) from public, anon;
revoke all on function public.mw_group_join_request_decide(uuid, uuid, boolean) from public, anon;
revoke all on function public.mw_group_set_role(uuid, uuid, text) from public, anon;
revoke all on function public.mw_group_remove_member(uuid, uuid, boolean) from public, anon;
revoke all on function public.mw_group_leave(uuid) from public, anon;
grant execute on function public.mw_dm_is_group_member(uuid, uuid) to authenticated;
grant execute on function public.mw_dm_is_group_admin(uuid, uuid) to authenticated;
grant execute on function public.mw_group_create_advanced(text, text, text, text, text, boolean, uuid[]) to authenticated;
grant execute on function public.mw_group_update_settings(uuid, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.mw_group_join(uuid) to authenticated;
grant execute on function public.mw_group_add_members(uuid, uuid[]) to authenticated;
grant execute on function public.mw_group_join_request_decide(uuid, uuid, boolean) to authenticated;
grant execute on function public.mw_group_set_role(uuid, uuid, text) to authenticated;
grant execute on function public.mw_group_remove_member(uuid, uuid, boolean) to authenticated;
grant execute on function public.mw_group_leave(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
