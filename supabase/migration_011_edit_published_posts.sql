-- ============================================================
-- SHZB Community — migration 011: edit & delete published posts
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migrations 006 and 009 (and 010 if you use it).
--
-- * Leaders can edit a published post: the change is saved as a pending
--   edit (club_post_edits) and the published version stays visible until an
--   administrator approves it in the Approval Center.
-- * Leaders can delete their own published posts.
-- * Administrators can edit (directly) and delete any post — they already
--   have full access to club_posts through RLS; the admin dashboard now
--   has buttons for it.
-- Function signatures are unchanged.
-- ============================================================

begin;

create table if not exists public.club_post_edits (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.club_posts(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  body text not null default '' check (char_length(body) <= 5000),
  event_date date,
  start_time time,
  end_time time,
  location text not null default '' check (char_length(location) <= 200),
  cover_url text,
  photos text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'changes_requested', 'rejected', 'approved')),
  review_note text not null default '',
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);

-- at most one open edit per post
create unique index if not exists club_post_edits_one_open
  on public.club_post_edits (post_id) where status in ('pending', 'changes_requested');

alter table public.club_post_edits enable row level security;

drop policy if exists "club_post_edits_select_leader" on public.club_post_edits;
create policy "club_post_edits_select_leader" on public.club_post_edits
  for select to authenticated
  using (exists (select 1 from public.club_posts p where p.id = post_id and public.is_club_leader(p.club_id)));

drop policy if exists "club_post_edits_admin" on public.club_post_edits;
create policy "club_post_edits_admin" on public.club_post_edits
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

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
  v_is_edit boolean := false;
  v_old_edit_status text;
begin
  v_me := public.require_leader(p_club);
  select * into v_club from public.clubs where id = p_club;
  if not found or v_club.status <> 'approved' then
    raise exception 'Only active clubs can publish content.';
  end if;

  if p_post_id is not null then
    select * into v_post from public.club_posts where id = p_post_id for update;
    if not found or v_post.club_id <> p_club then raise exception 'Post not found.'; end if;
    if v_post.status = 'rejected' then
      raise exception 'Rejected posts can''t be edited. Create a new post instead.';
    end if;
    -- editing a published post creates a pending edit; the published
    -- version stays visible until an administrator approves the change
    v_is_edit := v_post.status = 'approved';
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

  if v_is_edit then
    select status into v_old_edit_status from public.club_post_edits
    where post_id = p_post_id and status in ('pending', 'changes_requested')
    for update;
    if found then
      update public.club_post_edits
      set title = p_title, body = p_body, event_date = p_event_date, start_time = p_start_time,
          end_time = p_end_time, location = p_location, cover_url = nullif(p_cover_url, ''),
          photos = p_photos, status = 'pending', submitted_by = v_me.id, submitted_at = now()
      where post_id = p_post_id and status in ('pending', 'changes_requested');
    else
      insert into public.club_post_edits
        (post_id, title, body, event_date, start_time, end_time, location, cover_url, photos, submitted_by)
      values
        (p_post_id, p_title, p_body, p_event_date, p_start_time, p_end_time, p_location,
         nullif(p_cover_url, ''), p_photos, v_me.id);
    end if;
    if v_old_edit_status is distinct from 'pending' then
      perform public.notify_admins(
        'Edit to a published post',
        format('%s submitted changes to "%s" (%s).', public.person_name(v_me.id), v_post.title, v_club.name),
        '/admin.html#approvals'
      );
    end if;
    return p_post_id;
  end if;

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

create or replace function public.withdraw_submission(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_club uuid;
  v_status text;
  v_creator uuid;
begin
  if p_kind = 'post' then
    select club_id, status into v_club, v_status from public.club_posts where id = p_id;
    if v_club is null then raise exception 'Post not found.'; end if;
    perform public.require_leader(v_club);
    -- leaders may also delete their own published posts (results linked to
    -- a deleted event stay, just no longer attached to it)
    delete from public.club_posts where id = p_id;
  elsif p_kind = 'post_edit' then
    select p.club_id, e.status into v_club, v_status
    from public.club_post_edits e join public.club_posts p on p.id = e.post_id
    where e.id = p_id;
    if v_club is null then raise exception 'Edit not found.'; end if;
    perform public.require_leader(v_club);
    if v_status not in ('pending', 'changes_requested') then raise exception 'This edit has already been decided.'; end if;
    delete from public.club_post_edits where id = p_id;
  elsif p_kind = 'achievement' then
    select club_id, status into v_club, v_status from public.club_achievements where id = p_id;
    if v_club is null then raise exception 'Achievement not found.'; end if;
    perform public.require_leader(v_club);
    if v_status = 'approved' then raise exception 'Published achievements can''t be withdrawn. Ask an administrator.'; end if;
    delete from public.club_achievements where id = p_id;
  elsif p_kind = 'club_change' then
    select club_id, status into v_club, v_status from public.club_change_requests where id = p_id;
    if v_club is null then raise exception 'Request not found.'; end if;
    perform public.require_leader(v_club);
    if v_status not in ('pending', 'changes_requested') then raise exception 'This request has already been decided.'; end if;
    delete from public.club_change_requests where id = p_id;
  elsif p_kind = 'club' then
    v_me := public.require_active_profile();
    select created_by, status into v_creator, v_status from public.clubs where id = p_id;
    if v_creator is distinct from v_me.id then raise exception 'Club request not found.'; end if;
    if v_status not in ('pending', 'changes_requested', 'rejected') then
      raise exception 'Approved clubs can''t be withdrawn.';
    end if;
    delete from public.clubs where id = p_id;
  else
    raise exception 'Invalid submission type.';
  end if;
end;
$$;

create or replace function public.review_submission(
  p_kind text,
  p_id uuid,
  p_decision text,
  p_note text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin public.profiles;
  v_note text := btrim(coalesce(p_note, ''));
  v_label text;
  v_suffix text;
  v_club public.clubs;
  v_req public.club_change_requests;
  v_q public.questionnaires;
  v_post public.club_posts;
  v_ach public.club_achievements;
  v_edit public.club_post_edits;
  v_leader uuid;
begin
  v_admin := public.require_admin();
  if p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'Invalid decision.';
  end if;
  if p_decision <> 'approved' and v_note = '' then
    raise exception 'Please add a note explaining what needs to change or why it was rejected.';
  end if;
  v_label := case p_decision when 'approved' then 'approved' when 'rejected' then 'rejected' else 'returned for changes' end;
  v_suffix := case when v_note <> '' then ' Note from the administrator: ' || v_note else '' end;

  if p_kind = 'club' then
    select * into v_club from public.clubs where id = p_id for update;
    if not found then raise exception 'Club not found.'; end if;
    if v_club.status <> 'pending' then raise exception 'This request is no longer pending.'; end if;

    update public.clubs
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id, updated_at = now()
    where id = p_id;

    if p_decision = 'approved' then
      v_leader := coalesce(v_club.proposed_leader_id, v_club.created_by);
      if v_leader is not null then
        insert into public.club_leaders (club_id, user_id, position, assigned_by)
        values (p_id, v_leader, 'leader', v_admin.id)
        on conflict do nothing;
        perform public.ensure_membership(p_id, v_leader);
        perform public.notify(v_leader, 'You are now a club leader',
          format('"%s" was approved and you are its leader. Set up your recruitment form from the Leader Dashboard.', v_club.name),
          '#/lead/' || p_id);
      end if;
    end if;
    if v_club.created_by is distinct from v_leader or p_decision <> 'approved' then
      perform public.notify(v_club.created_by, 'Club request ' || v_label,
        format('Your request for "%s" was %s.%s', v_club.name, v_label, v_suffix),
        case when p_decision = 'approved' then '#/club/' || p_id else '#/my-clubs' end);
    end if;

  elsif p_kind = 'club_change' then
    select * into v_req from public.club_change_requests where id = p_id for update;
    if not found then raise exception 'Request not found.'; end if;
    if v_req.status <> 'pending' then raise exception 'This request is no longer pending.'; end if;
    select * into v_club from public.clubs where id = v_req.club_id for update;

    if p_decision = 'approved' then
      if exists (
        select 1 from public.clubs
        where lower(name) = lower(v_req.name) and id <> v_req.club_id
          and status in ('pending', 'changes_requested', 'approved', 'suspended')
      ) then
        raise exception 'Another club already uses the name "%". Request changes instead.', v_req.name;
      end if;
      update public.clubs
      set name = v_req.name, category = v_req.category, description = v_req.description,
          logo_url = v_req.logo_url, updated_at = now()
      where id = v_req.club_id;
    end if;
    update public.club_change_requests
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id
    where id = p_id;
    perform public.notify_club_leaders(v_req.club_id, 'Profile changes ' || v_label,
      format('The profile changes for %s were %s.%s', v_club.name, v_label, v_suffix),
      '#/lead/' || v_req.club_id || '/profile');

  elsif p_kind = 'questionnaire' then
    select * into v_q from public.questionnaires where id = p_id for update;
    if not found then raise exception 'Form not found.'; end if;
    if v_q.status <> 'pending' then raise exception 'This form is no longer pending.'; end if;
    if p_decision = 'approved' then
      update public.questionnaires set status = 'superseded', updated_at = now()
      where club_id = v_q.club_id and status = 'approved';
    end if;
    update public.questionnaires
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id, updated_at = now()
    where id = p_id;
    perform public.notify_club_leaders(v_q.club_id, 'Recruitment form ' || v_label,
      format('The recruitment form for %s was %s.%s%s',
        (select name from public.clubs where id = v_q.club_id), v_label, v_suffix,
        case when p_decision = 'approved' then ' You can now open recruitment.' else '' end),
      '#/lead/' || v_q.club_id || '/recruitment');

  elsif p_kind = 'post' then
    select * into v_post from public.club_posts where id = p_id for update;
    if not found then raise exception 'Post not found.'; end if;
    if v_post.status <> 'pending' then raise exception 'This post is no longer pending.'; end if;
    select * into v_club from public.clubs where id = v_post.club_id;
    update public.club_posts
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id,
        published_at = case when p_decision = 'approved' then now() else null end, updated_at = now()
    where id = p_id;
    perform public.notify_club_leaders(v_post.club_id, 'Post ' || v_label,
      format('"%s" was %s.%s', v_post.title, v_label, v_suffix),
      case when p_decision = 'approved' then '#/club/' || v_post.club_id else '#/lead/' || v_post.club_id || '/posts' end);
    if p_decision = 'approved' then
      perform public.notify_club_members(v_post.club_id,
        format('New from %s', v_club.name),
        v_post.title,
        '#/club/' || v_post.club_id || case v_post.kind when 'event' then '/upcoming' when 'event_result' then '/history' else '/announcements' end);
    end if;

  elsif p_kind = 'post_edit' then
    select * into v_edit from public.club_post_edits where id = p_id for update;
    if not found then raise exception 'Edit not found.'; end if;
    if v_edit.status <> 'pending' then raise exception 'This edit is no longer pending.'; end if;
    select * into v_post from public.club_posts where id = v_edit.post_id for update;
    if not found then raise exception 'The original post no longer exists.'; end if;

    if p_decision = 'approved' then
      update public.club_posts
      set title = v_edit.title, body = v_edit.body, event_date = v_edit.event_date,
          start_time = v_edit.start_time, end_time = v_edit.end_time, location = v_edit.location,
          cover_url = v_edit.cover_url, updated_at = now()
      where id = v_post.id;
      delete from public.club_post_photos where post_id = v_post.id;
      insert into public.club_post_photos (post_id, url, position)
      select v_post.id, u.url, u.pos::smallint
      from unnest(v_edit.photos) with ordinality as u(url, pos);
    end if;
    update public.club_post_edits
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id
    where id = p_id;
    perform public.notify_club_leaders(v_post.club_id, 'Post edit ' || v_label,
      format('Your changes to "%s" were %s.%s', v_post.title, v_label, v_suffix),
      case when p_decision = 'approved' then '#/club/' || v_post.club_id else '#/lead/' || v_post.club_id || '/posts' end);

  elsif p_kind = 'achievement' then
    select * into v_ach from public.club_achievements where id = p_id for update;
    if not found then raise exception 'Achievement not found.'; end if;
    if v_ach.status <> 'pending' then raise exception 'This achievement is no longer pending.'; end if;
    update public.club_achievements
    set status = p_decision, review_note = v_note, reviewed_at = now(), reviewed_by = v_admin.id
    where id = p_id;
    perform public.notify_club_leaders(v_ach.club_id, 'Achievement ' || v_label,
      format('"%s" was %s.%s', v_ach.title, v_label, v_suffix),
      '#/lead/' || v_ach.club_id || '/achievements');

  else
    raise exception 'Invalid submission type.';
  end if;
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
  from public.club_achievements a join public.clubs c on c.id = a.club_id
  union all
  select 'post_edit', 'Edit to published post',
         e.id, p.club_id, c.name, e.title, e.submitted_by, e.submitted_at, e.status, e.review_note
  from public.club_post_edits e
  join public.club_posts p on p.id = e.post_id
  join public.clubs c on c.id = p.club_id;

commit;
