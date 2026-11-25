begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mw_live_alerts' and column_name = 'room_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mw_live_alerts' and column_name = 'room'
  ) then
    alter table public.mw_live_alerts rename column room_name to room;
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mw_live_alerts' and column_name = 'room_name'
  ) then
    update public.mw_live_alerts set room = coalesce(room, room_name) where room is null;
  end if;
end;
$$;

create unique index if not exists mw_live_alerts_recipient_room_idx
  on public.mw_live_alerts (recipient_id, room);

create or replace function public.mw_live_announce(p_room text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  live record;
  cursor_id uuid := null;
  batch_ids uuid[];
  added integer;
  total integer := 0;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select s.host_id, s.host_name, s.title into live
  from public.mw_video_live_sessions s
  where s.room_name = p_room and s.host_id = me and s.is_live
  limit 1;
  if not found then raise exception 'Not allowed.' using errcode = '42501'; end if;
  loop
    select coalesce(array_agg(r.recipient_id order by r.recipient_id), '{}') into batch_ids
    from public.mw_live_notification_recipients(me, cursor_id) r;
    exit when coalesce(array_length(batch_ids, 1), 0) = 0;
    insert into public.mw_live_alerts (recipient_id, host_id, room, host_name, title)
    select t.id, me, p_room, live.host_name, live.title
    from unnest(batch_ids) as t(id)
    where coalesce((select pref.live_enabled from public.mw_notification_preferences pref where pref.user_id = t.id), true)
    on conflict (recipient_id, room) do nothing;
    get diagnostics added = row_count;
    total := total + added;
    cursor_id := batch_ids[array_length(batch_ids, 1)];
    exit when array_length(batch_ids, 1) < 500;
  end loop;
  return jsonb_build_object('complete', true, 'notified', total);
end;
$$;

notify pgrst, 'reload schema';
commit;
