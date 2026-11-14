# SHZB Community

School clubs platform for Shine Zuun Bileg. Students discover clubs, apply through club-specific forms and build a club history. Club leaders run their clubs. Teachers browse. Administrators approve everything that goes public.

**Stack:** plain HTML/CSS/JS in `public/` (no build step), Supabase (Auth, Postgres with Row Level Security, Storage), and Vercel (static hosting plus two serverless functions in `api/`).

## Setup checklist

### 1. Database

Run the SQL files in `supabase/` **in order** in the Supabase dashboard (SQL Editor → New query → paste → Run):

1. `migration.sql`
2. `migration_002_club_membership.sql`
3. `migration_003_teacher_type_and_domain_toggle.sql`
4. `migration_004_events_and_announcements.sql`
5. `migration_005_grades_profiles_history.sql`
6. `migration_006_platform.sql`: leaders, approvals, recruitment forms, applications, posts, achievements, notifications, categories, leaderboard, and image storage
7. `migration_007_admin_create_club.sql`: lets administrators create clubs directly (active immediately, with a founding date and optional leader)
8. `migration_008_profile_self_edit.sql`: people can edit their own name, and students their own grade and class (including Graduated)
9. `migration_009_past_events.sql`: leaders can record past events (date in the past, description, up to 3 photos) straight into Event History
10. `migration_010_leaderboard_counts_events.sql`: upcoming event announcements also score on the leaderboard (1 pt when published)
11. `migration_011_edit_published_posts.sql`: leaders can edit (with admin approval) and delete their published posts; admins can edit and delete any post
12. `migration_012_admin_students.sql`: administrators who are students can join, request and lead clubs like other students

Migration 006 runs in a single transaction. If anything fails, nothing is applied. It carries existing data forward:
- Existing approved clubs' creators become their leaders.
- Pending join requests become applications.
- Old club events become approved event posts.

> **Back up first** (Database → Backups) before running 006 on the live project.

### 2. Supabase Auth settings (dashboard → Authentication)

| Setting | Value |
|---|---|
| URL Configuration → Site URL | `https://shzbcommunity.com` |
| URL Configuration → Redirect URLs | `https://shzbcommunity.com/**` (plus `http://localhost:3000/**` for local testing) |
| Email Templates → Reset Password | Keep the `{{ .ConfirmationURL }}` link and add `{{ .Token }}` so users can also type the code on the site |
| Providers → Email → Email OTP Expiration | Expiry for verification and reset codes (default 1 hour; 15–60 min recommended) |
| Rate Limits | Limits how often reset and verification emails can be requested |

**Email delivery.** Password reset, signup verification and email changes all depend on Supabase sending email. Supabase's built-in sender is for testing only: it is heavily rate-limited and may only deliver to your project's team members. For real users, configure **Authentication → SMTP Settings** with a provider (Resend, SendGrid, Mailgun, Amazon SES, or the school's Google Workspace SMTP). Until that is done, password reset works only for addresses the built-in sender will deliver to.

How password reset works: the user enters their email and always sees the same generic message, so the form can't be used to discover accounts. Supabase emails a single-use, expiring link and code, rate-limits requests, and stores the new password hashed with bcrypt. After a reset or password change, other devices are signed out.

### 3. Vercel environment variables

The serverless functions (`api/admin-delete-user.js`, `api/admin-user-status.js`) need:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, the `service_role` key. **Never** put it in `public/` |

Without these, account deletion and suspension from the admin dashboard fail with an error. Everything else still works.

### 4. Before launch

The school-email restriction is **temporarily disabled for testing**. To re-enable it:
- set `ENFORCE_SCHOOL_EMAIL_DOMAIN = true` in `public/script.js`;
- uncomment the domain check in `handle_new_user()`, then re-run that function definition (it was last defined in `migration_005_grades_profiles_history.sql`).

## Roles and permissions

All permissions are enforced in the database: RLS policies plus `security definer` workflow functions in migration 006 that check the caller's role. Hiding buttons in the UI is only for convenience.

| | Student | Teacher | Club leader | Admin |
|---|---|---|---|---|
| Browse clubs, profiles, announcements, leaderboard | ✓ | ✓ | ✓ | ✓ |
| Apply to / request to leave clubs | ✓ | | ✓ | |
| Request a new club | ✓ | | ✓ | |
| Manage own club: applications, members, recruitment form, posts, achievements, profile | | | ✓ (own clubs only) | ✓ |
| Publish anything public | | | Submits for approval | ✓ |
| Approval Center, leaders, categories, users, suspension | | | | ✓ |

"Club leader" is not a separate account type. A student leads specific clubs through rows in `club_leaders` (leader or co-leader, with start and end dates).

## Main workflows

- **New club:** a student submits a request (name, category, description, logo, proposed leader). An admin approves, rejects or requests changes. On approval the club goes public, and the proposed leader becomes its leader and member.
- **Recruitment:** the leader builds a form (short answer, long answer, multiple choice, checkboxes), previews it and submits it. Once an admin approves it, the leader can open recruitment. Each new version needs approval again, and old applications keep the exact questions they answered.
- **Applications:** students fill in the form, with one pending application per club. Leaders review answers, add internal notes, and accept or reject. Accepting creates the membership in the same transaction, and the student is notified.
- **Leaving:** a member requests to leave and a leader confirms. The membership gets an end date and stays on the student's history; it is never deleted.
- **Posts:** event announcements (date, times, location, poster), event results (linked to a past event, 1–3 photos) and club announcements. Everything waits for admin approval. An event appears under "Upcoming" until its date, then moves to Event History automatically.
- **Leaderboard:** ranks clubs by approved activity: every published post (event announcements, past events, results) ×1, every event that has taken place ×3, achievements ×5 (hidden for now). Periods are month, semester (Sep–Jan, Feb–Aug), school year (from Sep 1) and all time.
- **Notifications:** created inside the same database transaction as the action, so a notification exists only if the action succeeded.

## Project layout

```
public/
  index.html, script.js   community site (hash routes: #/home, #/club/<id>, #/student/<id>, ...)
  leader.js               Leader Dashboard (#/lead/<clubId>/<tab>)
  admin.html, admin.js    admin dashboard (#overview, #approvals, #clubs/<id>, #users, ...)
  shared.js               helpers used by both pages (icons, dates, dialogs, uploads)
  style.css, admin.css
api/                      Vercel serverless functions (service-role operations)
supabase/                 SQL migrations, run in order
```
