-- ============================================================
-- SHZB Community — migration 012: administrators who are students
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migrations 006 and 007.
--
-- Admin accounts whose account type is "student" are treated as students
-- as well: they can apply to and join clubs, request clubs, and be assigned
-- as club leaders. Teachers stay view-only. Function signatures unchanged.
-- ============================================================

begin;

create or replace function public.require_student()
returns public.profiles
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.profiles;
begin
  v := public.require_active_profile();
  -- administrators who are students count as students too
  if v.account_type <> 'student' then
    raise exception 'Only student accounts can do this.';
  end if;
  return v;
end;
$$;

create or replace function public.submit_club_request(
  p_name text,
  p_category text,
  p_description text,
  p_logo_url text default null,
  p_proposed_leader uuid default null,
  p_club_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_leader uuid;
  v_club public.clubs;
  v_id uuid;
begin
  v_me := public.require_student();
  p_name := btrim(coalesce(p_name, ''));
  p_description := btrim(coalesce(p_description, ''));

  if char_length(p_name) not between 2 and 80 then
    raise exception 'Club name must be between 2 and 80 characters.';
  end if;
  if char_length(p_description) not between 10 and 2000 then
    raise exception 'Description must be between 10 and 2000 characters.';
  end if;
  if not exists (select 1 from public.club_categories where name = p_category) then
    raise exception 'Please choose a valid category.';
  end if;
  if not public.is_media_url(p_logo_url) then
    raise exception 'The logo must be an image uploaded through the site.';
  end if;

  v_leader := coalesce(p_proposed_leader, v_me.id);
  if not exists (
    select 1 from public.profiles
    where id = v_leader and account_type = 'student' and status = 'active'
  ) then
    raise exception 'The proposed leader must be an active student.';
  end if;

  if exists (
    select 1 from public.clubs
    where lower(name) = lower(p_name)
      and status in ('pending', 'changes_requested', 'approved', 'suspended')
      and (p_club_id is null or id <> p_club_id)
  ) then
    raise exception 'A club with this name already exists or is awaiting review.';
  end if;

  if p_club_id is null then
    if (select count(*) from public.clubs
        where created_by = v_me.id and status in ('pending', 'changes_requested')) >= 3 then
      raise exception 'You already have 3 club requests waiting for review.';
    end if;
    insert into public.clubs (name, category, description, logo_url, created_by, proposed_leader_id, status, submitted_at)
    values (p_name, p_category, p_description, nullif(p_logo_url, ''), v_me.id, v_leader, 'pending', now())
    returning id into v_id;
  else
    select * into v_club from public.clubs where id = p_club_id for update;
    if not found or v_club.created_by is distinct from v_me.id then
      raise exception 'Club request not found.';
    end if;
    if v_club.status not in ('pending', 'changes_requested') then
      raise exception 'This request has already been decided and can no longer be edited.';
    end if;
    update public.clubs
    set name = p_name, category = p_category, description = p_description,
        logo_url = nullif(p_logo_url, ''), proposed_leader_id = v_leader,
        status = 'pending', submitted_at = now(), updated_at = now()
    where id = p_club_id;
    v_id := p_club_id;
  end if;

  perform public.notify_admins(
    'New club request',
    format('%s %s requested a new club: "%s".', v_me.first_name, v_me.last_name, p_name),
    '/admin.html#approvals'
  );
  return v_id;
end;
$$;

create or replace function public.admin_set_leader(p_club uuid, p_user uuid, p_position text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin public.profiles;
  v_club public.clubs;
begin
  v_admin := public.require_admin();
  if p_position not in ('leader', 'co_leader') then raise exception 'Invalid position.'; end if;
  select * into v_club from public.clubs where id = p_club for update;
  if not found or v_club.status not in ('approved', 'suspended') then
    raise exception 'Leaders can only be assigned to active or suspended clubs.';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_user and account_type = 'student' and status = 'active'
  ) then
    raise exception 'Club leaders must be active student accounts.';
  end if;

  -- end this person's current leadership row (if any) so the change is recorded
  update public.club_leaders set ended_at = now()
  where club_id = p_club and user_id = p_user and ended_at is null;

  -- a club has one main leader: the previous one steps down (stays a member)
  if p_position = 'leader' then
    update public.club_leaders set ended_at = now()
    where club_id = p_club and position = 'leader' and ended_at is null;
  end if;

  insert into public.club_leaders (club_id, user_id, position, assigned_by)
  values (p_club, p_user, p_position, v_admin.id);
  perform public.ensure_membership(p_club, p_user);
  update public.club_members set leave_requested_at = null
  where club_id = p_club and user_id = p_user and status = 'approved';

  perform public.notify(p_user,
    case when p_position = 'leader' then 'You are now a club leader' else 'You are now a co-leader' end,
    format('An administrator made you %s of %s.', case when p_position = 'leader' then 'the leader' else 'a co-leader' end, v_club.name),
    '#/lead/' || p_club);
end;
$$;

create or replace function public.admin_create_club(
  p_name text,
  p_category text,
  p_description text,
  p_logo_url text default null,
  p_founded date default null,
  p_leader uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin public.profiles;
  v_id uuid;
  v_created timestamptz;
begin
  v_admin := public.require_admin();

  p_name := btrim(coalesce(p_name, ''));
  p_description := btrim(coalesce(p_description, ''));
  if char_length(p_name) not between 2 and 80 then
    raise exception 'Club name must be between 2 and 80 characters.';
  end if;
  if char_length(p_description) not between 10 and 2000 then
    raise exception 'Description must be between 10 and 2000 characters.';
  end if;
  if not exists (select 1 from public.club_categories where name = p_category) then
    raise exception 'Please choose a valid category.';
  end if;
  if not public.is_media_url(p_logo_url) then
    raise exception 'The logo must be an image uploaded through the site.';
  end if;
  if p_founded is not null and p_founded > public.school_today() then
    raise exception 'The founding date can''t be in the future.';
  end if;
  if exists (
    select 1 from public.clubs
    where lower(name) = lower(p_name)
      and status in ('pending', 'changes_requested', 'approved', 'suspended')
  ) then
    raise exception 'A club with this name already exists or is awaiting review.';
  end if;
  if p_leader is not null and not exists (
    select 1 from public.profiles
    where id = p_leader and account_type = 'student' and status = 'active'
  ) then
    raise exception 'Club leaders must be active student accounts.';
  end if;

  -- founding date at midday school time, so it shows as the same day everywhere
  v_created := case
    when p_founded is null then now()
    else (p_founded::timestamp + interval '12 hours') at time zone 'Asia/Ulaanbaatar'
  end;

  insert into public.clubs
    (name, category, description, logo_url, created_by, proposed_leader_id, status, created_at, submitted_at)
  values
    (p_name, p_category, p_description, nullif(p_logo_url, ''), v_admin.id, p_leader, 'approved', v_created, now())
  returning id into v_id;

  if p_leader is not null then
    insert into public.club_leaders (club_id, user_id, position, assigned_by)
    values (v_id, p_leader, 'leader', v_admin.id);
    perform public.ensure_membership(v_id, p_leader);
    perform public.notify(p_leader, 'You are now a club leader',
      format('An administrator created %s and made you its leader. Set up your recruitment form from the Leader Dashboard.', p_name),
      '#/lead/' || v_id);
  end if;

  return v_id;
end;
$$;

commit;
