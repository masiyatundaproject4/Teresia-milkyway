begin;

create table if not exists public.mw_follow_requests (
  requester_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (requester_id, target_id),
  check (requester_id <> target_id)
);

alter table public.mw_follow_requests enable row level security;
drop policy if exists mw_follow_requests_read on public.mw_follow_requests;
create policy mw_follow_requests_read on public.mw_follow_requests
  for select to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());
drop policy if exists mw_follow_requests_create on public.mw_follow_requests;
create policy mw_follow_requests_create on public.mw_follow_requests
  for insert to authenticated
  with check (
    requester_id = auth.uid()
    and exists (
      select 1 from public.mw_profiles profile
      where profile.id = target_id and coalesce(profile.is_private, false)
    )
    and not exists (
      select 1 from public.mw_follows follow
      where follow.follower_id = requester_id and follow.following_id = target_id
    )
  );
drop policy if exists mw_follow_requests_delete on public.mw_follow_requests;
create policy mw_follow_requests_delete on public.mw_follow_requests
  for delete to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

grant select, insert, delete on public.mw_follow_requests to authenticated;

create or replace function public.mw_accept_follow_request(requester uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or requester = auth.uid() then
    raise exception 'Not authorized to accept this follow request.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.mw_follow_requests request
    where request.requester_id = requester and request.target_id = auth.uid()
  ) then
    raise exception 'This follow request is no longer available.' using errcode = 'P0002';
  end if;
  insert into public.mw_follows (follower_id, following_id)
  values (requester, auth.uid())
  on conflict do nothing;
  delete from public.mw_follow_requests
  where requester_id = requester and target_id = auth.uid();
end;
$$;

revoke all on function public.mw_accept_follow_request(uuid) from public;
grant execute on function public.mw_accept_follow_request(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
