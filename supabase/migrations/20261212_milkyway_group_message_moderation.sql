begin;

drop policy if exists mw_dm_group_messages_delete on public.mw_dm_group_messages;
create policy mw_dm_group_messages_delete on public.mw_dm_group_messages
  for delete to authenticated
  using (
    sender_id = auth.uid()
    or public.mw_dm_is_group_admin(group_id, auth.uid())
  );

create or replace function public.mw_group_delete(p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (
    select 1 from public.mw_dm_groups
    where id = p_group and created_by = me
  ) and not exists (
    select 1 from public.mw_dm_group_members
    where group_id = p_group and user_id = me
      and role in ('admin', 'co_admin', 'owner')
      and (join_status in ('active', 'approved') or role in ('admin', 'co_admin', 'owner'))
  ) then
    raise exception 'Only group admins or the creator can delete the group.' using errcode = '42501';
  end if;
  delete from public.mw_dm_groups where id = p_group;
end $$;

notify pgrst, 'reload schema';
commit;
