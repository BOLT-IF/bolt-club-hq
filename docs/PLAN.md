# Bolt Club HQ: Product & Technical Plan (v3)

Status: Planning only. No code.
v3 = v2 with three changes from Ashok:
- (a) The roster generator is **out of scope**. It stays a separate app on Render.
- (b) **Greenfield** repo `BOLT-IF/bolt-club-hq`.
- (c) $0 hosting stack: **Cloudflare Workers/Pages + Neon + Clerk + R2**. The domain is the only cost.

The roster integration is reduced to a **deep link** (§8). Content dropped since v2 is in `history/DISCARDED-v3.md`. Companion file: `STORIES.md`. Later decisions: `DECISIONS.md`.
Date: 2026-11-23. Owner: Ashok Bommisetti.

---

## 1. Vision

One installable app (a PWA on Android Chrome and iOS Safari) that runs the club: sessions, RSVPs, term series and passes, money owed, reminders and polls. A WhatsApp message with one link is enough to get people signed up. At a session, the organizer taps once to send the confirmed attendees to the existing roster generator.

Success criteria for the first term:
- 100% of club sessions are RSVPed in the app.
- Admins reconcile payments in under 10 minutes a week.
- Zero "why do I owe this" disputes.
- The manager.io import takes under 5 minutes a month.
- The only running cost is the domain (~100–150 SEK/yr).

---

## 2. Decision record

### Interview (2026-11-21)
| Topic | Decision |
|---|---|
| Login | Email code (and link) + Google, now provided by **Clerk** |
| Size | 45 members, 3–4 sessions/week, each a different format |
| Channels | Web push + in-app inbox (Clerk sends the login emails) |
| Full sessions | When RSVP closes, spots fill in this order: **prepaid → non-prepaid members → guests**, first-come within each tier. The waitlist follows the same order. |
| Late cancel | Non-prepaid members pay the ad-hoc fee unless their spot is refilled. Prepaid: 0. |
| Guests | The organizer sets the max per member (default 1). The host is charged the event's ad-hoc fee. |
| Member one-offs | Free. Money is settled outside the app. |
| Prepay | A whole series per 6-month term. No refunds. Mid-term joiners pay a pro-rated price. |
| No-shows | Prepaid: 0. Non-prepaid: ad-hoc fee. |
| RSVP close | 24h before start by default; the creator can change it. Before close, prepaid members see Confirmed and others see Requested. Non-prepaid members are notified when confirmed. |
| Overflow | Pass sales are capped at series capacity |
| Payments | Bank transfer, confirmed by an admin |
| Reminders | Admins set rules and frequency, plus manual blasts. Members can mute every category. |
| Polls | Single or multi choice, image options |

### Council round (2026-11-21)
| Topic | Decision |
|---|---|
| "Pay quarterly" | A reminder to settle the balance. No membership fee. |
| Unpaid pass | Priority starts immediately. An admin can revoke the pass after N days (default 21). |
| Cancelled series night | No compensation. The terms say "up to N sessions", and skip-dates are locked once sales open. |
| Domain | Buy one (the only cost) |
| Admin paid one-offs | Yes. Pass holders pay too. |
| Member leaves mid-term | The pass seat is not resold |
| Captains | Yes, non-admin organizers per series |
| Accepting a waitlist promotion | Not required |
| Member polls | No |
| Free member one-offs | Confirmed instantly, first-come |
| Repo | Private |
| Bookkeeping | Required by law; done in **manager.io** |

### Platform round (2026-11-23)
| Topic | Decision |
|---|---|
| Roster generator | **Removed from requirements.** It stays a separate app on Render, linked by deep link. |
| Repo | New greenfield repo `BOLT-IF/bolt-club-hq` |
| Stack | Cloudflare Workers (API + static assets) + Neon + Clerk + R2. TypeScript throughout. |
| Roster hand-off | **Deep link** that carries the attendee list, plus a "Copy list" fallback |

---

## 3. Assumptions (confirm before Wave 2)

| # | Assumption |
|---|---|
| A1 | SEK in whole kronor. Europe/Stockholm. Stored as UTC `timestamptz`. |
| A2 | Closed club. People join via an invite link or "request to join" from an event or series link, and an admin approves. Clerk handles identity; **membership and roles live in our database**. |
| A3 | Approved members see attendee names; pending members and anonymous visitors don't |
| A4 | Guests have a display name only |
| A5 | After close, open spots go first-come. A prepaid member who RSVPs late goes to the top of the waitlist but never bumps anyone already confirmed. |
| A6 | Auto-promotion runs until 3h before start (configurable). After that, a free spot is offered to everyone on the waitlist and the first to claim it gets it. A promoted person who cancels counts as a late cancel. |
| A7 | When there are several late cancels, a refill reverses the earliest one first |
| A8 | The pass cap is the minimum capacity across the series' events |
| A9 | Push quiet hours are 22:00–08:00. Messages are queued. |
| A10 | Money records are kept for 7 years (confirm with the treasurer) |
| A11 | An admin can't record payments or waivers on their own ledger unless they are the only admin, in which case it is flagged |
| A12 | Clerk's free plan covers 45 users well inside its monthly-active cap (**verify current limit in S0.5**) |

---

## 4. Roles & permissions

| Capability | Member | Event creator | Series captain | Admin |
|---|---|---|---|---|
| View events, RSVP, bring guests, "I've paid" | ✔ | ✔ | ✔ | ✔ |
| Create a free one-off | ✔ | ✔ | ✔ | ✔ |
| Edit or cancel an event, close time, guest limit, capacity | | own one-offs | own series | all |
| Mark attendance, open in roster generator | | own | own series | all |
| Buy passes, see own balance and attendance | ✔ | ✔ | ✔ | ✔ |
| Create paid one-offs; manage terms, series, captains, settings | | | | ✔ |
| Money admin (claims, payments, waivers, revocation, export) | | | | ✔ (not on own ledger) |
| Approvals, roles, invites, reminders, broadcasts, polls, audit | | | | ✔ |

Admin safeguards:
- The last admin can't be demoted.
- `BOOTSTRAP_ADMIN_EMAIL` is re-applied as admin on every deploy.

Roles are **not** stored in Clerk metadata. Our database is the source of truth, which keeps Clerk replaceable.

---

## 5. Domain model

### 5.1 Entities (all created by the single initial Drizzle migration, S0.2)
```
Member            id, clerk_user_id (unique), display_name, email, roster_name?, role{member,admin},
                  status{pending,active,inactive,erased}, payment_ref (unique), joined_at, left_at?
Invite            id, token, created_by, expires_at, max_uses, uses, revoked_at?
JoinRequest       id, member_id, via{invite,event_link,series_link}, source_id?, created_at
ClubSettings      singleton: club_name, bank details, payment_instructions, quiet_hours,
                  pass_unpaid_revoke_days (21), auto_promote_cutoff_min (180), defaults,
                  accounting account codes, roster_app_url
Term              id, name, starts_on, ends_on, status{draft,open_for_passes,active,closed},
                  cloned_from_term_id?
Series            id, term_id, name, format{MD,WD,XD,mixed,open}, level, weekday, start_time,
                  duration_min, location, capacity, pass_price, adhoc_fee, max_guests_default,
                  rsvp_close_offset_min (1440), share_slug, skip_dates[], skip_dates_locked, pass_cap
SeriesCaptain     series_id, member_id
Event             id, series_id?, kind{series,member_oneoff,admin_oneoff}, created_by, title, format,
                  starts_at, ends_at, location, capacity, adhoc_fee, max_guests_per_member,
                  rsvp_close_at, allocation_mode{tiered,instant}, status{scheduled,closed,cancelled,
                  completed}, share_slug (≥ 8 chars random), closed_processed_at?, material_change_at?
Pass              id, member_id, series_id, price_charged, events_covered, status{active,revoked},
                  purchased_at, revoked_at?, granted_by?
Rsvp              id, event_id, member_id, status{requested,confirmed,waitlisted,offered,cancelled,
                  late_cancelled}, tier{1,2}, requested_at, confirmed_at?, cancelled_at?, refilled,
                  attendance{unknown,attended,no_show}
Guest             id, rsvp_id, name, status, tier=3, requested_at, refilled, attendance
LedgerEntry       id, member_id, kind{charge,payment,reversal,adjustment}, amount_sek (signed),
                  reason{pass,adhoc,guest,manual,payment,waiver,revocation,opening_balance},
                  event_id?, pass_id?, guest_id?, payment_claim_id?, reverses_entry_id?, note,
                  created_by, created_at, idempotency_key (unique), exported_at?
PaymentClaim      id, member_id, amount_sek, paid_on, note, status{pending,confirmed,rejected},
                  decided_by?, decided_at?, reject_reason?
IdempotencyRecord key, actor_id, route, response_hash, created_at
Notification      id, member_id, category, title, body, link, created_at, read_at, idempotency_key
PushSubscription  id, member_id, endpoint, keys, user_agent, created_at, last_success_at, failures
NotificationPref  member_id, category, muted;  Member.global_mute
ReminderRule      id, category, enabled, params, min_interval_days, template, updated_by
NotificationSendLog member_id, category, rule_id?, sent_at
OutboundPush      id, notification_id, status{queued,sent,failed,deferred}, not_before, attempts
SchedulerState    singleton: last_tick_at, last_tick_duration_ms, last_error
                  (next_due_at is mirrored into Workers KV to avoid waking Neon)
Poll, PollOption(image_key? → R2), PollVote
AuditLog          id, actor_id, action, entity, entity_id, before/after, at
DomainEventOutbox id, type, payload, created_at, processed_at
```

### 5.2 Invariants (each becomes a test)
1. The ledger is append-only; a database trigger blocks changes. The only exception is a one-time `exported_at` stamp. Balance = Σ amount.
2. Every ledger write carries an idempotency key. Every money-related POST carries an `Idempotency-Key` header.
3. Confirmed tier-1 members ≤ capacity. Active passes ≤ `pass_cap`.
4. A guest is confirmed only if their host is. When a host cancels, their guests are cancelled too.
5. One RSVP per member per event. Guests ≤ the event's limit.
6. Member one-offs are free, use instant allocation and never touch the ledger. Admin one-offs may charge a fee and use tiered allocation, with no tier 1.
7. The self-ledger guard (A11) always applies.
8. Erasing a member never deletes ledger amounts.

---

## 6. Business rules (same as v2)

### 6.1 RSVP lifecycle
```
 before close: instant mode → CONFIRMED if space else WAITLISTED (first-come, no money)
               tiered: pass holder of this series → CONFIRMED*, else REQUESTED
               cancel → CANCELLED, no fee
 close → allocation (6.2) + charges (6.3)
 after close:  space → CONFIRMED (+charge on paid events) else WAITLISTED (tier order, A5)
               cancel → LATE_CANCELLED: charge stands unless REFILLED (6.4)
               promotion: automatic until the cutoff (A6), then OFFERED to all, first claim wins
 * guaranteed by the pass cap
```

### 6.2 Allocation engine (pure TypeScript)
- Candidates are sorted by `(tier, requested_at, id)`. A guest is only eligible once their host is confirmed; a guest who doesn't fit is waitlisted while the host stays confirmed.
- **Worked example (a test):** 16 spots; 10 prepaid members, 9 non-prepaid members, 2 guests (hosted by prepaid members) at close. Result: all 10 prepaid confirmed, then the first 6 non-prepaid members by request time. Waitlist order: non-prepaid members 7, 8, 9, then guest A, then guest B.
- Properties (property-based tests with fast-check): never over capacity; no guest without a confirmed host; a higher tier is never left waiting while a lower tier is confirmed at close; deterministic.

### 6.3 Close processing
Triggered either by **close-on-read** (the first read after the deadline closes the event) or by the **Cron Trigger**. It runs as one Neon transaction:
1. Lock the event row (`SELECT … FOR UPDATE SKIP LOCKED`) and re-check `closed_processed_at`.
2. Run the allocation and persist it.
3. Create charges with idempotency keys.
4. Queue notifications and write an `event_closed` outbox row.

A single read closes at most 5 due events. Correctness never depends on the cron.

### 6.4 Charging
| Situation | Prepaid | Non-prepaid member | Guest (charged to host) |
|---|---|---|---|
| Confirmed at/after close (paid event) | 0 | fee | fee |
| Cancel before close | 0 | 0 | 0 |
| Late cancel, refilled | 0 | reversed | reversed |
| Late cancel, not refilled | 0 | stands | stands |
| No-show | 0 | stands | stands |
| Admin paid one-off | n/a (everyone pays) | fee | fee |
| Member one-off | 0 | 0 | 0 |

- **Refill:** someone is confirmed into a spot freed while the event was full. When several late cancels are waiting, the earliest is reversed first.
- **Handing over a spot:** done as a cancel plus a refill. There is no direct transfer.
- **Guests:** name edits are free. Guests added after close join the waitlist as tier 3.

### 6.5 Passes
- Price = `round_half_up(pass_price × remaining / total)`. Not offered when no events remain.
- Terms are shown before purchase: "Covers up to N sessions; no refunds; cancelled nights not compensated."
- Skip-dates lock at `open_for_passes`. An admin can override with a warning.
- **Revocation** (manual only): available once the pass charge is still unpaid after N days. It reverses the charge, frees the seat, moves the member's RSVPs to tier 2, and notifies them.
- A pass bought mid-term upgrades open RSVPs to tier 1.

### 6.6 Event changes
- **Cancelling an event** reverses all of its charges and notifies everyone.
- **A material change after close** (date, time or location) notifies everyone and opens a 24h free-cancel window.
- **Fees** can't change once an event has closed. A series fee change only affects events that haven't closed yet.
- **Capacity changes** follow the override rules: lowering capacity below the confirmed tier-1 count, or a cap below the passes sold, needs an admin override. Raising capacity promotes from the waitlist.

### 6.7 Member exit
- Future RSVPs are cancelled (late-cancel rules apply).
- The member keeps access to Money and attendance only. Reminders continue while they owe money.
- Their pass is kept but unusable, and the seat is not resold.
- Erasure requires a zero balance, or a waiver first.

### 6.8 One-off events
- **Member one-offs:** free, instant first-come, with a waitlist.
- **Admin one-offs:** optional fee and tiered allocation without tier 1, so pass holders pay.

---

## 7. Single-link RSVP (WhatsApp)
1. **Share** opens the Web Share API, falling back to copying a prebuilt text: `🏸 Thu Mixed Doubles 19:00 @ Hall X, 6/16 spots: https://<domain>/e/k3f9xq2m`.
2. **`/e/{slug}` and `/s/{slug}` are handled by the same Worker, which never sleeps.**
   - It returns HTML with OG tags (`noindex`, no attendee names, CSP) and then boots the SPA.
   - The OG data is read from **Workers KV**, which the API updates on every event write. WhatsApp's crawler never waits on a suspended Neon database, and Neon spends no compute on it.
   - If a key is missing in KV, it falls back to a Neon read, then to a generic preview.
3. **A logged-in member** sees one-tap RSVP and a guest stepper.
4. **A logged-out visitor** signs in with Clerk (email code, or Google where the S0.6 spike shows it works). The RSVP intent is saved and completes after login.
5. **A signed-in non-member, or a pending member,** gets "Request to join". After admin approval, the saved RSVP completes.
6. `/s/{slug}` points to the series' next open event.

On iOS, WhatsApp always opens links in Safari, not the installed app, and the two keep separate logins. The installed app's login screen therefore leads with **email code**, which works everywhere. The S0.6 spike checks Google inside the installed app.

---

## 8. Roster generator hand-off (deep link)

The roster generator is a separate app on Render, outside the club app's scope. The two apps share **no** API, login or database. The link is the only contract between them.

### 8.1 Link format `roster-import/v1` (the contract)
```
{ROSTER_APP_URL}/planner#import=<base64url(JSON)>
JSON = {
  "v": 1,
  "source": "bolt-club-hq",
  "event": { "title": "Thu Mixed Doubles", "starts_at": "2027-01-14T18:00:00Z", "format": "XD" },
  "players": [ { "name": "Ashok Bommisetti", "short": "Ashok", "guest": false }, … ]
}
```
- The data sits in the **URL fragment** (after `#`), so it is never sent to Render and never shows up in server logs. Twenty players encode to about 600–900 characters.
- `short` = the member's `roster_name` if set, otherwise their first name. Guests get `guest: true`.
- `format` is a hint only. The roster app maps it to its own draw config or ignores it.
- The schema is versioned. Readers must ignore unknown fields and must reject `v` values they don't support, showing a friendly message.

### 8.2 Club side (story S8.3)
- A closed event shows **"Open in roster generator"** to the organizer, captain or admin. It builds the link from confirmed members and guests, ordered by tier and confirmation time.
- **"Copy list"** is the fallback: plain text, one name per line.
- `roster_app_url` lives in ClubSettings. The button is hidden when it isn't set.

### 8.3 Roster side (story R1, built in the `roster-generator` repo)
- When `/planner` loads with `#import=`, the app decodes and validates the data and opens an **"Import from club event"** sheet.
- **Matching:** each name is compared with the directory, case-insensitively, by short name first and then full name. Matches are pre-selected. Unmatched names get a one-tap **"Add to directory"** (guests are labelled).
- An unsaved planner draft is only replaced after the organizer confirms. The fragment is cleared after import, so a reload doesn't import again.
- Nothing is written without an organizer action, so the link doesn't need a signature.
- **Malformed data** (bad base64, too large, wrong version) shows a non-blocking banner, and the planner works normally.

---

## 9. Money
**Member screen:**
- Shows the balance ("You owe 450 kr" or "Credit 100 kr"), plus any pending claim.
- Shows the bank details and the member's payment reference, with a copy button.
- Itemizes every entry, with FIFO allocation marking which charges are paid.
- Includes the "I've paid" claim flow and the payment history.

**Admin screen:**
- Pending claims queue (one tap to confirm, creating a linked payment; rejecting needs a reason and notifies the member).
- Balances table with filters for "revocable" and "inactive with balance".
- Record a payment, searching by name or payment reference. Also waivers (reason required), manual charges and pass revocation.
- Everything is audited, and the self-ledger guard applies.

**manager.io export:** a monthly CSV of entries not yet exported, mapped to the account codes in ClubSettings. It stamps `exported_at`, and re-exporting the same period is flagged. **The treasurer must confirm the exact import format** (S5.6).

---

## 10. Notifications, reminders, polls
- **Channels:**
  - The inbox is the source of truth.
  - Web push uses VAPID, sent from the Worker through a **WebCrypto-based web-push implementation** (Node's `web-push` doesn't run on Workers).
  - iOS requires 16.4+ and the app installed to the home screen. The app must show a notification for every push and re-subscribes on every open. VAPID keys are never rotated casually.
  - Permission is only requested after the member's first RSVP.
  - Admins can see push coverage.
- **Categories** (all mutable, plus a global mute): `rsvp_status`, `event_changes`, `new_events`, `payment_due`, `payment_status`, `polls`, `announcements`, `admin_tasks` (admins only).
- **Delivery policy chain:** mute → quiet hours → frequency cap.
- **Reminder rules:**
  - Payment due: balance ≥ X, at most every N days (default 90).
  - Un-RSVPed event: at publish, and/or H hours before close.
  - Poll closing: 24h before.
  - Each rule has a preview that must equal the actual send.
- **Polls:** admin only; single or multi choice. Optional images per option go to **R2**: resized on the client to ≤ 300 KB, at most 8 per poll, served through the Worker to members only, and purged 6 months after the poll closes. Closing date, visibility settings, and anonymous mode.

---

## 11. Architecture

### 11.1 Topology
```
 <club-domain> (Cloudflare DNS)
   │
 Cloudflare Worker "bolt-club-hq"  (one deployable; never sleeps)
   ├─ static assets: React PWA (Vite build)            ← served directly from the edge
   ├─ /api/v1/*   Hono API  ── Clerk JWT verify (networkless, JWKS cached)
   │                         ── Neon Postgres via Hyperdrive (pooled TCP, real transactions)
   ├─ /e/*, /s/*  OG HTML from KV → SPA
   ├─ /media/*    R2 poll images (member-only)
   └─ scheduled() Cron Triggers: */10 07-23 and hourly overnight (Stockholm, expressed in UTC)
          reads next_due_at from KV first → touches Neon only when work is due
 Clerk (auth, login email)   Neon (Postgres)   R2 (images)   KV (OG cache, scheduler state)
 healthchecks.io (cron dead-man switch)   Sentry free (toucan-js in Worker + browser SDK)
 GitHub Actions: CI (Postgres service), deploy via wrangler, weekly encrypted pg_dump,
                 monthly restore drill + Lighthouse
 ── separate, unchanged ──  roster-generator on Render (FastAPI) ◀── deep link only
```

### 11.2 Why each piece
| Piece | Why |
|---|---|
| Workers + static assets | One origin, so there are no CORS or cookie problems. No cold starts, which means instant WhatsApp previews and no "waking up" screen. Cloudflare recommends this over Pages for new projects. |
| Hono | A small, Workers-native router with good TypeScript support and middleware for auth, idempotency and errors |
| Drizzle | Type-safe SQL with versioned migrations. Works with Postgres through Hyperdrive. |
| Hyperdrive | The money rules need real transactions and row locks. Neon's HTTP driver can't hold a transaction open; Hyperdrive gives pooled TCP. If Hyperdrive isn't on the free plan, fall back to `@neondatabase/serverless` in **WebSocket** mode (S0.2 decides). |
| Clerk | Email code and Google login with no email domain setup. Sessions use a header token (no third-party cookies). Production requires our domain. |
| R2 | Keeps images out of Neon's 0.5 GB limit. Needs a card on file, but the free tier is enough. |
| KV | OG cache and `next_due_at`, so crawlers and idle cron runs never wake Neon |

### 11.3 Free-tier budgets (**verify current limits in S0.5; record in `docs/ops/budgets.md`**)
- **Workers free:** about 100k requests a day and **10 ms of CPU per request**. Waiting on I/O isn't counted.
  - Club workloads are tiny: allocating 16 people takes under 1 ms, and verifying a JWT takes about 1 ms.
  - Push encryption runs in **batches of at most 10 per cron run** or queued job, to stay under the CPU limit.
- **Cron Triggers:** the free plan has a limit on the number of triggers. Use 2.
- **Neon free:** compute-hours cap, 0.5 GB storage, auto-suspend. The KV `next_due_at` check means idle cron runs cost zero Neon compute.
- **Clerk free:** monthly active user cap well above 45. **R2 free:** 10 GB. **KV free:** read and write limits far above our needs.

### 11.4 Repo structure (`bolt-club-hq`, a single package)
```
src/worker/          index.ts (fetch + scheduled), app.ts (Hono), middleware/
src/worker/core/     db (drizzle), clock, audit, permissions, idempotency, events (outbox),
                     cron registry, interfaces + fakes, ratelimit-free (Clerk handles auth abuse)
src/worker/<area>/   routes.ts, service.ts, *.test.ts       (auto-registered)
src/domain/          pure TS: allocation, proration, ledger FIFO, recurrence, reminders eligibility
src/app/             React PWA: routes/<area>/ (import.meta.glob registry), components/ui, api/<area>.ts
src/sw/              service worker (injectManifest), push handler in own file
db/schema/*.ts       one file per area, but ONE initial migration in db/migrations
docs/                plan, stories, areas/<area>.md, ops/
tests/e2e/           Playwright (desktop, iPhone, Android)
```
Tooling: TypeScript strict, Vite with `@cloudflare/vite-plugin`, Vitest with `@cloudflare/vitest-pool-workers` for Worker tests, Vitest + jsdom for the UI, fast-check, Playwright, ESLint and Prettier, npm.

### 11.5 Cross-cutting rules
- **Clock:** an injectable `Clock`. Store `timestamptz`; do all Stockholm-time math through the Clock. Compute `rsvp_close_at` as absolute minutes before start and store it in UTC.
- **Money:** integer kronor only.
- **Auth:**
  - Every request carries `Authorization: Bearer <Clerk session JWT>`, verified without a network call.
  - The Clerk user ID maps to the Member row; the first call creates a pending member.
  - No auth cookies, so CSRF isn't a risk. Origins are still checked on state-changing requests.
- **Idempotency:** HTTP `Idempotency-Key` on all money and RSVP POSTs.
- **Permissions:** every route declares a guard, enforced by a test.
- **Feature flags:** per-area flags (env vars) exposed at `/api/v1/config`.
- **Client version:** clients send `X-Client-Version`; an outdated client gets HTTP 426, which shows a refresh banner.

### 11.6 API surface (`/api/v1`)
```
Auth      GET /me   (Clerk handles sign-in/out client-side)
Members   GET/PATCH /members  PATCH /members/{id}/role|status  POST /join-requests
          POST /join-requests/{id}/approve|reject  POST/DELETE /invites
Privacy   GET /me/export  POST /admin/members/{id}/erase
Settings  GET/PUT /admin/settings  GET /config
Terms     CRUD /terms  POST /terms/{id}/clone  CRUD /series  PUT /series/{id}/captains
          POST /series/{id}/generate-events
Events    GET /events  POST /events  GET/PATCH/DELETE /events/{id}  GET /events/by-slug/{slug}
          GET /series/by-slug/{slug}/next  GET /events/{id}/roster-link
RSVP      PUT/DELETE /events/{id}/rsvp  POST /events/{id}/claim  PUT /events/{id}/attendance
Passes    GET /passes/offers  POST /passes  POST /admin/passes  POST /admin/passes/{id}/revoke
Ledger    GET /me/ledger  POST /me/payment-claims  GET /admin/balances  GET /admin/payment-claims
          POST /admin/payment-claims/{id}/confirm|reject  POST /admin/payments
          POST /admin/adjustments  GET /admin/accounting-export.csv
Notify    GET /notifications  POST /notifications/read  PUT /me/notification-prefs
          POST/DELETE /push/subscriptions  GET /admin/push-coverage
Reminders CRUD /admin/reminder-rules  POST …/{id}/preview  POST /admin/broadcasts
Polls     CRUD /polls  PUT /polls/{id}/vote  POST /media (upload)  GET /media/{key}
Audit     GET /admin/audit
Ops       GET /healthz
Edge      /e/{slug}  /s/{slug}
```

---

## 12. Screens
- **Navigation:** bottom nav with Home · Events · Money · Inbox · More. Every screen has an explicit back control, because the installed iOS app has no browser back button.
- **Home:** next RSVPs, balance chip, pass status, open polls, unanswered events, install/push card.
- **Events:** list with filters; "New session" (free for members, free or paid for admins).
- **Event detail:** has slots for the RSVP panel, share, organizer tools (edit, attendance, **Open in roster generator**, Copy list) and the attendee list.
- **Money:** balance, "I've paid", bank details and reference, itemized entries, passes and pass purchase.
- **Inbox:** notifications and polls.
- **More:** profile (including roster name), notification settings, attendance history, privacy, install guide, Admin.
- **Admin:** Members (requests, approvals, roles, invites), Terms & Series, Money (claims, balances, revocations, export), Reminders, Broadcast, Polls, Settings (including roster app URL), Audit, System health.

Accessibility target is WCAG 2.1 AA, checked with axe. English only in v1, with UI text kept in per-area copy files so it can be translated later.

---

## 13. Testing strategy
- **Pure domain code** (`src/domain`): Vitest plus fast-check property tests for allocation, proration, FIFO and credit, refills, recurrence across DST, and reminder eligibility.
- **Worker and API tests:** Vitest with `vitest-pool-workers`, against a **real Postgres** (a service container in CI, Docker locally). Concurrency races (cap, close, claim) run against Postgres. Time travel uses the injected Clock, and the permission matrix is table-driven.
- **Scenario tests:** whole club weeks with the ledger asserted line by line.
- **Playwright** on desktop, iPhone and Android:
  - link → Clerk test-mode login → RSVP
  - "I've paid" claim → admin confirm
  - polls
  - PWA checks: offline shell, cache cleared on logout, fallback exclusions
  - push with a mocked sender
  - axe accessibility checks
  - no permission prompt on first load
  - roster deep link: the generated URL decodes to the contract
- **Contract test shared with the roster repo:** both repos test against the same golden `roster-import/v1` fixture files.
- **Real devices:** the S0.6 spike, plus a launch checklist.
- **Scheduled:** a monthly restore drill and a Lighthouse audit.
- **Story protocol:** failing tests first, then code, then the PR.

---

## 14. Rollout
1. Buy the domain, set up Cloudflare, Clerk production and Neon, then run the S0.6 device spike.
2. **Alpha (admins):** settings, term, series and captains; import members with opening balances; test the manager.io export with the treasurer.
3. **Beta:** the Thursday XD series only, reconciled against manager.io in parallel. Use the roster deep link at real sessions.
4. **Club-wide launch** at the start of a term.
5. **Metrics:** RSVP-via-link rate, push coverage, claim-to-confirm time, admin time, disputes.

---

## 15. Risks
| Risk | Mitigation |
|---|---|
| iOS push only works once the app is installed | The inbox is the source of truth; install guide; push coverage shown to admins |
| Clerk Google sign-in inside the installed iOS app | Lead with email code; the S0.6 spike decides |
| Worker hits the 10 ms CPU limit | Domain logic is tiny; push sent in batches; profiled in S0.6 and S6.2 |
| Hyperdrive not available on the free plan | Neon WebSocket driver, which still supports transactions (S0.2 decides) |
| Neon compute or storage limits | KV `next_due_at`; images in R2; usage shown on the admin health screen |
| Cron runs missed | Close-on-read; healthchecks.io dead-man switch |
| Money disputes | Append-only ledger, idempotency, claims, audit, Postgres-backed tests, backups and restore drill |
| Vendor lock-in to Clerk | Roles and membership live in our database; only `clerk_user_id` ties us to Clerk |
| Roster link format drifts between repos | Versioned schema, golden fixtures tested in both repos |
| Agents conflicting with each other | Contracts first, one initial migration, registries, a CI check that each PR stays within the files it owns |
| GDPR vs bookkeeping | Pseudonymize names, keep amounts for 7 years, delete the Clerk user on erasure |

## 16. Privacy & retention
- **Export:** `/me/export` returns the member's data as JSON.
- **Erasure:**
  - The member row becomes "Former member #id", and the Clerk user is deleted via the Clerk API.
  - Push subscriptions are deleted, guest names become "Guest", and audit JSON is pseudonymized.
  - Ledger amounts are kept for 7 years.
- **Retention:** send log 1 year, poll images 6 months after close, backups 90 days. A privacy notice is linked at sign-in.

## 17. Out of scope
- **Roster generation** (the separate app; only the deep link is in scope)
- Bank CSV import, Swish or card payments
- Email or WhatsApp notification channels; realtime updates
- Multi-club support, hall booking
- Member-created polls, polls that turn into charges or orders
- Direct spot transfers, compensation for cancelled nights
