-- Repair deployments where Creator Studio table creation was skipped or partially applied.
begin;

create table if not exists public.mw_creator_services (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 80),
  category text not null check (char_length(category) between 2 and 60),
  description text not null check (char_length(description) between 10 and 1000),
  pricing text not null default '' check (char_length(pricing) <= 100),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mw_creator_services
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists creator_id uuid references auth.users(id) on delete cascade,
  add column if not exists title text,
  add column if not exists category text,
  add column if not exists description text,
  add column if not exists pricing text not null default '',
  add column if not exists is_published boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists mw_creator_services_public_idx
  on public.mw_creator_services (creator_id, created_at desc) where is_published;

alter table public.mw_creator_services enable row level security;
drop policy if exists mw_creator_services_read on public.mw_creator_services;
create policy mw_creator_services_read on public.mw_creator_services for select to anon, authenticated
  using (is_published or creator_id = (select auth.uid()));
drop policy if exists mw_creator_services_owner on public.mw_creator_services;
create policy mw_creator_services_owner on public.mw_creator_services for all to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

grant usage on schema public to anon, authenticated;
grant select on public.mw_creator_services to anon, authenticated;
grant insert, update, delete on public.mw_creator_services to authenticated;

commit;
notify pgrst, 'reload schema';
