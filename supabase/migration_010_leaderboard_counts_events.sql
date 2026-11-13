-- ============================================================
-- SHZB Community — migration 010: leaderboard counts event announcements
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- Run AFTER migration_006_platform.sql.
--
-- Scoring (approved posts only):
--   every published post (event announcement, past event, event results) = 1 pt,
--     counted by the date it was approved
--   every event that has taken place                                       = 3 pts,
--     counted by the event date
--   achievements (hidden for now)                                          = 5 pts
-- Same function signature as before.
-- ============================================================

begin;

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
        where p.club_id = c.id and p.kind in ('announcement', 'event', 'event_result') and p.status = 'approved'
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

commit;
