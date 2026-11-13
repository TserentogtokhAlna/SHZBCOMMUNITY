-- ============================================================
-- SHZB Community — migration 008: people can edit their own name, and
-- students their own grade/class (including marking themselves graduated)
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migration_006_platform.sql.
--
-- Grades still advance automatically: graduation_year (the year the student
-- finishes grade 12) is what's stored, and the current grade is computed
-- from today's date (school year rolls over Sept 1). Editing the grade just
-- corrects graduation_year.
--
-- Still locked for non-admins: email, role, account type and status.
-- ============================================================

begin;

create or replace function public.enforce_profile_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
  v_school_year integer;
begin
  new.bio := left(coalesce(new.bio, ''), 1000);

  -- admins (and trusted server code, where auth.uid() is null) can change anything
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  new.email := old.email;
  new.role := old.role;
  new.account_type := old.account_type;
  new.status := old.status;

  new.first_name := btrim(coalesce(new.first_name, ''));
  new.last_name := btrim(coalesce(new.last_name, ''));
  if char_length(new.first_name) not between 1 and 50 or char_length(new.last_name) not between 1 and 50 then
    raise exception 'First and last name are required (up to 50 characters each).';
  end if;

  if old.account_type <> 'student' then
    -- teachers have no grade or class
    new.graduation_year := old.graduation_year;
    new.class_section := old.class_section;
    return new;
  end if;

  -- school year that started on the most recent Sept 1 (school time)
  v_today := public.school_today();
  v_school_year := extract(year from v_today)::integer;
  if extract(month from v_today) < 9 then
    v_school_year := v_school_year - 1;
  end if;

  -- grade 6 this year = graduates in v_school_year + 7; "graduated" = any
  -- year up to v_school_year (kept within a sane range)
  -- (only checked when it changes, so an old account without a grade can
  -- still save its bio or name)
  if new.graduation_year is distinct from old.graduation_year and (
       new.graduation_year is null
       or new.graduation_year > v_school_year + 7
       or new.graduation_year < v_school_year - 30) then
    raise exception 'Please choose a valid grade.';
  end if;
  if new.class_section is distinct from old.class_section
     and new.class_section is not null and new.class_section not in ('A', 'B', 'C') then
    raise exception 'Please choose a valid class.';
  end if;

  return new;
end;
$$;

commit;
