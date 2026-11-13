-- ============================================================
-- SHZB Community — migration 007: administrators can create clubs directly
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migration_006_platform.sql.
--
-- Clubs created by an administrator are active immediately (no approval
-- step). The admin can set the real founding date for clubs that existed
-- before the site, and optionally assign the leader straight away.
-- ============================================================

begin;

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
    where id = p_leader and account_type = 'student' and role <> 'admin' and status = 'active'
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
