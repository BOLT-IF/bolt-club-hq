# Discarded / superseded content (v2 → v3)

Reason for every entry: Ashok removed roster generation from the requirements (it stays a separate Render app), chose a **greenfield** repo `BOLT-IF/bolt-club-hq`, and chose a **Cloudflare Workers + Neon + Clerk + R2** stack. v2 files are untouched.

## Stories removed

| v2 story | Why it's gone | Anything kept? |
|---|---|---|
| S0.1 Backend split of `app.py` | No shared codebase anymore | Replaced by S0.1 Repo scaffold |
| S0.2 Alembic baseline from the prod schema, stamp, remove `_ensure_table_columns` | Greenfield repo, so there is no legacy schema | One initial migration still applies (Drizzle) |
| S0.4 Render hosting / Neon cutover runbook | No Render for the club app, and no data to migrate | Backups and restore drill moved to S0.5 |
| S0.8 Same-origin edge spike (cookie survival) | Workers serve the API and assets from one origin, and Clerk uses bearer tokens, so the cookie risk is gone | The real-device spike became S0.6 (Clerk login, Google in standalone, push CPU, WhatsApp OG) |
| S1.1a Email link + code, scanner-safe confirm page, Postgres rate limits | Clerk handles email login, abuse protection and email delivery | Install mode leads with email code (S1.1) |
| S1.1b Google redirect | Clerk handles it | Visibility rule from S0.6 |
| S1.2 Session cookie, `/me`, logout-all | Clerk sessions; `/me` folded into S1.1 | Intent round-trip kept in S1.1 |
| S2.2 Member ↔ roster player link, `is_guest` on players | No shared player table | Replaced by `Member.roster_name` + name matching inside R1 |
| S8.1 (v2) Seed planner from closed event via `event_closed` | Roster is now an external app | Replaced by S8.3 deep link + R1 import sheet |
| Attendance default "from the started roster" | The club app can't see roster sessions | Defaults to the confirmed RSVP list instead |

## Plan content removed or changed

| v2 content | v3 |
|---|---|
| FastAPI/Python backend on Render | TypeScript Hono API on Cloudflare Workers |
| Render cold-start mitigations ("waking up" UI, daytime tick keeps it warm) | Not needed, because Workers don't sleep. A "stale data" badge is kept for offline use. |
| Render instance-hour budget | Not relevant. Workers request/CPU budget instead (PLAN-v3 §11.3) |
| Redis drop note | Not relevant |
| cron-job.org scheduler | Cloudflare Cron Triggers |
| Resend + verified sending domain for login email | Clerk sends login email |
| Cookie auth, `SameSite`, CSRF content-type/origin rules | Bearer tokens. An origin check is kept on state-changing routes as defence in depth. |
| `pywebpush` | WebCrypto web-push library in the Worker, with batched sends |
| `IdempotencyRecord` etc. on SQLAlchemy | Same design on Drizzle |
| Unittest + pytest dual suites, SQLite for roster Playwright | Vitest (domain/worker/ui) + Playwright; Postgres for Worker tests |
| Images stored as bytes in Postgres | R2 objects |
| `players.is_guest`, `Member.player_id` | `Member.roster_name`, `guest: true` in the deep-link payload |
| `ADMIN_RECOVERY_TOKEN` replacement note | Not relevant to the new repo. The roster app keeps its own token model. |
| Roster as "More → Roster" inside the club app | Roster is a separate app reached by the deep link |
| Critical path 10 | 9 |
| 51 stories | 48 (47 club + R1 in the roster repo) |

## Recommendations reversed

| Earlier advice | Why it changed |
|---|---|
| "Build on this stack, in this repo" (2026-11-23 morning) | That advice rested on requirement 6's tight roster integration plus Render's free-hours limit. With roster removed, both reasons are gone, and a greenfield Workers app is simpler and has no cold starts. |
| "Keep FastAPI on Render behind a Worker" | Only needed for the Python roster engine, which is now out of scope |

## Options considered and not chosen

| Option | Why not |
|---|---|
| Copy-list only (no deep link) | Ashok chose the deep link. Copy is kept as a fallback. |
| Deep link with a signed token that the roster app fetches from the club API | Needs a cross-app API, CORS and auth. The fragment payload is self-contained, never reaches the server, and nothing is written without an organizer confirming. |
| Neon HTTP driver | Can't hold an interactive transaction, and the money rules need row locks. Use Hyperdrive or the WebSocket driver instead. |
| Roles in Clerk metadata | Would lock us into Clerk. Roles live in our database. |
