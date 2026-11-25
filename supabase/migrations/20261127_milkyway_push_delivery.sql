-- Native FCM devices and server-side push relay for posts and incoming calls.
begin;

create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

do $$
begin
  if to_regclass('public.mw_messages') is not null then
    execute 'drop trigger if exists mw_messages_fcm on public.mw_messages';
  end if;
  if to_regclass('public.mw_notifications') is not null then
    execute 'drop trigger if exists mw_notifications_fcm on public.mw_notifications';
  end if;
end;
$$;
drop function if exists public.mw_fcm_relay();

create table if not exists public.mw_fcm_devices (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'android' check (platform in ('android', 'ios', 'web')),
  updated_at timestamptz not null default now()
);
create index if not exists mw_fcm_devices_user_idx on public.mw_fcm_devices (user_id);
alter table public.mw_fcm_devices enable row level security;
revoke all on public.mw_fcm_devices from anon, authenticated;
grant select, insert, update, delete on public.mw_fcm_devices to authenticated;
drop policy if exists mw_fcm_devices_owner on public.mw_fcm_devices;
create policy mw_fcm_devices_owner on public.mw_fcm_devices for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.mw_fcm_device_register(p_token text, p_platform text default 'android')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if char_length(coalesce(p_token, '')) not between 20 and 4096
    or p_platform not in ('android', 'ios', 'web') then
    raise exception 'Invalid push device.' using errcode = '22023';
  end if;
  insert into public.mw_fcm_devices(token, user_id, platform, updated_at)
  values (p_token, me, p_platform, now())
  on conflict (token) do update set
    user_id = excluded.user_id,
    platform = excluded.platform,
    updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.mw_fcm_device_register(text, text) from public, anon;
grant execute on function public.mw_fcm_device_register(text, text) to authenticated;

-- A browser push endpoint belongs to one signed-in account on this browser profile.
delete from public.mw_push_subscriptions older
using public.mw_push_subscriptions newer
where older.endpoint = newer.endpoint
  and (older.created_at, older.id) < (newer.created_at, newer.id);
create unique index if not exists mw_push_subscriptions_endpoint_key
  on public.mw_push_subscriptions (endpoint);

create or replace function public.mw_push_subscription_register(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_endpoint !~ '^https://[^[:space:]]+$'
    or char_length(p_endpoint) > 2048
    or char_length(coalesce(p_p256dh, '')) not between 1 and 256
    or char_length(coalesce(p_auth, '')) not between 1 and 256 then
    raise exception 'Invalid push subscription.' using errcode = '22023';
  end if;
  insert into public.mw_push_subscriptions(user_id, endpoint, p256dh, auth)
  values (me, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth = excluded.auth;
end;
$$;
revoke all on function public.mw_push_subscription_register(text, text, text) from public, anon;
grant execute on function public.mw_push_subscription_register(text, text, text) to authenticated;

create or replace function public.mw_push_delivery_relay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
  payload jsonb;
begin
  select decrypted_secret into hook_secret
  from vault.decrypted_secrets
  where name = 'FCM_WEBHOOK_SECRET'
  limit 1;

  if coalesce(hook_secret, '') = '' then
    raise warning 'MilkyWay push relay skipped: FCM_WEBHOOK_SECRET is not stored in Supabase Vault.';
    return new;
  end if;

  if tg_table_name = 'mw_post_notifications' then
    payload := jsonb_build_object(
      'type', 'post',
      'record', jsonb_build_object(
        'recipient_id', new.recipient_id,
        'actor_name', new.actor_name,
        'post_id', new.post_id,
        'caption', new.caption
      )
    );
  elsif tg_table_name = 'mw_dm_calls' and new.status = 'ringing' then
    payload := jsonb_build_object(
      'type', 'call',
      'record', jsonb_build_object(
        'id', new.id,
        'caller_id', new.caller_id,
        'callee_id', new.callee_id,
        'status', new.status,
        'offer', new.offer,
        'created_at', new.created_at
      )
    );
  else
    return new;
  end if;

  perform net.http_post(
    url := 'https://masiyatunda.com/api/fcm?action=event',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', hook_secret
    ),
    body := payload
  );
  return new;
exception when others then
  raise warning 'MilkyWay push relay request failed: %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.mw_push_delivery_relay() from public, anon, authenticated;

drop trigger if exists mw_post_notifications_push on public.mw_post_notifications;
create trigger mw_post_notifications_push
  after insert on public.mw_post_notifications
  for each row execute function public.mw_push_delivery_relay();
drop trigger if exists mw_dm_calls_push on public.mw_dm_calls;
create trigger mw_dm_calls_push
  after insert on public.mw_dm_calls
  for each row execute function public.mw_push_delivery_relay();

commit;
notify pgrst, 'reload schema';
