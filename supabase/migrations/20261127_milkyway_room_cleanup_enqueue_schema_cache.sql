-- Repair deployments where the authenticated room cleanup RPC was not installed or cached.
begin;

create table if not exists public.mw_room_cleanup_queue (
  room_name text primary key,
  requested_by uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text not null default ''
);

alter table public.mw_room_cleanup_queue
  add column if not exists room_name text,
  add column if not exists requested_by uuid references auth.users(id) on delete cascade,
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists lease_id uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists last_error text not null default '';

create unique index if not exists mw_room_cleanup_queue_room_name_uidx
  on public.mw_room_cleanup_queue (room_name);
grant usage on schema public to authenticated;
alter table public.mw_room_cleanup_queue enable row level security;
revoke all on public.mw_room_cleanup_queue from public, anon, authenticated;

create or replace function public.mw_room_cleanup_enqueue(p_room_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  owner_allowed boolean := false;
  call_id uuid;
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
