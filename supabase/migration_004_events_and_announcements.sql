-- ============================================================
-- Shine Zuun Bileg Clubs — club events + school-wide announcements
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- club_events ----------

create table public.club_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  title text not null,
  description text not null default '',
  event_date timestamptz not null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.club_events enable row level security;

-- anyone signed in can see events for an approved (publicly visible) club
create policy "club_events_select_approved" on public.club_events
  for select using (
    exists (select 1 from public.clubs where clubs.id = club_events.club_id and clubs.status = 'approved')
  );

-- the club's owner can always see their own club's events (even if the club is still pending)
create policy "club_events_select_owner" on public.club_events
  for select using (
    exists (select 1 from public.clubs where clubs.id = club_events.club_id and clubs.created_by = auth.uid())
  );

create policy "club_events_select_admin" on public.club_events
  for select using (public.is_admin());

-- only the club's owner can create/edit/delete its events
create policy "club_events_insert_owner" on public.club_events
  for insert with check (
    auth.uid() = created_by
    and exists (select 1 from public.clubs where clubs.id = club_events.club_id and clubs.created_by = auth.uid())
  );

create policy "club_events_update_owner" on public.club_events
  for update using (
    exists (select 1 from public.clubs where clubs.id = club_events.club_id and clubs.created_by = auth.uid())
  );

create policy "club_events_delete_owner" on public.club_events
  for delete using (
    exists (select 1 from public.clubs where clubs.id = club_events.club_id and clubs.created_by = auth.uid())
  );

-- admins can moderate events too
create policy "club_events_update_admin" on public.club_events
  for update using (public.is_admin());

create policy "club_events_delete_admin" on public.club_events
  for delete using (public.is_admin());

-- ---------- announcements ----------

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  event_date timestamptz,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

-- everyone signed in sees all announcements
create policy "announcements_select_authenticated" on public.announcements
  for select using (auth.role() = 'authenticated');

-- only admins create/edit/delete announcements
create policy "announcements_insert_admin" on public.announcements
  for insert with check (public.is_admin() and auth.uid() = created_by);

create policy "announcements_update_admin" on public.announcements
  for update using (public.is_admin());

create policy "announcements_delete_admin" on public.announcements
  for delete using (public.is_admin());
