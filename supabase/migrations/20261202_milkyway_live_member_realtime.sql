-- Publish LIVE member changes so hosts receive guest requests and decisions immediately.
begin;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'mw_live_room_members'
    ) then
    alter publication supabase_realtime add table public.mw_live_room_members;
  end if;
end
$$;

commit;
