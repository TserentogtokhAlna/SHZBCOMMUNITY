-- ============================================================
-- Shine Zuun Bileg Clubs — Supabase schema
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- tables ----------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  role text not null default 'student' check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);

create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  description text not null,
  meeting text not null default '',
  created_by uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  created_at timestamptz not null default now()
);

-- ---------- new-signup handling ----------
-- Every new auth.users row must be a @shinezuunbileg.edu.mn address (enforced here,
-- not just in the app, so it can't be bypassed) and gets a matching profiles row.
-- first_name/last_name come from the signUp() call's options.data.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email !~* '@shinezuunbileg\.edu\.mn$' then
    raise exception 'Email must end with @shinezuunbileg.edu.mn';
  end if;

  insert into public.profiles (id, first_name, last_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    new.email
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.clubs enable row level security;

-- security definer so this can check role without recursing into profiles' own RLS
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- profiles: any signed-in user can read the list (needed to show club creator names;
-- emails follow a predictable firstname.lastname pattern anyway, so this isn't sensitive).
-- No one can insert directly (only the trigger above does, as security definer).
-- No one can delete directly either — account deletion goes through a privileged
-- server function so the underlying login (auth.users) is removed too, not just the row.
create policy "profiles_select_authenticated" on public.profiles
  for select using (auth.role() = 'authenticated');

-- clubs: everyone signed in sees approved clubs; admins also see pending ones.
create policy "clubs_select_approved" on public.clubs
  for select using (status = 'approved');

create policy "clubs_select_admin" on public.clubs
  for select using (public.is_admin());

-- students can create clubs for themselves, always starting pending
-- (the check on status blocks anyone from inserting a pre-approved club directly)
create policy "clubs_insert_own" on public.clubs
  for insert with check (auth.uid() = created_by and status = 'pending');

-- only admins can approve (update) or delete clubs
create policy "clubs_update_admin" on public.clubs
  for update using (public.is_admin());

create policy "clubs_delete_admin" on public.clubs
  for delete using (public.is_admin());
