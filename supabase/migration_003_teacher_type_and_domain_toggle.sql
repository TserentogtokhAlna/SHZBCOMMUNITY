-- ============================================================
-- Shine Zuun Bileg Clubs — teacher/student label + TEMPORARY
-- domain-restriction toggle (for testing with non-school emails)
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- account_type is a purely descriptive label (student/teacher), separate from
-- `role` (student/admin) which is what actually controls permissions. Teachers
-- have identical permissions to students for now.
alter table public.profiles
  add column account_type text not null default 'student' check (account_type in ('student', 'teacher'));

-- ---------- TEMPORARY: domain restriction disabled for testing ----------
-- To re-enable before real launch, uncomment the "if" block below and re-run
-- this whole file (it's a `create or replace`, safe to run again).
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

  insert into public.profiles (id, first_name, last_name, email, account_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    new.email,
    coalesce(new.raw_user_meta_data->>'account_type', 'student')
  );
  return new;
end;
$$;
