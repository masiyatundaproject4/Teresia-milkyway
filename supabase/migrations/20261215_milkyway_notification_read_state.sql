begin;

alter table public.mw_post_notifications
  add column if not exists read_at timestamptz;

drop policy if exists mw_post_notifications_recipient_update on public.mw_post_notifications;
create policy mw_post_notifications_recipient_update on public.mw_post_notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());
grant update (read_at) on public.mw_post_notifications to authenticated;

create table if not exists public.mw_dm_group_reads (
  group_id uuid not null references public.mw_dm_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.mw_dm_group_reads enable row level security;
drop policy if exists mw_dm_group_reads_select_own on public.mw_dm_group_reads;
create policy mw_dm_group_reads_select_own on public.mw_dm_group_reads
  for select to authenticated using (user_id = auth.uid());
grant select on public.mw_dm_group_reads to authenticated;

create or replace function public.mw_dm_group_mark_read(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.mw_dm_group_members
    where group_id = p_group and user_id = auth.uid()
  ) then
    raise exception 'Group membership not found.';
  end if;
  insert into public.mw_dm_group_reads (group_id, user_id, read_at)
  values (p_group, auth.uid(), now())
  on conflict (group_id, user_id) do update set read_at = excluded.read_at;
end;
$$;
revoke all on function public.mw_dm_group_mark_read(uuid) from public, anon;
grant execute on function public.mw_dm_group_mark_read(uuid) to authenticated;

create or replace function public.mw_dm_call_notification_read(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mw_dm_calls c
  set answer = coalesce(case when jsonb_typeof(c.answer) = 'object' then c.answer else '{}'::jsonb end, '{}'::jsonb)
    || jsonb_build_object(
      'notification_read_by',
      (case when jsonb_typeof(c.answer->'notification_read_by') = 'array'
        then c.answer->'notification_read_by' else '[]'::jsonb end)
        || jsonb_build_array(auth.uid()::text)
    )
  where c.id = p_call and c.callee_id = auth.uid();
  if not found then
    raise exception 'Call notification not found.';
  end if;
end;
$$;
revoke all on function public.mw_dm_call_notification_read(uuid) from public, anon;
grant execute on function public.mw_dm_call_notification_read(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
