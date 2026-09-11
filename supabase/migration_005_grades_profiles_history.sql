-- ============================================================
-- Shine Zuun Bileg Clubs — grade/class, student bio, club-history CV,
-- join messages
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- profiles: grade/class + bio ----------
-- graduation_year is the calendar year the student is expected to finish
-- grade 12 (nullable for teachers/admins). Current grade is computed from
-- this in the app (school year rolls over Sept 1), so no yearly migration
-- or cron job is needed to "promote" students.

alter table public.profiles
  add column graduation_year integer,
  add column class_section text check (class_section in ('A', 'B', 'C')),
  add column bio text not null default '';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- if new.email !~* '@shinezuunbileg\.edu\.mn$' then
  --   raise exception 'Email must end with @shinezuunbileg.edu.mn';
  -- end if;

  insert into public.profiles (id, first_name, last_name, email, account_type, graduation_year, class_section)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    new.email,
    coalesce(new.raw_user_meta_data->>'account_type', 'student'),
    nullif(new.raw_user_meta_data->>'graduation_year', '')::integer,
    nullif(new.raw_user_meta_data->>'class_section', '')
  );
  return new;
end;
$$;

-- students can update their own bio (nothing else on their own profile)
create or replace function public.enforce_profile_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    new.first_name := old.first_name;
    new.last_name := old.last_name;
    new.email := old.email;
    new.role := old.role;
    new.account_type := old.account_type;
    new.graduation_year := old.graduation_year;
    new.class_section := old.class_section;
  end if;
  return new;
end;
$$;

create trigger before_profile_update_enforce_rules
  before update on public.profiles
  for each row execute function public.enforce_profile_update_rules();

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

create policy "profiles_update_admin" on public.profiles
  for update using (public.is_admin());

-- ---------- club_members: join message + "left" history for the CV ----------

alter table public.club_members
  add column message text not null default '',
  add column left_at timestamptz;

alter table public.club_members drop constraint club_members_status_check;
alter table public.club_members add constraint club_members_status_check
  check (status in ('pending', 'approved', 'left'));

-- a student's club history (approved + left) is visible to anyone signed in,
-- same openness rationale as the rest of profiles/clubs — lets a club owner
-- review an applicant's past involvement. Pending applications stay private
-- (visible only to the applicant and that club's owner, via existing policies).
drop policy "club_members_select_approved" on public.club_members;
create policy "club_members_select_public_history" on public.club_members
  for select using (status in ('approved', 'left'));

-- a member can leave their own club (approved -> left); the trigger below
-- blocks them from making any other change (e.g. self-approving)
create policy "club_members_update_self" on public.club_members
  for update using (auth.uid() = user_id);

create or replace function public.enforce_club_member_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_owner boolean;
begin
  select exists (
    select 1 from public.clubs where clubs.id = new.club_id and clubs.created_by = auth.uid()
  ) into is_owner;

  if not is_owner and not public.is_admin() then
    if old.user_id = auth.uid() and (
      (old.status = 'approved' and new.status = 'left') or
      (old.status = 'left' and new.status = 'pending')
    ) then
      -- allowed: a member leaving their own club, or re-applying after having left
      null;
    else
      new.status := old.status;
      new.left_at := old.left_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger before_club_member_update_enforce_rules
  before update on public.club_members
  for each row execute function public.enforce_club_member_update_rules();
