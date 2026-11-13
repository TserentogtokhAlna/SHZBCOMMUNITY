-- ============================================================
-- SHZB Community — migration 009: past events
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migration_006_platform.sql.
--
-- Leaders can record an event that already happened (for example from
-- before the club joined the site) directly into the club's Event History:
-- a date in the past, a description and up to 3 photos. Like every post it
-- needs admin approval. Same function signature as before, so nothing else
-- changes; the approval queue labels these "Past event".
-- ============================================================

begin;

create or replace function public.submit_club_post(
  p_club uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_event_date date default null,
  p_start_time time default null,
  p_end_time time default null,
  p_location text default '',
  p_cover_url text default null,
  p_parent_event uuid default null,
  p_photos text[] default '{}',
  p_post_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_club public.clubs;
  v_post public.club_posts;
  v_parent public.club_posts;
  v_id uuid;
  v_photo text;
  v_pos smallint := 0;
  v_was_pending boolean := false;
  v_kind_label text;
begin
  v_me := public.require_leader(p_club);
  select * into v_club from public.clubs where id = p_club;
  if not found or v_club.status <> 'approved' then
    raise exception 'Only active clubs can publish content.';
  end if;

  if p_post_id is not null then
    select * into v_post from public.club_posts where id = p_post_id for update;
    if not found or v_post.club_id <> p_club then raise exception 'Post not found.'; end if;
    if v_post.status not in ('pending', 'changes_requested') then
      raise exception 'Only pending posts or posts returned for changes can be edited.';
    end if;
    p_kind := v_post.kind;
    v_was_pending := v_post.status = 'pending';
  end if;

  if p_kind not in ('announcement', 'event', 'event_result') then
    raise exception 'Invalid post type.';
  end if;

  p_title := btrim(coalesce(p_title, ''));
  p_body := btrim(coalesce(p_body, ''));
  p_location := btrim(coalesce(p_location, ''));
  p_photos := coalesce(p_photos, '{}');

  if char_length(p_title) not between 3 and 150 then
    raise exception 'Title must be between 3 and 150 characters.';
  end if;
  if char_length(p_body) > 5000 then
    raise exception 'Description is too long (max 5000 characters).';
  end if;
  if char_length(p_location) > 200 then
    raise exception 'Location is too long (max 200 characters).';
  end if;
  if not public.is_media_url(p_cover_url) then
    raise exception 'The poster must be an image uploaded through the site.';
  end if;

  if p_kind = 'event' then
    if p_event_date is null then raise exception 'Please choose the event date.'; end if;
    if p_end_time is not null and p_start_time is null then raise exception 'Add a start time too.'; end if;
    if p_start_time is not null and p_end_time is not null and p_end_time < p_start_time then
      raise exception 'The end time must be after the start time.';
    end if;
    if p_event_date < public.school_today() then
      -- a past event recorded straight into the club's history (e.g. from
      -- before the club joined the site): description required, 0-3 photos
      if p_body = '' then raise exception 'Please describe the event.'; end if;
      if cardinality(p_photos) > 3 then raise exception 'Add at most 3 photos.'; end if;
    elsif cardinality(p_photos) > 0 then
      raise exception 'Upcoming events use a single poster image.';
    end if;
    p_parent_event := null;
  elsif p_kind = 'event_result' then
    if p_parent_event is null then raise exception 'Choose which event these results are for.'; end if;
    select * into v_parent from public.club_posts where id = p_parent_event;
    if not found or v_parent.club_id <> p_club or v_parent.kind <> 'event' or v_parent.status <> 'approved' then
      raise exception 'Results can only be added to one of this club''s approved events.';
    end if;
    if v_parent.event_date > public.school_today() then
      raise exception 'Results can be posted once the event has taken place.';
    end if;
    if p_body = '' then raise exception 'Please describe the results.'; end if;
    if cardinality(p_photos) not between 1 and 3 then raise exception 'Add between 1 and 3 photos.'; end if;
    -- the date of a result post is the date it is published
    p_event_date := null; p_start_time := null; p_end_time := null; p_location := ''; p_cover_url := null;
  else
    if p_body = '' then raise exception 'Please write the announcement.'; end if;
    if cardinality(p_photos) > 0 then raise exception 'Announcements use a single image.'; end if;
    p_event_date := null; p_start_time := null; p_end_time := null; p_location := ''; p_parent_event := null;
  end if;

  foreach v_photo in array p_photos loop
    if v_photo is null or v_photo = '' or not public.is_media_url(v_photo) then
      raise exception 'Photos must be images uploaded through the site.';
    end if;
  end loop;

  if p_post_id is null then
    insert into public.club_posts
      (club_id, kind, title, body, event_date, start_time, end_time, location, cover_url, parent_event_id, created_by)
    values
      (p_club, p_kind, p_title, p_body, p_event_date, p_start_time, p_end_time, p_location,
       nullif(p_cover_url, ''), p_parent_event, v_me.id)
    returning id into v_id;
  else
    update public.club_posts
    set title = p_title, body = p_body, event_date = p_event_date, start_time = p_start_time,
        end_time = p_end_time, location = p_location, cover_url = nullif(p_cover_url, ''),
        parent_event_id = p_parent_event, status = 'pending', submitted_at = now(), updated_at = now()
    where id = p_post_id;
    v_id := p_post_id;
    delete from public.club_post_photos where post_id = v_id;
  end if;

  foreach v_photo in array p_photos loop
    v_pos := v_pos + 1;
    insert into public.club_post_photos (post_id, url, position) values (v_id, v_photo, v_pos);
  end loop;

  if not v_was_pending then
    v_kind_label := case
      when p_kind = 'event' and p_event_date < public.school_today() then 'past event'
      when p_kind = 'event' then 'event announcement'
      when p_kind = 'event_result' then 'event results update'
      else 'announcement'
    end;
    perform public.notify_admins(
      'New content for approval',
      format('%s submitted a %s for %s: "%s".', public.person_name(v_me.id), v_kind_label, v_club.name, p_title),
      '/admin.html#approvals'
    );
  end if;
  return v_id;
end;
$$;

create or replace view public.approval_queue
with (security_invoker = true)
as
  select 'club'::text as kind, 'New club'::text as kind_label,
         c.id, c.id as club_id, c.name as club_name, c.name as title,
         c.created_by as submitted_by, c.submitted_at, c.status, c.review_note
  from public.clubs c
  where c.status in ('pending', 'changes_requested', 'rejected')
     or (c.status = 'approved' and c.reviewed_at is not null)
  union all
  select 'club_change', 'Club profile change',
         r.id, r.club_id, c.name, r.name, r.submitted_by, r.submitted_at, r.status, r.review_note
  from public.club_change_requests r join public.clubs c on c.id = r.club_id
  union all
  select 'questionnaire', 'Recruitment form',
         q.id, q.club_id, c.name, q.title || ' (v' || q.version || ')', q.created_by,
         coalesce(q.submitted_at, q.created_at), q.status, q.review_note
  from public.questionnaires q join public.clubs c on c.id = q.club_id
  where q.status in ('pending', 'changes_requested', 'rejected', 'approved')
  union all
  select 'post',
         case
           when p.kind = 'event' and p.event_date < (p.submitted_at at time zone 'Asia/Ulaanbaatar')::date then 'Past event'
           when p.kind = 'event' then 'Event announcement'
           when p.kind = 'event_result' then 'Event results'
           else 'Club announcement'
         end,
         p.id, p.club_id, c.name, p.title, p.created_by, p.submitted_at, p.status, p.review_note
  from public.club_posts p join public.clubs c on c.id = p.club_id
  where p.reviewed_at is not null or p.status = 'pending'
  union all
  select 'achievement', 'Achievement',
         a.id, a.club_id, c.name, a.title, a.created_by, a.submitted_at, a.status, a.review_note
  from public.club_achievements a join public.clubs c on c.id = a.club_id;

commit;
