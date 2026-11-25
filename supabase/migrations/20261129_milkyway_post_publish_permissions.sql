-- Allow signed-in users to publish their own posts while keeping protected accounts unable to publish.
begin;

grant insert (
  author_id, author_name, caption, media_url, media_type,
  media_items, media_preview_items, audio_url, slideshow_style, scheduled_at
) on public.mw_posts to authenticated;

drop policy if exists mw_posts_insert_own on public.mw_posts;
create policy mw_posts_insert_own on public.mw_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and not exists (
      select 1
      from public.mw_profiles profile
      where profile.id = (select auth.uid())
        and (
          coalesce((to_jsonb(profile)->>'is_banned')::boolean, false)
          or (to_jsonb(profile)->>'suspended_until' is not null
            and (to_jsonb(profile)->>'suspended_until')::timestamptz > now())
        )
    )
  );

commit;
notify pgrst, 'reload schema';
