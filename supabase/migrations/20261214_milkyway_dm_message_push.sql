-- Send private, content-free push alerts for newly received direct messages.
begin;

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
  elsif tg_table_name = 'mw_messages' and new.sender_id <> new.receiver_id then
    payload := jsonb_build_object(
      'type', 'message',
      'record', jsonb_build_object(
        'sender_id', new.sender_id,
        'receiver_id', new.receiver_id
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

drop trigger if exists mw_messages_push on public.mw_messages;
create trigger mw_messages_push
  after insert on public.mw_messages
  for each row execute function public.mw_push_delivery_relay();

commit;
notify pgrst, 'reload schema';
