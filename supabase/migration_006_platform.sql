-- ============================================================
-- SHZB Community — migration 006: club leaders, approval workflow,
-- recruitment questionnaires, applications, club posts & events,
-- achievements, notifications, categories, leaderboard, media storage
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migrations 001–005.
--
-- The whole file runs in one transaction: if any statement fails, nothing
-- is applied and the database is left exactly as it was.
--
-- Design notes
-- * Permissions are enforced HERE, not in the browser. Every multi-step
--   workflow (apply, accept, approve, submit for review...) is a
--   `security definer` function that checks the caller's role first and
--   does all its writes atomically. Clients have no direct write access to
--   those tables at all.
-- * "Club leader" is not a global role: a person leads specific clubs via
--   rows in club_leaders. profiles.role stays student/admin and
--   profiles.account_type stays student/teacher.
-- * History is never deleted: memberships end (status 'left' + left_at),
--   leaderships end (ended_at), clubs are archived, old questionnaire
--   versions are 'superseded'.
-- ============================================================

begin;

-- ============================================================
-- 1. PROFILES: account status (suspension)
-- ============================================================

alter table public.profiles
  add column if not exists status text not null default 'active';

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('active', 'suspended'));

-- non-admins may only change their own bio (status is now locked too).
-- auth.uid() is null only for trusted server code using the service-role
-- key (anonymous visitors have no update policy on profiles at all).
create or replace function public.enforce_profile_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.first_name := old.first_name;
    new.last_name := old.last_name;
    new.email := old.email;
    new.role := old.role;
    new.account_type := old.account_type;
    new.graduation_year := old.graduation_year;
    new.class_section := old.class_section;
    new.status := old.status;
  end if;
  new.bio := left(coalesce(new.bio, ''), 1000);
  return new;
end;
$$;

-- ============================================================
-- 2. CLUB CATEGORIES (admin-managed)
-- ============================================================

create table if not exists public.club_categories (
  name text primary key check (char_length(btrim(name)) between 1 and 40),
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

insert into public.club_categories (name, sort_order) values
  ('Academic', 1), ('Arts', 2), ('Sports', 3), ('Technology', 4), ('Volunteer', 5), ('Other', 6)
on conflict (name) do nothing;

-- any category already used by an existing club becomes a real category
insert into public.club_categories (name)
select distinct category from public.clubs where char_length(btrim(category)) between 1 and 40
on conflict (name) do nothing;

-- ============================================================
-- 3. CLUBS: lifecycle statuses, logo, recruitment, review fields
-- ============================================================

alter table public.clubs drop constraint if exists clubs_status_check;
alter table public.clubs add constraint clubs_status_check
  check (status in ('pending', 'changes_requested', 'rejected', 'approved', 'suspended', 'archived'));

alter table public.clubs
  add column if not exists logo_url text,
  add column if not exists recruitment_open boolean not null default false,
  add column if not exists proposed_leader_id uuid references public.profiles(id) on delete set null,
  add column if not exists review_note text not null default '',
  add column if not exists submitted_at timestamptz not null default now(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

update public.clubs set submitted_at = created_at;

-- any category value that couldn't become a real category falls back to Other
update public.clubs set category = 'Other'
where category not in (select name from public.club_categories);

alter table public.clubs drop constraint if exists clubs_category_fkey;
alter table public.clubs add constraint clubs_category_fkey
  foreign key (category) references public.club_categories(name) on update cascade;

-- deleting a person's account must not delete the clubs they founded
-- (that would wipe every other member's history too)
alter table public.clubs drop constraint if exists clubs_created_by_fkey;
alter table public.clubs alter column created_by drop not null;
alter table public.clubs add constraint clubs_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

create index if not exists clubs_status_idx on public.clubs (status);
create index if not exists clubs_created_by_idx on public.clubs (created_by);

-- club owners no longer edit clubs directly — changes go through
-- club_change_requests and admin approval
drop policy if exists "clubs_update_owner" on public.clubs;
drop policy if exists "clubs_insert_own" on public.clubs;
drop trigger if exists before_club_update_enforce_rules on public.clubs;
drop function if exists public.enforce_club_update_rules();

-- clubs are created via submit_club_request(), which also handles
-- leadership; the old "creator auto-joins on insert" trigger made people
-- members of clubs that were never approved
drop trigger if exists on_club_created_add_owner on public.clubs;
drop function if exists public.add_owner_as_member();

-- ============================================================
-- 4. CLUB LEADERS (with history)
-- ============================================================

create table if not exists public.club_leaders (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  position text not null default 'leader' check (position in ('leader', 'co_leader')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  assigned_by uuid references public.profiles(id) on delete set null,
  check (ended_at is null or ended_at >= started_at)
);

-- one active leadership row per person per club, and one main leader per club
create unique index if not exists club_leaders_one_active_per_user
  on public.club_leaders (club_id, user_id) where ended_at is null;
create unique index if not exists club_leaders_one_main_leader
  on public.club_leaders (club_id) where ended_at is null and position = 'leader';
create index if not exists club_leaders_user_idx on public.club_leaders (user_id);

-- every existing approved club's creator becomes its leader
insert into public.club_leaders (club_id, user_id, position, started_at)
select c.id, c.created_by, 'leader', c.created_at
from public.clubs c
where c.status = 'approved' and c.created_by is not null
on conflict do nothing;

-- ============================================================
-- 5. RECRUITMENT QUESTIONNAIRES (versioned)
-- ============================================================
-- A club has at most one 'approved' (live) version and at most one working
-- copy (draft / pending / changes_requested). Approving a new version marks
-- the previous live one 'superseded', so applications always keep pointing
-- at the exact questions the student answered.

create table if not exists public.questionnaires (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  version integer not null,
  title text not null default 'Application form' check (char_length(title) between 1 and 120),
  intro text not null default '' check (char_length(intro) <= 2000),
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'changes_requested', 'rejected', 'approved', 'superseded')),
  review_note text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  unique (club_id, version)
);

create unique index if not exists questionnaires_one_live
  on public.questionnaires (club_id) where status = 'approved';
create unique index if not exists questionnaires_one_working_copy
  on public.questionnaires (club_id) where status in ('draft', 'pending', 'changes_requested');

create table if not exists public.questionnaire_questions (
  id uuid primary key default gen_random_uuid(),
  questionnaire_id uuid not null references public.questionnaires(id) on delete cascade,
  position integer not null,
  type text not null check (type in ('short_text', 'long_text', 'single_choice', 'multi_choice')),
  label text not null check (char_length(label) between 1 and 300),
  help_text text not null default '' check (char_length(help_text) <= 500),
  required boolean not null default true,
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  unique (questionnaire_id, position)
);

-- ============================================================
-- 6. APPLICATIONS, ANSWERS, STATUS HISTORY, INTERNAL NOTES
-- ============================================================

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  questionnaire_id uuid references public.questionnaires(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),
  message text not null default '',          -- free-text message from the pre-questionnaire flow
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null
);

-- no duplicate active applications to the same club
create unique index if not exists applications_one_pending
  on public.applications (club_id, user_id) where status = 'pending';
create index if not exists applications_club_status_idx on public.applications (club_id, status);
create index if not exists applications_user_idx on public.applications (user_id);

-- answers snapshot the question label/type so they stay readable forever
create table if not exists public.application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  question_id uuid references public.questionnaire_questions(id) on delete set null,
  position integer not null,
  question_label text not null,
  question_type text not null,
  answer jsonb
);
create index if not exists application_answers_app_idx on public.application_answers (application_id);

create table if not exists public.application_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index if not exists application_status_history_app_idx on public.application_status_history (application_id);

-- leader-only notes live in their own table so the applicant can never read them
create table if not exists public.application_notes (
  application_id uuid primary key references public.applications(id) on delete cascade,
  note text not null default '' check (char_length(note) <= 2000),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 7. CLUB MEMBERS: real membership history
-- ============================================================

alter table public.club_members
  add column if not exists joined_at timestamptz,
  add column if not exists leave_requested_at timestamptz,
  add column if not exists end_reason text,
  add column if not exists application_id uuid references public.applications(id) on delete set null;

alter table public.club_members drop constraint if exists club_members_end_reason_check;
alter table public.club_members add constraint club_members_end_reason_check
  check (end_reason is null or end_reason in ('left', 'removed'));

-- pending join requests move to the new applications table (with their message)
insert into public.applications (club_id, user_id, status, message, submitted_at)
select club_id, user_id, 'pending', coalesce(message, ''), applied_at
from public.club_members
where status = 'pending';

delete from public.club_members where status = 'pending';

-- the old trigger auto-joined founders to clubs that were never approved;
-- those aren't real memberships
delete from public.club_members m
using public.clubs c
where c.id = m.club_id and c.status <> 'approved' and m.user_id = c.created_by;

update public.club_members set joined_at = coalesce(decided_at, applied_at) where joined_at is null;
update public.club_members set left_at = coalesce(left_at, decided_at, applied_at) where status = 'left' and left_at is null;
update public.club_members set end_reason = 'left' where status = 'left' and end_reason is null;

alter table public.club_members alter column joined_at set default now();
alter table public.club_members alter column joined_at set not null;

alter table public.club_members drop constraint if exists club_members_status_check;
alter table public.club_members add constraint club_members_status_check
  check (status in ('approved', 'left'));
alter table public.club_members alter column status set default 'approved';

alter table public.club_members drop constraint if exists club_members_left_has_date;
alter table public.club_members add constraint club_members_left_has_date
  check (status <> 'left' or left_at is not null);

-- allow several membership periods per person per club (leave + rejoin
-- later) while still allowing only ONE active membership at a time
alter table public.club_members drop constraint if exists club_members_club_id_user_id_key;
create unique index if not exists club_members_one_active
  on public.club_members (club_id, user_id) where status = 'approved';
create index if not exists club_members_user_idx on public.club_members (user_id);

-- every leader is also a member
insert into public.club_members (club_id, user_id, status, joined_at, decided_at, applied_at)
select l.club_id, l.user_id, 'approved', l.started_at, l.started_at, l.started_at
from public.club_leaders l
where l.ended_at is null
  and not exists (
    select 1 from public.club_members m
    where m.club_id = l.club_id and m.user_id = l.user_id and m.status = 'approved'
  );

-- all membership writes now go through functions
drop trigger if exists before_club_member_update_enforce_rules on public.club_members;
drop function if exists public.enforce_club_member_update_rules();
drop policy if exists "club_members_select_own" on public.club_members;
drop policy if exists "club_members_select_approved" on public.club_members;
drop policy if exists "club_members_select_public_history" on public.club_members;
drop policy if exists "club_members_select_owner" on public.club_members;
drop policy if exists "club_members_select_admin" on public.club_members;
drop policy if exists "club_members_insert_own" on public.club_members;
drop policy if exists "club_members_update_owner" on public.club_members;
drop policy if exists "club_members_update_self" on public.club_members;
drop policy if exists "club_members_delete_self_or_owner" on public.club_members;

-- ============================================================
-- 8. CLUB POSTS: announcements, events, event results
-- ============================================================
-- One table for everything a club publishes, so the approval queue, the
-- feed and the leaderboard all read from one place.
--   announcement — general club news
--   event        — upcoming event (date, times, location, one poster)
--   event_result — update after an event; linked to its event; 1–3 photos;
--                  its date is simply the date it was published
-- An event is "upcoming" while event_date >= today and "completed" after;
-- that's computed from the date, nothing is ever deleted when it passes.

create table if not exists public.club_posts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  kind text not null check (kind in ('announcement', 'event', 'event_result')),
  title text not null check (char_length(title) between 1 and 150),
  body text not null default '' check (char_length(body) <= 5000),
  event_date date,
  start_time time,
  end_time time,
  location text not null default '' check (char_length(location) <= 200),
  cover_url text,
  parent_event_id uuid references public.club_posts(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'changes_requested', 'rejected', 'approved')),
  review_note text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz,
  check (kind <> 'event' or event_date is not null),
  check (end_time is null or start_time is null or end_time >= start_time)
);

create index if not exists club_posts_club_idx on public.club_posts (club_id, kind, status);
create index if not exists club_posts_status_idx on public.club_posts (status);
create index if not exists club_posts_event_date_idx on public.club_posts (event_date) where kind = 'event';
create index if not exists club_posts_parent_idx on public.club_posts (parent_event_id);

create table if not exists public.club_post_photos (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.club_posts(id) on delete cascade,
  url text not null,
  position smallint not null check (position between 1 and 3),
  unique (post_id, position)
);

-- existing club events become approved event posts (school is in UB time)
insert into public.club_posts
  (club_id, kind, title, body, event_date, start_time, status, created_by,
   created_at, submitted_at, reviewed_at, published_at)
select
  e.club_id, 'event', coalesce(nullif(left(btrim(e.title), 150), ''), 'Event'), left(coalesce(e.description, ''), 5000),
  (e.event_date at time zone 'Asia/Ulaanbaatar')::date,
  (e.event_date at time zone 'Asia/Ulaanbaatar')::time,
  'approved', e.created_by, e.created_at, e.created_at, e.created_at, e.created_at
from public.club_events e;

-- club_events is kept (read-only) for reference; the app no longer uses it
drop policy if exists "club_events_insert_owner" on public.club_events;
drop policy if exists "club_events_update_owner" on public.club_events;
drop policy if exists "club_events_delete_owner" on public.club_events;
comment on table public.club_events is 'DEPRECATED by migration 006 — rows copied into club_posts (kind = event). Read-only.';

-- ============================================================
-- 9. ACHIEVEMENTS and CLUB PROFILE CHANGE REQUESTS
-- ============================================================

create table if not exists public.club_achievements (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  description text not null default '' check (char_length(description) <= 2000),
  achieved_on date not null,
  image_url text,
  status text not null default 'pending' check (status in ('pending', 'changes_requested', 'rejected', 'approved')),
  review_note text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);
create index if not exists club_achievements_club_idx on public.club_achievements (club_id, status);

create table if not exists public.club_change_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null,
  category text not null references public.club_categories(name) on update cascade,
  description text not null,
  logo_url text,
  status text not null default 'pending' check (status in ('pending', 'changes_requested', 'rejected', 'approved')),
  review_note text not null default '',
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists club_change_requests_one_open
  on public.club_change_requests (club_id) where status in ('pending', 'changes_requested');

-- ============================================================
-- 10. NOTIFICATIONS
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null default '',
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ============================================================
-- 11. HELPER FUNCTIONS
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

create or replace function public.is_club_leader(p_club uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.club_leaders l
    join public.profiles p on p.id = l.user_id
    where l.club_id = p_club and l.user_id = auth.uid() and l.ended_at is null and p.status = 'active'
  );
$$;

-- today's date at the school (Mongolia), used for event lifecycle
create or replace function public.school_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Ulaanbaatar')::date;
$$;

-- only images uploaded to this project's club-media bucket are accepted
create or replace function public.is_media_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url is null or p_url = ''
    or p_url ~ '^https://[^/]+/storage/v1/object/public/club-media/[^?#]+$';
$$;

create or replace function public.require_active_profile()
returns public.profiles
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.profiles;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;
  select * into v from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Your profile could not be found.';
  end if;
  if v.status <> 'active' then
    raise exception 'Your account is suspended. Please contact a school administrator.';
  end if;
  return v;
end;
$$;

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
  if v.account_type <> 'student' or v.role = 'admin' then
    raise exception 'Only student accounts can do this.';
  end if;
  return v;
end;
$$;

create or replace function public.require_admin()
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
  if v.role <> 'admin' then
    raise exception 'Administrator access is required.';
  end if;
  return v;
end;
$$;

-- leaders of the club (or an admin) only
create or replace function public.require_leader(p_club uuid)
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
  if v.role <> 'admin' and not public.is_club_leader(p_club) then
    raise exception 'Only this club''s leaders can do this.';
  end if;
  return v;
end;
$$;

-- ---------- notification helpers (internal: not callable by clients) ----------

create or replace function public.notify(p_user uuid, p_title text, p_body text, p_link text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;
  insert into public.notifications (user_id, title, body, link)
  values (p_user, left(p_title, 200), left(coalesce(p_body, ''), 1000), coalesce(p_link, ''));
end;
$$;

create or replace function public.notify_admins(p_title text, p_body text, p_link text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, title, body, link)
  select id, left(p_title, 200), left(coalesce(p_body, ''), 1000), coalesce(p_link, '')
  from public.profiles where role = 'admin' and status = 'active';
$$;

create or replace function public.notify_club_leaders(p_club uuid, p_title text, p_body text, p_link text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, title, body, link)
  select l.user_id, left(p_title, 200), left(coalesce(p_body, ''), 1000), coalesce(p_link, '')
  from public.club_leaders l where l.club_id = p_club and l.ended_at is null;
$$;

-- current members who are not leaders (leaders get their own notice)
create or replace function public.notify_club_members(p_club uuid, p_title text, p_body text, p_link text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, title, body, link)
  select m.user_id, left(p_title, 200), left(coalesce(p_body, ''), 1000), coalesce(p_link, '')
  from public.club_members m
  where m.club_id = p_club and m.status = 'approved'
    and not exists (
      select 1 from public.club_leaders l
      where l.club_id = p_club and l.user_id = m.user_id and l.ended_at is null
    );
$$;

create or replace function public.ensure_membership(p_club uuid, p_user uuid, p_application uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.club_members (club_id, user_id, status, joined_at, decided_at, applied_at, application_id)
  values (p_club, p_user, 'approved', now(), now(), now(), p_application)
  on conflict do nothing;
end;
$$;

create or replace function public.person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select btrim(first_name || ' ' || last_name) from public.profiles where id = p_user), 'Someone');
$$;

revoke execute on function public.notify(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_admins(text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_club_leaders(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_club_members(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ensure_membership(uuid, uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 12. ROW LEVEL SECURITY
-- ============================================================
-- Reads are governed by the policies below. Writes to workflow tables are
-- only possible through the functions in section 13 (they run as the table
-- owner, so RLS doesn't block them, but they do their own role checks).

alter table public.club_categories enable row level security;
alter table public.club_leaders enable row level security;
alter table public.questionnaires enable row level security;
alter table public.questionnaire_questions enable row level security;
alter table public.applications enable row level security;
alter table public.application_answers enable row level security;
alter table public.application_status_history enable row level security;
alter table public.application_notes enable row level security;
alter table public.club_posts enable row level security;
alter table public.club_post_photos enable row level security;
alter table public.club_achievements enable row level security;
alter table public.club_change_requests enable row level security;
alter table public.notifications enable row level security;

-- ---------- clubs ----------
-- public: approved clubs, plus archived/suspended so membership history
-- keeps its club names (the app labels them; they don't appear in the directory)
drop policy if exists "clubs_select_approved" on public.clubs;
create policy "clubs_select_visible" on public.clubs
  for select to authenticated
  using (status in ('approved', 'archived', 'suspended'));

-- the requester / proposed leader / leaders can always see their club
create policy "clubs_select_involved" on public.clubs
  for select to authenticated
  using (created_by = auth.uid() or proposed_leader_id = auth.uid() or public.is_club_leader(id));

-- (clubs_select_admin, clubs_update_admin, clubs_delete_admin from 001 stay)

-- ---------- categories ----------
create policy "club_categories_select" on public.club_categories
  for select to authenticated using (true);
create policy "club_categories_admin" on public.club_categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- leaders ----------
create policy "club_leaders_select" on public.club_leaders
  for select to authenticated using (true);
create policy "club_leaders_admin" on public.club_leaders
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- members ----------
-- membership history (current + previous) is public to signed-in users
create policy "club_members_select" on public.club_members
  for select to authenticated using (true);
create policy "club_members_admin" on public.club_members
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- questionnaires ----------
create policy "questionnaires_select_live" on public.questionnaires
  for select to authenticated
  using (status = 'approved' and exists (
    select 1 from public.clubs c where c.id = club_id and c.status = 'approved'
  ));
create policy "questionnaires_select_leader" on public.questionnaires
  for select to authenticated using (public.is_club_leader(club_id));
create policy "questionnaires_admin" on public.questionnaires
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "questionnaire_questions_select" on public.questionnaire_questions
  for select to authenticated
  using (exists (select 1 from public.questionnaires q where q.id = questionnaire_id));
create policy "questionnaire_questions_admin" on public.questionnaire_questions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- applications (private: applicant, the club's leaders, admins) ----------
create policy "applications_select_own" on public.applications
  for select to authenticated using (user_id = auth.uid());
create policy "applications_select_leader" on public.applications
  for select to authenticated using (public.is_club_leader(club_id));
create policy "applications_admin" on public.applications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "application_answers_select" on public.application_answers
  for select to authenticated
  using (exists (select 1 from public.applications a where a.id = application_id));
create policy "application_status_history_select" on public.application_status_history
  for select to authenticated
  using (exists (select 1 from public.applications a where a.id = application_id));

-- internal notes: leaders and admins only, never the applicant
create policy "application_notes_select" on public.application_notes
  for select to authenticated
  using (exists (
    select 1 from public.applications a
    where a.id = application_id and (public.is_club_leader(a.club_id) or public.is_admin())
  ));

-- ---------- posts ----------
create policy "club_posts_select_public" on public.club_posts
  for select to authenticated
  using (status = 'approved' and exists (
    select 1 from public.clubs c where c.id = club_id and c.status in ('approved', 'archived')
  ));
create policy "club_posts_select_leader" on public.club_posts
  for select to authenticated using (public.is_club_leader(club_id));
create policy "club_posts_admin" on public.club_posts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "club_post_photos_select" on public.club_post_photos
  for select to authenticated
  using (exists (select 1 from public.club_posts p where p.id = post_id));
create policy "club_post_photos_admin" on public.club_post_photos
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- achievements ----------
create policy "club_achievements_select_public" on public.club_achievements
  for select to authenticated
  using (status = 'approved' and exists (
    select 1 from public.clubs c where c.id = club_id and c.status in ('approved', 'archived')
  ));
create policy "club_achievements_select_leader" on public.club_achievements
  for select to authenticated using (public.is_club_leader(club_id));
create policy "club_achievements_admin" on public.club_achievements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- change requests ----------
create policy "club_change_requests_select_leader" on public.club_change_requests
  for select to authenticated using (public.is_club_leader(club_id));
create policy "club_change_requests_admin" on public.club_change_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- notifications (own only; created only by functions) ----------
create policy "notifications_select_own" on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy "notifications_delete_own" on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- ---------- announcements: schools-wide posts can carry an image ----------
alter table public.announcements add column if not exists image_url text;

-- ============================================================
-- 13. WORKFLOW FUNCTIONS (called from the app with supabase.rpc)
-- ============================================================

-- application status history is recorded automatically
create or replace function public.log_application_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_status_history (application_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into public.application_status_history (application_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists applications_log_status on public.applications;
create trigger applications_log_status
  after insert or update of status on public.applications
  for each row execute function public.log_application_status();

-- the applications migrated from club_members get a history entry too
insert into public.application_status_history (application_id, from_status, to_status, changed_at)
select a.id, null, a.status, a.submitted_at
from public.applications a
where not exists (select 1 from public.application_status_history h where h.application_id = a.id);

-- ------------------------------------------------------------
-- Club creation request (students). Pass p_club_id to edit and
-- resubmit a request that is pending or was returned for changes.
-- ------------------------------------------------------------
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
    where id = v_leader and account_type = 'student' and role <> 'admin' and status = 'active'
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

-- ------------------------------------------------------------
-- Club profile change request (leaders). Approved changes are applied
-- to the club by review_submission().
-- ------------------------------------------------------------
create or replace function public.submit_club_change(
  p_club uuid,
  p_name text,
  p_category text,
  p_description text,
  p_logo_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_club public.clubs;
  v_existing public.club_change_requests;
  v_id uuid;
begin
  v_me := public.require_leader(p_club);
  select * into v_club from public.clubs where id = p_club;
  if not found or v_club.status <> 'approved' then
    raise exception 'Only active clubs can request profile changes.';
  end if;

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
  if exists (
    select 1 from public.clubs
    where lower(name) = lower(p_name) and id <> p_club
      and status in ('pending', 'changes_requested', 'approved', 'suspended')
  ) then
    raise exception 'Another club already uses this name.';
  end if;
  if p_name = v_club.name and p_category = v_club.category and p_description = v_club.description
     and coalesce(nullif(p_logo_url, ''), '') = coalesce(v_club.logo_url, '') then
    raise exception 'Nothing has changed.';
  end if;

  select * into v_existing from public.club_change_requests
  where club_id = p_club and status in ('pending', 'changes_requested')
  for update;

  if found then
    update public.club_change_requests
    set name = p_name, category = p_category, description = p_description,
        logo_url = nullif(p_logo_url, ''), status = 'pending',
        submitted_by = v_me.id, submitted_at = now()
    where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into public.club_change_requests (club_id, name, category, description, logo_url, submitted_by)
    values (p_club, p_name, p_category, p_description, nullif(p_logo_url, ''), v_me.id)
    returning id into v_id;
  end if;

  perform public.notify_admins(
    'Club profile change request',
    format('%s requested changes to the profile of "%s".', public.person_name(v_me.id), v_club.name),
    '/admin.html#approvals'
  );
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- Recruitment questionnaire: save the working copy (leaders).
-- p_questions: [{ "type", "label", "help_text", "required", "options": [..] }, ...]
-- Saving always puts the working copy back into 'draft'; it has to be
-- submitted again for review.
-- ------------------------------------------------------------
create or replace function public.save_questionnaire(
  p_club uuid,
  p_title text,
  p_intro text,
  p_questions jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_q public.questionnaires;
  v_id uuid;
  r record;
  v_type text;
  v_label text;
  v_options jsonb;
  v_count integer;
begin
  v_me := public.require_leader(p_club);
  if not exists (select 1 from public.clubs where id = p_club and status = 'approved') then
    raise exception 'Only active clubs can create a recruitment form.';
  end if;

  p_title := btrim(coalesce(p_title, ''));
  if p_title = '' then p_title := 'Application form'; end if;
  if char_length(p_title) > 120 then raise exception 'Form title is too long (max 120 characters).'; end if;
  p_intro := btrim(coalesce(p_intro, ''));
  if char_length(p_intro) > 2000 then raise exception 'Form introduction is too long (max 2000 characters).'; end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'Questions are missing.';
  end if;
  v_count := jsonb_array_length(p_questions);
  if v_count < 1 then raise exception 'Add at least one question.'; end if;
  if v_count > 30 then raise exception 'A form can have at most 30 questions.'; end if;

  select * into v_q from public.questionnaires
  where club_id = p_club and status in ('draft', 'pending', 'changes_requested')
  for update;

  if found then
    update public.questionnaires
    set title = p_title, intro = p_intro, status = 'draft', updated_at = now()
    where id = v_q.id;
    v_id := v_q.id;
    delete from public.questionnaire_questions where questionnaire_id = v_id;
  else
    insert into public.questionnaires (club_id, version, title, intro, status, created_by)
    values (
      p_club,
      coalesce((select max(version) from public.questionnaires where club_id = p_club), 0) + 1,
      p_title, p_intro, 'draft', v_me.id
    )
    returning id into v_id;
  end if;

  for r in
    select e.value as q, e.ordinality as pos
    from jsonb_array_elements(p_questions) with ordinality as e(value, ordinality)
  loop
    v_type := r.q->>'type';
    v_label := btrim(coalesce(r.q->>'label', ''));
    if v_type not in ('short_text', 'long_text', 'single_choice', 'multi_choice') then
      raise exception 'Question % has an invalid type.', r.pos;
    end if;
    if char_length(v_label) not between 1 and 300 then
      raise exception 'Question % needs a label (max 300 characters).', r.pos;
    end if;

    if v_type in ('single_choice', 'multi_choice') then
      if jsonb_typeof(r.q->'options') is distinct from 'array' then
        raise exception 'Question % needs answer options.', r.pos;
      end if;
      -- trimmed, de-duplicated, kept in the order the leader typed them
      select coalesce(jsonb_agg(x.val order by x.first_pos), '[]'::jsonb) into v_options
      from (
        select btrim(o.val) as val, min(o.pos) as first_pos
        from jsonb_array_elements_text(r.q->'options') with ordinality as o(val, pos)
        where btrim(o.val) <> ''
        group by btrim(o.val)
      ) x;
      if jsonb_array_length(v_options) < 2 then
        raise exception 'Question % needs at least two different options.', r.pos;
      end if;
      if jsonb_array_length(v_options) > 20 then
        raise exception 'Question % can have at most 20 options.', r.pos;
      end if;
      if exists (select 1 from jsonb_array_elements_text(v_options) as o(val) where char_length(o.val) > 100) then
        raise exception 'Options in question % must be at most 100 characters.', r.pos;
      end if;
    else
      v_options := '[]'::jsonb;
    end if;

    insert into public.questionnaire_questions (questionnaire_id, position, type, label, help_text, required, options)
    values (
      v_id, r.pos, v_type, v_label,
      left(btrim(coalesce(r.q->>'help_text', '')), 500),
      coalesce((r.q->>'required')::boolean, true),
      v_options
    );
  end loop;

  return v_id;
end;
$$;

create or replace function public.submit_questionnaire(p_questionnaire uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_q public.questionnaires;
begin
  select * into v_q from public.questionnaires where id = p_questionnaire for update;
  if not found then raise exception 'Form not found.'; end if;
  v_me := public.require_leader(v_q.club_id);
  if v_q.status not in ('draft', 'changes_requested') then
    raise exception 'This form has already been submitted.';
  end if;
  if not exists (select 1 from public.questionnaire_questions where questionnaire_id = v_q.id) then
    raise exception 'Add at least one question before submitting.';
  end if;

  update public.questionnaires
  set status = 'pending', submitted_at = now(), updated_at = now()
  where id = v_q.id;

  perform public.notify_admins(
    'Recruitment form submitted',
    format('%s submitted a recruitment form for "%s".',
      public.person_name(v_me.id), (select name from public.clubs where id = v_q.club_id)),
    '/admin.html#approvals'
  );
end;
$$;

-- open / close recruitment (leaders). Opening needs an approved form.
create or replace function public.set_recruitment(p_club uuid, p_open boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_leader(p_club);
  if p_open then
    if not exists (select 1 from public.clubs where id = p_club and status = 'approved') then
      raise exception 'Only active clubs can recruit.';
    end if;
    if not exists (select 1 from public.questionnaires where club_id = p_club and status = 'approved') then
      raise exception 'Recruitment can open once an administrator has approved your recruitment form.';
    end if;
  end if;
  update public.clubs set recruitment_open = p_open, updated_at = now() where id = p_club;
end;
$$;

-- ------------------------------------------------------------
-- Apply to a club (students).
-- p_answers: [{ "question_id": "...", "value": "text" | ["opt", ...] }, ...]
-- ------------------------------------------------------------
create or replace function public.submit_application(p_club uuid, p_answers jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_club public.clubs;
  v_q public.questionnaires;
  v_app uuid;
  q record;
  v_raw jsonb;
  v_text text;
  v_value jsonb;
begin
  v_me := public.require_student();

  select * into v_club from public.clubs where id = p_club;
  if not found or v_club.status <> 'approved' then
    raise exception 'This club is not accepting applications.';
  end if;
  if not v_club.recruitment_open then
    raise exception 'Recruitment for this club is closed.';
  end if;
  select * into v_q from public.questionnaires where club_id = p_club and status = 'approved';
  if not found then
    raise exception 'This club''s application form is not available yet.';
  end if;
  if exists (select 1 from public.club_members where club_id = p_club and user_id = v_me.id and status = 'approved') then
    raise exception 'You are already a member of this club.';
  end if;
  if exists (select 1 from public.applications where club_id = p_club and user_id = v_me.id and status = 'pending') then
    raise exception 'You already have a pending application to this club.';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    p_answers := '[]'::jsonb;
  end if;

  insert into public.applications (club_id, user_id, questionnaire_id)
  values (p_club, v_me.id, v_q.id)
  returning id into v_app;

  for q in
    select * from public.questionnaire_questions where questionnaire_id = v_q.id order by position
  loop
    select a.elem->'value' into v_raw
    from jsonb_array_elements(p_answers) as a(elem)
    where a.elem->>'question_id' = q.id::text
    limit 1;

    v_value := null;

    if q.type in ('short_text', 'long_text') then
      v_text := case when jsonb_typeof(v_raw) = 'string' then btrim(v_raw #>> '{}') else '' end;
      if v_text = '' then
        if q.required then raise exception 'Please answer: %', q.label; end if;
      else
        if char_length(v_text) > case when q.type = 'short_text' then 300 else 3000 end then
          raise exception 'Your answer to "%" is too long.', q.label;
        end if;
        v_value := to_jsonb(v_text);
      end if;

    elsif q.type = 'single_choice' then
      v_text := case when jsonb_typeof(v_raw) = 'string' then v_raw #>> '{}' else '' end;
      if v_text = '' then
        if q.required then raise exception 'Please answer: %', q.label; end if;
      else
        if not (q.options ? v_text) then
          raise exception 'Please choose one of the listed options for "%".', q.label;
        end if;
        v_value := to_jsonb(v_text);
      end if;

    else -- multi_choice
      if jsonb_typeof(v_raw) = 'array' then
        if exists (
          select 1 from jsonb_array_elements(v_raw) as x(elem)
          where jsonb_typeof(x.elem) <> 'string' or not (q.options ? (x.elem #>> '{}'))
        ) then
          raise exception 'Please choose from the listed options for "%".', q.label;
        end if;
        select coalesce(jsonb_agg(distinct x.val), '[]'::jsonb) into v_value
        from jsonb_array_elements_text(v_raw) as x(val);
        if jsonb_array_length(v_value) = 0 then v_value := null; end if;
      end if;
      if v_value is null and q.required then
        raise exception 'Please answer: %', q.label;
      end if;
    end if;

    insert into public.application_answers (application_id, question_id, position, question_label, question_type, answer)
    values (v_app, q.id, q.position, q.label, q.type, v_value);
  end loop;

  perform public.notify(
    v_me.id, 'Application submitted',
    format('Your application to %s was sent. You''ll be notified when the leaders decide.', v_club.name),
    '#/profile'
  );
  perform public.notify_club_leaders(
    p_club, 'New application',
    format('%s %s applied to join %s.', v_me.first_name, v_me.last_name, v_club.name),
    '#/lead/' || p_club || '/applications'
  );
  return v_app;
end;
$$;

create or replace function public.withdraw_application(p_application uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_app public.applications;
begin
  v_me := public.require_active_profile();
  select * into v_app from public.applications where id = p_application for update;
  if not found or v_app.user_id <> v_me.id then
    raise exception 'Application not found.';
  end if;
  if v_app.status <> 'pending' then
    raise exception 'Only pending applications can be withdrawn.';
  end if;
  update public.applications set status = 'withdrawn', decided_at = now(), decided_by = v_me.id
  where id = p_application;
end;
$$;

-- accept / reject (leaders). Accepting creates the membership in the same transaction.
create or replace function public.decide_application(p_application uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_app public.applications;
  v_club public.clubs;
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'Invalid decision.';
  end if;
  select * into v_app from public.applications where id = p_application for update;
  if not found then raise exception 'Application not found.'; end if;
  v_me := public.require_leader(v_app.club_id);
  if v_app.status <> 'pending' then
    raise exception 'This application has already been decided.';
  end if;
  select * into v_club from public.clubs where id = v_app.club_id;

  if p_decision = 'accepted' then
    if v_club.status <> 'approved' then
      raise exception 'Applications can only be accepted while the club is active.';
    end if;
    if exists (select 1 from public.club_members
               where club_id = v_app.club_id and user_id = v_app.user_id and status = 'approved') then
      raise exception 'This student is already a member.';
    end if;
    insert into public.club_members (club_id, user_id, status, joined_at, decided_at, applied_at, application_id)
    values (v_app.club_id, v_app.user_id, 'approved', now(), now(), v_app.submitted_at, v_app.id);
  end if;

  update public.applications
  set status = p_decision, decided_at = now(), decided_by = v_me.id
  where id = p_application;

  if p_decision = 'accepted' then
    perform public.notify(v_app.user_id, 'Application accepted',
      format('Welcome! You are now a member of %s.', v_club.name), '#/club/' || v_club.id);
  else
    perform public.notify(v_app.user_id, 'Application not accepted',
      format('Your application to %s was not accepted this time.', v_club.name), '#/profile');
  end if;
end;
$$;

create or replace function public.save_application_note(p_application uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_club uuid;
begin
  select club_id into v_club from public.applications where id = p_application;
  if v_club is null then raise exception 'Application not found.'; end if;
  v_me := public.require_leader(v_club);
  if char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'The note is too long (max 2000 characters).';
  end if;
  insert into public.application_notes (application_id, note, updated_by, updated_at)
  values (p_application, btrim(coalesce(p_note, '')), v_me.id, now())
  on conflict (application_id) do update
  set note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;

-- ------------------------------------------------------------
-- Leaving a club: the member requests, a leader confirms. The
-- membership row is ended (never deleted), so it stays in history.
-- ------------------------------------------------------------
create or replace function public.request_leave(p_club uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_row public.club_members;
begin
  v_me := public.require_active_profile();
  select * into v_row from public.club_members
  where club_id = p_club and user_id = v_me.id and status = 'approved'
  for update;
  if not found then raise exception 'You are not a member of this club.'; end if;
  if exists (select 1 from public.club_leaders where club_id = p_club and user_id = v_me.id and ended_at is null) then
    raise exception 'Club leaders must ask an administrator to hand over leadership before leaving.';
  end if;
  if v_row.leave_requested_at is not null then
    raise exception 'You have already asked to leave this club.';
  end if;
  update public.club_members set leave_requested_at = now() where id = v_row.id;
  perform public.notify_club_leaders(p_club, 'Leave request',
    format('%s %s asked to leave %s.', v_me.first_name, v_me.last_name, (select name from public.clubs where id = p_club)),
    '#/lead/' || p_club || '/members');
end;
$$;

create or replace function public.cancel_leave_request(p_club uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
begin
  v_me := public.require_active_profile();
  update public.club_members set leave_requested_at = null
  where club_id = p_club and user_id = v_me.id and status = 'approved' and leave_requested_at is not null;
  if not found then raise exception 'There is no leave request to cancel.'; end if;
end;
$$;

create or replace function public.decide_leave(p_membership uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.club_members;
  v_club_name text;
begin
  select * into v_row from public.club_members where id = p_membership for update;
  if not found then raise exception 'Membership not found.'; end if;
  perform public.require_leader(v_row.club_id);
  if v_row.status <> 'approved' or v_row.leave_requested_at is null then
    raise exception 'There is no pending leave request for this member.';
  end if;
  select name into v_club_name from public.clubs where id = v_row.club_id;

  if p_approve then
    update public.club_members
    set status = 'left', left_at = now(), end_reason = 'left', leave_requested_at = null
    where id = p_membership;
    perform public.notify(v_row.user_id, 'You left a club',
      format('Your membership in %s has ended. It stays on your club history.', v_club_name), '#/profile');
  else
    update public.club_members set leave_requested_at = null where id = p_membership;
    perform public.notify(v_row.user_id, 'Leave request declined',
      format('Your request to leave %s was declined. Talk to the club leaders.', v_club_name), '#/club/' || v_row.club_id);
  end if;
end;
$$;

create or replace function public.remove_member(p_membership uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.club_members;
begin
  select * into v_row from public.club_members where id = p_membership for update;
  if not found or v_row.status <> 'approved' then raise exception 'Membership not found.'; end if;
  perform public.require_leader(v_row.club_id);
  if exists (select 1 from public.club_leaders where club_id = v_row.club_id and user_id = v_row.user_id and ended_at is null) then
    raise exception 'Leaders can''t be removed here. An administrator manages leadership.';
  end if;
  update public.club_members
  set status = 'left', left_at = now(), end_reason = 'removed', leave_requested_at = null
  where id = p_membership;
  perform public.notify(v_row.user_id, 'Membership ended',
    format('Your membership in %s has ended.', (select name from public.clubs where id = v_row.club_id)), '#/profile');
end;
$$;

-- ------------------------------------------------------------
-- Club posts (leaders) — always submitted for admin approval.
-- Pass p_post_id to edit + resubmit a post that is pending or was
-- returned for changes. Approved posts can't be edited.
-- ------------------------------------------------------------
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
    if p_event_date < public.school_today() then raise exception 'The event date can''t be in the past.'; end if;
    if p_end_time is not null and p_start_time is null then raise exception 'Add a start time too.'; end if;
    if p_start_time is not null and p_end_time is not null and p_end_time < p_start_time then
      raise exception 'The end time must be after the start time.';
    end if;
    if cardinality(p_photos) > 0 then raise exception 'Events use a single poster image.'; end if;
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
    v_kind_label := case p_kind when 'event' then 'event announcement' when 'event_result' then 'event results update' else 'announcement' end;
    perform public.notify_admins(
      'New content for approval',
      format('%s submitted a %s for %s: "%s".', public.person_name(v_me.id), v_kind_label, v_club.name, p_title),
      '/admin.html#approvals'
    );
  end if;
  return v_id;
end;
$$;

create or replace function public.submit_achievement(
  p_club uuid,
  p_title text,
  p_description text,
  p_achieved_on date,
  p_image_url text default null,
  p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles;
  v_row public.club_achievements;
  v_id uuid;
  v_was_pending boolean := false;
begin
  v_me := public.require_leader(p_club);
  if not exists (select 1 from public.clubs where id = p_club and status = 'approved') then
    raise exception 'Only active clubs can add achievements.';
  end if;
  p_title := btrim(coalesce(p_title, ''));
  p_description := btrim(coalesce(p_description, ''));
  if char_length(p_title) not between 3 and 150 then raise exception 'Title must be between 3 and 150 characters.'; end if;
  if char_length(p_description) > 2000 then raise exception 'Description is too long (max 2000 characters).'; end if;
  if p_achieved_on is null then raise exception 'Please add the date of the achievement.'; end if;
  if p_achieved_on > public.school_today() then raise exception 'The achievement date can''t be in the future.'; end if;
  if not public.is_media_url(p_image_url) then raise exception 'The image must be uploaded through the site.'; end if;

  if p_id is null then
    insert into public.club_achievements (club_id, title, description, achieved_on, image_url, created_by)
    values (p_club, p_title, p_description, p_achieved_on, nullif(p_image_url, ''), v_me.id)
    returning id into v_id;
  else
    select * into v_row from public.club_achievements where id = p_id for update;
    if not found or v_row.club_id <> p_club then raise exception 'Achievement not found.'; end if;
    if v_row.status not in ('pending', 'changes_requested') then
      raise exception 'Only pending achievements or ones returned for changes can be edited.';
    end if;
    v_was_pending := v_row.status = 'pending';
    update public.club_achievements
    set title = p_title, description = p_description, achieved_on = p_achieved_on,
        image_url = nullif(p_image_url, ''), status = 'pending', submitted_at = now()
    where id = p_id;
    v_id := p_id;
  end if;

  if not v_was_pending then
    perform public.notify_admins('New achievement for approval',
      format('%s submitted an achievement for %s: "%s".', public.person_name(v_me.id),
        (select name from public.clubs where id = p_club), p_title),
      '/admin.html#approvals');
  end if;
  return v_id;
end;
$$;

-- withdraw something that hasn't been approved yet
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
    if v_status = 'approved' then raise exception 'Published posts can''t be withdrawn. Ask an administrator.'; end if;
    delete from public.club_posts where id = p_id;
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

-- ------------------------------------------------------------
-- Approval center (admins): approve / reject / request changes.
-- p_kind: club | club_change | questionnaire | post | achievement
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Admin: leadership, club status
-- ------------------------------------------------------------
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
    select 1 from public.profiles where id = p_user and account_type = 'student' and role <> 'admin' and status = 'active'
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

create or replace function public.admin_end_leadership(p_leader_row uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.club_leaders;
begin
  perform public.require_admin();
  select * into v_row from public.club_leaders where id = p_leader_row for update;
  if not found or v_row.ended_at is not null then raise exception 'Active leadership not found.'; end if;
  update public.club_leaders set ended_at = now() where id = p_leader_row;
  perform public.notify(v_row.user_id, 'Leadership ended',
    format('Your leadership role in %s has ended. You remain a member.', (select name from public.clubs where id = v_row.club_id)),
    '#/club/' || v_row.club_id);
end;
$$;

create or replace function public.admin_set_club_status(p_club uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs;
  v_text text;
begin
  perform public.require_admin();
  if p_status not in ('approved', 'suspended', 'archived') then raise exception 'Invalid status.'; end if;
  select * into v_club from public.clubs where id = p_club for update;
  if not found then raise exception 'Club not found.'; end if;
  if v_club.status not in ('approved', 'suspended', 'archived') then
    raise exception 'Use the Approval Center for clubs that are still requests.';
  end if;
  update public.clubs
  set status = p_status,
      recruitment_open = case when p_status = 'approved' then recruitment_open else false end,
      updated_at = now()
  where id = p_club;

  v_text := case p_status when 'approved' then 'reactivated' when 'suspended' then 'suspended' else 'archived' end;
  perform public.notify_club_leaders(p_club, 'Club ' || v_text,
    format('%s was %s by an administrator.', v_club.name, v_text), '#/club/' || p_club);
end;
$$;

-- ------------------------------------------------------------
-- Notifications: mark read (own only). Null = mark all.
-- ------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
$$;

-- ------------------------------------------------------------
-- Activity leaderboard. Score = completed events x3 +
-- announcements/updates x1 + achievements x5 (approved only).
-- p_period: month | semester | year | all
-- Semesters: Sept 1 – Jan 31, and Feb 1 – Aug 31. School year starts Sept 1.
-- ------------------------------------------------------------
create or replace function public.club_leaderboard(p_period text default 'all')
returns table (
  club_id uuid,
  name text,
  category text,
  logo_url text,
  events_count integer,
  posts_count integer,
  achievements_count integer,
  score integer
)
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select public.school_today() as today
  ),
  b as (
    select
      case p_period
        when 'month' then date_trunc('month', t.today)::date
        when 'semester' then
          case
            when extract(month from t.today) >= 9 then make_date(extract(year from t.today)::int, 9, 1)
            when extract(month from t.today) = 1 then make_date(extract(year from t.today)::int - 1, 9, 1)
            else make_date(extract(year from t.today)::int, 2, 1)
          end
        when 'year' then
          case
            when extract(month from t.today) >= 9 then make_date(extract(year from t.today)::int, 9, 1)
            else make_date(extract(year from t.today)::int - 1, 9, 1)
          end
        else date '1900-01-01'
      end as since,
      t.today
    from t
  ),
  stats as (
    select
      c.id, c.name, c.category, c.logo_url,
      (select count(*) from public.club_posts p
        where p.club_id = c.id and p.kind = 'event' and p.status = 'approved'
          and p.event_date < b.today and p.event_date >= b.since)::int as events_count,
      (select count(*) from public.club_posts p
        where p.club_id = c.id and p.kind in ('announcement', 'event_result') and p.status = 'approved'
          and (p.published_at at time zone 'Asia/Ulaanbaatar')::date >= b.since)::int as posts_count,
      (select count(*) from public.club_achievements a
        where a.club_id = c.id and a.status = 'approved' and a.achieved_on >= b.since)::int as achievements_count
    from public.clubs c, b
    where c.status = 'approved'
  )
  select id, name, category, logo_url, events_count, posts_count, achievements_count,
         events_count * 3 + posts_count + achievements_count * 5 as score
  from stats
  order by score desc, name asc;
$$;

-- ------------------------------------------------------------
-- Approval queue for the admin dashboard. security_invoker means the
-- caller's RLS applies: only admins see every row.
-- ------------------------------------------------------------
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
         case p.kind when 'event' then 'Event announcement' when 'event_result' then 'Event results' else 'Club announcement' end,
         p.id, p.club_id, c.name, p.title, p.created_by, p.submitted_at, p.status, p.review_note
  from public.club_posts p join public.clubs c on c.id = p.club_id
  where p.reviewed_at is not null or p.status = 'pending'
  union all
  select 'achievement', 'Achievement',
         a.id, a.club_id, c.name, a.title, a.created_by, a.submitted_at, a.status, a.review_note
  from public.club_achievements a join public.clubs c on c.id = a.club_id;

-- ============================================================
-- 14. MEDIA STORAGE (club logos, posters, photos)
-- ============================================================
-- Public bucket (anyone with the link can view an image). Uploads are
-- limited to images up to 5 MB, and each user can only upload into a
-- folder named after their own user id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-media', 'club-media', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "club_media_insert_own_folder" on storage.objects;
create policy "club_media_insert_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'club-media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "club_media_delete_own" on storage.objects;
create policy "club_media_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'club-media' and owner = auth.uid());

commit;
