-- ============================================================
-- Shine Zuun Bileg Clubs — club membership + owner edit rights
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- (Run AFTER migration.sql — this builds on top of it.)
-- ============================================================

-- ---------- club_members table ----------

create table public.club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  applied_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (club_id, user_id)
);

alter table public.club_members enable row level security;

-- a student sees their own application/membership row (any status)
create policy "club_members_select_own" on public.club_members
  for select using (auth.uid() = user_id);

-- everyone signed in can see APPROVED members (public members list)
create policy "club_members_select_approved" on public.club_members
  for select using (status = 'approved');

-- the club's owner sees every row for their own club (including pending requests)
create policy "club_members_select_owner" on public.club_members
  for select using (
    exists (
      select 1 from public.clubs
      where clubs.id = club_members.club_id and clubs.created_by = auth.uid()
    )
  );

-- admins see everything, for parity/support
create policy "club_members_select_admin" on public.club_members
  for select using (public.is_admin());

-- a student can apply for themselves; always starts pending
create policy "club_members_insert_own" on public.club_members
  for insert with check (auth.uid() = user_id and status = 'pending');

-- the club owner can approve/reject (update status) on rows for their own club
create policy "club_members_update_owner" on public.club_members
  for update using (
    exists (
      select 1 from public.clubs
      where clubs.id = club_members.club_id and clubs.created_by = auth.uid()
    )
  );

-- a student can withdraw their own application/membership; the owner can remove a member
create policy "club_members_delete_self_or_owner" on public.club_members
  for delete using (
    auth.uid() = user_id
    or exists (
      select 1 from public.clubs
      where clubs.id = club_members.club_id and clubs.created_by = auth.uid()
    )
  );

-- when a club is created, its creator automatically becomes an approved member
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.club_members (club_id, user_id, status, decided_at)
  values (new.id, new.created_by, 'approved', now())
  on conflict (club_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_club_created_add_owner
  after insert on public.clubs
  for each row execute function public.add_owner_as_member();

-- ---------- let club owners edit their own club ----------

create policy "clubs_update_owner" on public.clubs
  for update using (auth.uid() = created_by);

-- owners can change name/category/description/meeting, but not quietly self-approve
-- their own club or reassign ownership — only admins can change those two fields
create or replace function public.enforce_club_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    new.status := old.status;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

create trigger before_club_update_enforce_rules
  before update on public.clubs
  for each row execute function public.enforce_club_update_rules();
