begin;

alter table public.mw_messages
  add column if not exists message_type text not null default 'text',
  add column if not exists media_url text not null default '',
  add column if not exists media_type text not null default '',
  add column if not exists media_metadata jsonb not null default '{}'::jsonb,
  add column if not exists view_once boolean not null default false,
  add column if not exists viewed_at timestamptz,
  add column if not exists viewed_by uuid references auth.users(id) on delete set null;

alter table public.mw_dm_group_messages
  add column if not exists message_type text not null default 'text',
  add column if not exists media_url text not null default '',
  add column if not exists media_type text not null default '',
  add column if not exists media_metadata jsonb not null default '{}'::jsonb,
  add column if not exists view_once boolean not null default false,
  add column if not exists viewed_at timestamptz,
  add column if not exists viewed_by uuid references auth.users(id) on delete set null;

alter table public.mw_messages drop constraint if exists mw_messages_message_type_check;
alter table public.mw_messages add constraint mw_messages_message_type_check
  check (message_type in ('text', 'image', 'video', 'voice_note', 'video_note', 'audio'));
alter table public.mw_dm_group_messages drop constraint if exists mw_dm_group_messages_message_type_check;
alter table public.mw_dm_group_messages add constraint mw_dm_group_messages_message_type_check
  check (message_type in ('text', 'image', 'video', 'voice_note', 'video_note', 'audio'));

create table if not exists public.mw_dm_ephemeral_payloads (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique,
  group_id uuid references public.mw_dm_groups(id) on delete cascade,
  body text not null default '',
  bucket text not null default '',
  object_path text not null default '',
  content_type text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((bucket = '' and object_path = '' and content_type = '')
      or (bucket = 'mw-dm-ephemeral' and object_path <> '' and content_type <> ''))
);
alter table public.mw_dm_ephemeral_payloads enable row level security;
revoke all on public.mw_dm_ephemeral_payloads from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'mw-dm-ephemeral', 'mw-dm-ephemeral', false, 52428800,
  array[
    'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
    'video/mp4','video/x-m4v','video/webm','video/quicktime','video/3gpp','video/3gpp2',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac','audio/wav'
  ]
)
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.mw_dm_ephemeral_media_allowed(p_bucket text, p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.uid() is not null and p_bucket = 'mw-dm-ephemeral' and (
    exists (
      select 1 from public.mw_dm_ephemeral_payloads p
      join public.mw_messages m on m.id = p.message_id
      where p.bucket = p_bucket and p.object_path = p_path
        and p.group_id is null and m.viewed_by = auth.uid()
        and (m.sender_id = auth.uid() or m.receiver_id = auth.uid())
    )
    or exists (
      select 1 from public.mw_dm_ephemeral_payloads p
      join public.mw_dm_group_messages m on m.id = p.message_id and m.group_id = p.group_id
      where p.bucket = p_bucket and p.object_path = p_path
        and public.mw_dm_is_group_member(m.group_id, auth.uid())
        and m.viewed_by = auth.uid()
    )
  ), false)
$$;
revoke all on function public.mw_dm_ephemeral_media_allowed(text, text) from public, anon;
grant execute on function public.mw_dm_ephemeral_media_allowed(text, text) to authenticated;

drop policy if exists mw_dm_ephemeral_upload on storage.objects;
create policy mw_dm_ephemeral_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'mw-dm-ephemeral'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists mw_dm_ephemeral_read on storage.objects;
create policy mw_dm_ephemeral_read on storage.objects for select to authenticated
  using (
    public.mw_dm_ephemeral_media_allowed(bucket_id, name)
  );
drop policy if exists mw_dm_ephemeral_delete on storage.objects;
create policy mw_dm_ephemeral_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'mw-dm-ephemeral'
    and (storage.foldername(name))[1] = auth.uid()::text
    or public.mw_dm_ephemeral_media_allowed(bucket_id, name)
  );

drop policy if exists mw_messages_delete_sender on public.mw_messages;
create policy mw_messages_delete_sender on public.mw_messages for delete to authenticated
  using (sender_id = auth.uid() and not view_once);
drop policy if exists mw_dm_group_messages_delete on public.mw_dm_group_messages;
create policy mw_dm_group_messages_delete on public.mw_dm_group_messages for delete to authenticated
  using (sender_id = auth.uid() and not view_once);

create or replace function public.mw_message_send_once(
  p_receiver uuid, p_group uuid, p_id uuid, p_body text, p_type text,
  p_bucket text, p_path text, p_content_type text, p_metadata jsonb
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  text_body text := btrim(coalesce(p_body, ''));
  kind text := coalesce(p_type, 'text');
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_id is null then raise exception 'Invalid message ID.' using errcode = '22023'; end if;
  if kind not in ('text', 'image', 'video', 'voice_note', 'video_note', 'audio') then
    raise exception 'Invalid media type.' using errcode = '22023';
  end if;
  if length(text_body) > 12000 then raise exception 'Message is too long.' using errcode = '22023'; end if;
  if p_group is not null and length(text_body) > 4000 then raise exception 'Message is too long.' using errcode = '22023'; end if;
  if coalesce(p_bucket, '') <> '' and (
    p_bucket <> 'mw-dm-ephemeral'
    or coalesce(p_path, '') !~ ('^' || me::text || '/' || p_id::text || '\.[A-Za-z0-9]{1,10}$')
    or coalesce(p_content_type, '') !~ '^(image|video|audio)/[A-Za-z0-9.+-]+$'
  ) then raise exception 'Invalid private media upload.' using errcode = '22023'; end if;
  if kind = 'text' and text_body = '' then raise exception 'Write a message first.' using errcode = '22023'; end if;
  if kind <> 'text' and (coalesce(p_path, '') = '' or coalesce(p_bucket, '') = '') then
    raise exception 'Media is missing.' using errcode = '22023';
  end if;

  if p_group is null then
    if p_receiver is null or p_receiver = me then raise exception 'Invalid conversation.' using errcode = '22023'; end if;
    insert into public.mw_messages(
      id, sender_id, receiver_id, body, message_type, media_type, media_metadata, view_once
    ) values (
      p_id, me, p_receiver,
      case when kind = 'text' then 'View-once message' else 'View-once media' end,
      kind, coalesce(p_content_type, ''), coalesce(p_metadata, '{}'::jsonb), true
    );
    insert into public.mw_dm_ephemeral_payloads(message_id, body, bucket, object_path, content_type, metadata)
      values (p_id, text_body, coalesce(p_bucket, ''), coalesce(p_path, ''), coalesce(p_content_type, ''), coalesce(p_metadata, '{}'::jsonb));
  else
    if not public.mw_dm_is_group_member(p_group, me) then
      raise exception 'Join this group before sending messages.' using errcode = '42501';
    end if;
    insert into public.mw_dm_group_messages(
      id, group_id, sender_id, body, message_type, media_type, media_metadata, view_once
    ) values (
      p_id, p_group, me,
      case when kind = 'text' then 'View-once message' else 'View-once media' end,
      kind, coalesce(p_content_type, ''), coalesce(p_metadata, '{}'::jsonb), true
    );
    insert into public.mw_dm_ephemeral_payloads(message_id, group_id, body, bucket, object_path, content_type, metadata)
      values (p_id, p_group, text_body, coalesce(p_bucket, ''), coalesce(p_path, ''), coalesce(p_content_type, ''), coalesce(p_metadata, '{}'::jsonb));
  end if;
  return jsonb_build_object(
    'id', p_id, 'sender_id', me, 'receiver_id', p_receiver, 'group_id', p_group,
    'body', case when kind = 'text' then 'View-once message' else 'View-once media' end,
    'message_type', kind, 'media_type', coalesce(p_content_type, ''),
    'media_metadata', coalesce(p_metadata, '{}'::jsonb), 'view_once', true,
    'created_at', now()
  );
end $$;

create or replace function public.mw_message_consume_once(p_id uuid, p_group uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  message_row jsonb;
  payload_row jsonb;
  sender uuid;
  recipient uuid;
  viewed timestamptz;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_group is null then
    select to_jsonb(m), m.sender_id, m.receiver_id, m.viewed_at
      into message_row, sender, recipient, viewed
      from public.mw_messages m where m.id = p_id for update;
    if message_row is null or recipient <> me or sender = me then
      raise exception 'Message not found.' using errcode = 'P0002';
    end if;
  else
    if not public.mw_dm_is_group_member(p_group, me) then
      raise exception 'You are not a group member.' using errcode = '42501';
    end if;
    select to_jsonb(m), m.sender_id, null::uuid, m.viewed_at
      into message_row, sender, recipient, viewed
      from public.mw_dm_group_messages m
      where m.id = p_id and m.group_id = p_group for update;
    if message_row is null or sender = me then raise exception 'Message not found.' using errcode = 'P0002'; end if;
  end if;
  if not coalesce((message_row->>'view_once')::boolean, false) or viewed is not null then
    raise exception 'This message has already been viewed.' using errcode = 'P0002';
  end if;
  select to_jsonb(p) into payload_row from public.mw_dm_ephemeral_payloads p where p.message_id = p_id;
  if payload_row is null then raise exception 'This message is no longer available.' using errcode = 'P0002'; end if;
  if p_group is null then
    update public.mw_messages set viewed_at = now(), viewed_by = me where id = p_id;
  else
    update public.mw_dm_group_messages set viewed_at = now(), viewed_by = me where id = p_id and group_id = p_group;
  end if;
  return jsonb_build_object('message', message_row, 'payload', payload_row);
end $$;

create or replace function public.mw_message_complete_once(p_id uuid, p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_group is null then
    if not exists (select 1 from public.mw_messages where id = p_id and viewed_by = me and view_once) then
      raise exception 'Message is no longer available.' using errcode = 'P0002';
    end if;
    delete from public.mw_dm_ephemeral_payloads where message_id = p_id;
    delete from public.mw_messages where id = p_id and viewed_by = me and view_once;
  else
    if not exists (
      select 1 from public.mw_dm_group_messages
      where id = p_id and group_id = p_group and viewed_by = me and view_once
    ) then raise exception 'Message is no longer available.' using errcode = 'P0002'; end if;
    delete from public.mw_dm_ephemeral_payloads where message_id = p_id and group_id = p_group;
    delete from public.mw_dm_group_messages where id = p_id and group_id = p_group and viewed_by = me and view_once;
  end if;
  if not found then raise exception 'Message is no longer available.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.mw_message_release_once(p_id uuid, p_group uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_group is null then
    update public.mw_messages set viewed_at = null, viewed_by = null
      where id = p_id and viewed_by = me and view_once;
  else
    update public.mw_dm_group_messages set viewed_at = null, viewed_by = null
      where id = p_id and group_id = p_group and viewed_by = me and view_once;
  end if;
end $$;

revoke all on function public.mw_message_send_once(uuid, uuid, uuid, text, text, text, text, text, jsonb) from public, anon;
revoke all on function public.mw_dm_ephemeral_media_allowed(text, text) from public, anon;
revoke all on function public.mw_message_consume_once(uuid, uuid) from public, anon;
revoke all on function public.mw_message_complete_once(uuid, uuid) from public, anon;
revoke all on function public.mw_message_release_once(uuid, uuid) from public, anon;
grant execute on function public.mw_message_send_once(uuid, uuid, uuid, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.mw_dm_ephemeral_media_allowed(text, text) to authenticated;
grant execute on function public.mw_message_consume_once(uuid, uuid) to authenticated;
grant execute on function public.mw_message_complete_once(uuid, uuid) to authenticated;
grant execute on function public.mw_message_release_once(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
