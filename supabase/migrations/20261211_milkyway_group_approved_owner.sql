begin;

alter table public.mw_dm_group_members
  drop constraint if exists mw_dm_group_members_role_check,
  drop constraint if exists mw_dm_group_members_join_status_check;
alter table public.mw_dm_group_members
  add constraint mw_dm_group_members_role_check check (role in ('admin', 'co_admin', 'member', 'owner')),
  add constraint mw_dm_group_members_join_status_check check (join_status in ('active', 'approved', 'pending', 'invited'));

create or replace function public.mw_dm_is_group_member(gid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and (
    exists (
      select 1 from public.mw_dm_group_members
      where group_id = gid and user_id = uid
        and (join_status in ('active', 'approved') or role in ('admin', 'owner'))
    )
    or exists (
      select 1 from public.mw_dm_groups
      where id = gid and created_by = uid
    )
  )
$$;

create or replace function public.mw_dm_is_group_admin(gid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select uid = auth.uid() and (
    exists (
      select 1 from public.mw_dm_group_members
      where group_id = gid and user_id = uid
        and (join_status in ('active', 'approved') or role in ('admin', 'co_admin', 'owner'))
        and role in ('admin', 'co_admin', 'owner')
    )
    or exists (
      select 1 from public.mw_dm_groups
      where id = gid and created_by = uid
    )
  )
$$;

create or replace function public.mw_group_set_role(p_group uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  creator uuid;
  target_role text;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_role not in ('admin', 'co_admin', 'member') then raise exception 'Invalid role.' using errcode = '22023'; end if;
  select created_by into creator from public.mw_dm_groups where id = p_group;
  if creator is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  select role into target_role from public.mw_dm_group_members
    where group_id = p_group and user_id = p_user
      and (join_status in ('active', 'approved') or role in ('admin', 'owner'));
  if target_role is null then raise exception 'Not an active member.' using errcode = 'P0002'; end if;
  if p_role in ('admin', 'co_admin') or target_role in ('admin', 'co_admin', 'owner') then
    if me <> creator then raise exception 'Only the group creator can change administrator roles.' using errcode = '42501'; end if;
  elsif not public.mw_dm_is_group_admin(p_group, me) then
    raise exception 'Only admins can change member roles.' using errcode = '42501';
  end if;
  if p_user = creator and p_role <> 'admin' then raise exception 'The creator must remain the primary admin.' using errcode = '42501'; end if;
  update public.mw_dm_group_members set role = p_role where group_id = p_group and user_id = p_user;
end $$;

create or replace function public.mw_group_leave(p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  was_admin boolean;
  was_creator boolean;
  successor uuid;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select role in ('admin', 'co_admin', 'owner') into was_admin
    from public.mw_dm_group_members
    where group_id = p_group and user_id = me
      and (join_status in ('active', 'approved') or role in ('admin', 'owner'));
  if was_admin is null then raise exception 'You are not in this group.' using errcode = '42501'; end if;
  select created_by = me into was_creator from public.mw_dm_groups where id = p_group;
  delete from public.mw_dm_group_members where group_id = p_group and user_id = me;
  if was_admin and not exists (
    select 1 from public.mw_dm_group_members
    where group_id = p_group and join_status in ('active', 'approved') and role in ('admin', 'owner')
  ) then
    select user_id into successor from public.mw_dm_group_members
      where group_id = p_group and (join_status in ('active', 'approved') or role in ('admin', 'owner'))
      order by joined_at, user_id limit 1;
    if successor is not null then
      update public.mw_dm_group_members set role = 'admin' where group_id = p_group and user_id = successor;
      if was_creator then
        update public.mw_dm_groups set created_by = successor where id = p_group;
      end if;
    end if;
  end if;
  if not exists (
    select 1 from public.mw_dm_group_members
    where group_id = p_group and (join_status in ('active', 'approved') or role in ('admin', 'owner'))
  ) then
    delete from public.mw_dm_groups where id = p_group;
  end if;
end $$;

create or replace function public.mw_group_delete(p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (
    select 1 from public.mw_dm_groups
    where id = p_group and created_by = me
  ) and not exists (
    select 1 from public.mw_dm_group_members
    where group_id = p_group and user_id = me
      and role in ('admin', 'owner')
      and (join_status in ('active', 'approved') or role in ('admin', 'owner'))
  ) then
    raise exception 'Only group admins or the creator can delete the group.' using errcode = '42501';
  end if;
  delete from public.mw_dm_groups where id = p_group;
end $$;

notify pgrst, 'reload schema';
commit;
