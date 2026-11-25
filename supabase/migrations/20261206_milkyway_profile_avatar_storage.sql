-- Profile photos use the public portfolio bucket but are isolated to the signed-in user's avatar folder.
begin;

insert into storage.buckets(id, name, public)
values ('portfolio', 'portfolio', true)
on conflict (id) do update set public = true;

drop policy if exists mw_profile_avatar_insert on storage.objects;
create policy mw_profile_avatar_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'portfolio'
    and (storage.foldername(name))[1] = 'milkyway'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'avatars'
  );

drop policy if exists mw_profile_avatar_delete on storage.objects;
create policy mw_profile_avatar_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'portfolio'
    and (storage.foldername(name))[1] = 'milkyway'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'avatars'
  );

commit;
