begin;

create or replace function public.mw_watch_party_channel_access(p_topic text, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  channel_parts text[] := string_to_array(coalesce(p_topic, ''), ':');
  conversation_id uuid;
  other_user uuid;
begin
  if p_user is null
    or channel_parts[1] <> 'mw-watch'
  then
    return false;
  end if;

  if channel_parts[2] = 'dm' then
    if array_length(channel_parts, 1) <> 4
      or channel_parts[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or channel_parts[4] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      return false;
    end if;
    conversation_id := channel_parts[3]::uuid;
    other_user := channel_parts[4]::uuid;
    if conversation_id >= other_user or p_user not in (conversation_id, other_user) then
      return false;
    end if;
    other_user := case when p_user = conversation_id then other_user else conversation_id end;
    return exists (
      select 1
      from public.mw_messages message
      where (message.sender_id = p_user and message.receiver_id = other_user)
        or (message.sender_id = other_user and message.receiver_id = p_user)
    ) or public.mw_dm_contact_allowed(p_user, other_user);
  end if;
  if channel_parts[2] = 'group' then
    if array_length(channel_parts, 1) <> 3
      or channel_parts[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      return false;
    end if;
    conversation_id := channel_parts[3]::uuid;
    return public.mw_dm_is_group_member(conversation_id, p_user);
  end if;
  return false;
end
$$;

notify pgrst, 'reload schema';
commit;
