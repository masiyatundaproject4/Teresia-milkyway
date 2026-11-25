begin;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'mw-group-walkie', 'mw-group-walkie', false, 26214400,
  array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav']
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists mw_group_walkie_upload on storage.objects;
create policy mw_group_walkie_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'mw-group-walkie'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] = auth.uid()::text
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.mw_dm_is_group_member(((storage.foldername(name))[1])::uuid, auth.uid())
      else false
    end
  );

drop policy if exists mw_group_walkie_read on storage.objects;
create policy mw_group_walkie_read on storage.objects for select to authenticated
  using (
    bucket_id = 'mw-group-walkie'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.mw_dm_is_group_member(((storage.foldername(name))[1])::uuid, auth.uid())
      else false
    end
  );

drop policy if exists mw_group_walkie_delete on storage.objects;
create policy mw_group_walkie_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'mw-group-walkie'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] = auth.uid()::text
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

commit;
