begin;

alter table public.mw_profiles
  add column if not exists username_auto_generated boolean not null default false,
  add column if not exists username_updated_at timestamptz;

do $$
declare
  profile_row record;
  base_handle text;
  candidate text;
  suffix integer;
begin
  for profile_row in
    select id, username
    from public.mw_profiles
    where username is not null and btrim(username) <> ''
    order by lower(username), id
  loop
    base_handle := lower(btrim(profile_row.username));
    base_handle := regexp_replace(base_handle, '[^a-z0-9._]+', '.', 'g');
    base_handle := regexp_replace(base_handle, '[._]{2,}', '.', 'g');
    base_handle := regexp_replace(base_handle, '^[.]+|[.]+$', '', 'g');
    base_handle := left(base_handle, 20);
    if length(base_handle) < 3 then base_handle := 'user'; end if;
    if base_handle = any(array['admin', 'milkyway', 'nova', 'support', 'official', 'moderator', 'system', 'orbit']) then
      base_handle := 'user';
    end if;
    candidate := base_handle;
    suffix := 0;
    while exists (
      select 1 from public.mw_profiles existing
      where existing.id <> profile_row.id and lower(existing.username) = candidate
    ) loop
      suffix := suffix + 1;
      candidate := left(base_handle, 20 - length(suffix::text)) || suffix::text;
    end loop;
    if profile_row.username <> candidate then
      update public.mw_profiles set username = candidate where id = profile_row.id;
    end if;
  end loop;
end;
$$;

create unique index if not exists mw_profiles_username_lower_key
  on public.mw_profiles (lower(username))
  where username is not null and btrim(username) <> '';

create or replace function public.mw_guard_profile_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  handle text;
  base_handle text;
  suffix integer := 0;
begin
  if tg_op = 'INSERT' then
    handle := lower(nullif(btrim(new.username), ''));
    if handle is not null then
      if handle !~ '^[a-z0-9_][a-z0-9._]{1,18}[a-z0-9_]$' then
        raise exception 'Username must be 3–20 lowercase letters, numbers, dots or underscores, and cannot start or end with a dot.'
          using errcode = '22023';
      end if;
      if handle = any(array['admin', 'milkyway', 'nova', 'support', 'official', 'moderator', 'system', 'orbit']) then
        raise exception 'That username is reserved.' using errcode = '22023';
      end if;
    end if;
    new.username := handle;
    if current_setting('mw.username_signup', true) is distinct from 'true' then
      new.username_auto_generated := false;
      new.username_updated_at := case when handle is null then null else now() end;
    end if;
    return new;
  end if;

  if new.username is not distinct from old.username then
    new.username_auto_generated := old.username_auto_generated;
    new.username_updated_at := old.username_updated_at;
    return new;
  end if;

  handle := lower(nullif(btrim(new.username), ''));
  if handle is null or handle !~ '^[a-z0-9_][a-z0-9._]{1,18}[a-z0-9_]$' then
    raise exception 'Username must be 3–20 lowercase letters, numbers, dots or underscores, and cannot start or end with a dot.'
      using errcode = '22023';
  end if;
  if handle = any(array['admin', 'milkyway', 'nova', 'support', 'official', 'moderator', 'system', 'orbit']) then
    raise exception 'That username is reserved.' using errcode = '22023';
  end if;
  if old.username is null or btrim(old.username) = '' then
    base_handle := handle;
    while exists (
      select 1 from public.mw_profiles existing
      where existing.id <> old.id and lower(existing.username) = handle
    ) loop
      suffix := suffix + 1;
      handle := left(base_handle, 20 - length(suffix::text)) || suffix::text;
      new.username_auto_generated := true;
    end loop;
    new.username := handle;
    new.username_auto_generated := coalesce(new.username_auto_generated, false);
    new.username_updated_at := case when new.username_auto_generated then null else now() end;
    return new;
  end if;
  new.username_auto_generated := old.username_auto_generated;
  new.username_updated_at := old.username_updated_at;
  if old.username is not null and btrim(old.username) <> ''
    and not coalesce(old.username_auto_generated, false)
    and old.username_updated_at is not null
    and old.username_updated_at > now() - interval '72 hours' then
    raise exception 'Username can be changed once every 72 hours.' using errcode = 'P0001';
  end if;

  new.username := handle;
  new.username_auto_generated := false;
  new.username_updated_at := now();
  return new;
end;
$$;

drop trigger if exists mw_guard_profile_username on public.mw_profiles;
create trigger mw_guard_profile_username
before insert or update of username, username_auto_generated, username_updated_at
on public.mw_profiles
for each row execute function public.mw_guard_profile_username();
revoke all on function public.mw_guard_profile_username() from public;

create or replace function public.mw_create_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_handle text := lower(nullif(btrim(new.raw_user_meta_data->>'username'), ''));
  handle text;
  display_name text := nullif(btrim(new.raw_user_meta_data->>'display_name'), '');
  generated boolean := coalesce(new.raw_user_meta_data->>'username_auto_generated', 'false') = 'true';
  base_handle text;
  suffix integer := 0;
begin
  handle := requested_handle;
  if requested_handle is null then generated := true; end if;
  if handle is not null and (handle !~ '^[a-z0-9_][a-z0-9._]{1,18}[a-z0-9_]$'
    or handle = any(array['admin', 'milkyway', 'nova', 'support', 'official', 'moderator', 'system', 'orbit'])) then
    handle := null;
    generated := true;
  end if;
  base_handle := coalesce(handle, left(regexp_replace(
    regexp_replace(lower(split_part(coalesce(new.email, ''), '@', 1)), '[^a-z0-9._]+', '.', 'g'),
    '^[._]+|[._]+$', '', 'g'), 20));
  base_handle := regexp_replace(base_handle, '[._]{2,}', '.', 'g');
  base_handle := left(regexp_replace(base_handle, '^[.]+|[.]+$', '', 'g'), 20);
  if length(base_handle) < 3 then base_handle := 'user'; end if;
  if base_handle = any(array['admin', 'milkyway', 'nova', 'support', 'official', 'moderator', 'system', 'orbit']) then
    base_handle := 'user';
    generated := true;
  end if;
  handle := base_handle;
  while exists (select 1 from public.mw_profiles existing where lower(existing.username) = handle) loop
    suffix := suffix + 1;
    handle := left(base_handle, 20 - length(suffix::text)) || suffix::text;
    generated := true;
  end loop;
  if display_name is null or display_name ~* '^[[:space:][:digit:][:punct:]]*$' then
    display_name := initcap(regexp_replace(
      regexp_replace(split_part(coalesce(new.email, ''), '@', 1), '[0-9]+$', '', 'g'),
      '[._-]+', ' ', 'g'));
    if display_name is null or length(btrim(display_name)) < 2 then display_name := 'MilkyWay User'; end if;
  end if;

  perform set_config('mw.username_signup', 'true', true);
  insert into public.mw_profiles (id, display_name, username, username_auto_generated, username_updated_at)
  values (new.id, display_name, handle, generated, case when generated or handle is null then null else now() end)
  on conflict (id) do update
  set display_name = excluded.display_name,
      username = coalesce(nullif(public.mw_profiles.username, ''), excluded.username),
      username_auto_generated = case when nullif(public.mw_profiles.username, '') is null
        then excluded.username_auto_generated else public.mw_profiles.username_auto_generated end,
      username_updated_at = case when nullif(public.mw_profiles.username, '') is null
        then excluded.username_updated_at else public.mw_profiles.username_updated_at end;
  perform set_config('mw.username_signup', '', true);

  return new;
end;
$$;

drop trigger if exists mw_create_auth_profile on auth.users;
create trigger mw_create_auth_profile
after insert on auth.users
for each row execute function public.mw_create_auth_profile();
revoke all on function public.mw_create_auth_profile() from public;

notify pgrst, 'reload schema';
commit;
