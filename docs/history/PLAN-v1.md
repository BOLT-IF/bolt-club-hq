# Badminton Club App: Product & Technical Plan (v1)

Status: Planning only. No code. Companion file: `STORIES-v1.md` (epics, stories, dependency graph, build waves).
Date: 2026-11-21. Owner: Ashok Bommisetti.

---

## 1. Vision

One installable app (PWA on Android Chrome and iOS Safari) that runs the club: sessions, RSVPs, term series and passes, money owed, reminders, polls, and the existing roster generator, all on one member identity. A WhatsApp message with one link is enough to get people signed up.

Success criteria (measurable at end of first term):
- 100% of club sessions are created and RSVPed in the app (WhatsApp is only for the share link).
- Admins reconcile all bank transfers in under 10 minutes a week.
- Zero disputes about "why do I owe this": every charge has a reason and an event attached.
- Running cost is 0 SEK per month.

---

## 2. Interview record (decisions from Ashok)

| Topic | Decision |
|---|---|
| Login | Passwordless email (magic link) + Google sign-in |
| Club size | 45 members, 3-4 sessions/week, each a different format |
| Notification channels | Web push (PWA) + in-app inbox. Email is used only for login. |
| Full sessions | Priority allocation when RSVP closes: **prepaid series members → non-prepaid members → guests**, first-come within each tier. Waitlist promotion uses the same precedence. |
| Late cancellation | After RSVP closes: non-prepaid is charged the ad-hoc fee unless the spot is refilled. Prepaid: 0. |
| Guests | Max guests per member per event set by the organizer (default 1). Host is charged the event's ad-hoc fee per guest. |
| Member-created one-off sessions | Free. The app tracks RSVP + roster only; money is settled outside the app. |
| Prepay unit | Whole series per 6-month term |
| Refunds | None |
| Mid-term joiners | Pro-rated pass price |
| No-shows | Prepaid: 0. Non-prepaid: ad-hoc fee. |
| RSVP close | Default 24h before start, configurable by the event creator. Before close, prepaid members see **Confirmed** and non-prepaid see **Requested**. Non-prepaid get a notification when confirmed. |
| Prepaid overflow | Pass sales are capped at series capacity, so prepaid overflow cannot happen |
| Payments | Bank transfer. Admin records payments by hand (no free automatic matching exists). |
| Roster | Auto-seed the planner with confirmed attendees when RSVP closes |
| Reminders | Admin-configured rules and frequency, plus manual blasts. Members can mute **every** category. |
| Polls | Single and multi-choice, image options |
| Platform | Must stay free |

---

## 3. Assumptions (correct these before Wave 1 starts)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Currency is **SEK**, whole kronor, timezone **Europe/Stockholm** | Money math, DST-safe recurrence |
| A2 | Closed club. People join through an admin-shared **invite link** and are approved by an admin. | Stops random people RSVPing through a public WhatsApp link |
| A3 | All members can see the names on an event's attendee list | Social pressure helps turnout. Privacy cost is low inside a club. |
| A4 | Guests need a display name only (no account) | Roster needs a name. GDPR stays minimal. |
| A5 | **After** RSVP close, it is first-come for free spots. Prepaid members who RSVP late go to the **top** of the waitlist but never bump someone already confirmed. | Your rule covers allocation *at* close. This covers RSVPs after it. |
| A6 | Waitlist auto-promotion runs until 3h before start (configurable). Inside that window an open spot is offered to the whole waitlist and the first to claim it gets it. | Stops charging someone promoted 30 minutes before play who can't come |
| A7 | When several late cancellations compete for one refill, the **earliest** canceller's charge is reversed first | Deterministic and fair |
| A8 | The pass cap per series is the **minimum** capacity across that series' events in the term | Keeps the "Confirmed" promise true every week |
| A9 | Quiet hours for push: 22:00–08:00 Stockholm. Messages are queued, not dropped. | Reminders shouldn't wake people up |
| A10 | Existing roster players are linked to member accounts. Guests become flagged guest players. | Roster stats keep working |

---

## 4. Roles & permissions

| Capability | Member | Event creator (member) | Admin |
|---|---|---|---|
| View events, RSVP, bring guests (within limit) | ✔ | ✔ | ✔ |
| Create one-off (free) session | ✔ | ✔ | ✔ |
| Edit/cancel own one-off session, set close time, guest limit, capacity | | ✔ | ✔ |
| Run roster / mark attendance for an event | | ✔ (own) | ✔ (all) |
| Buy series passes, view own balance/attendance | ✔ | ✔ | ✔ |
| Manage terms, series, pricing, fees | | | ✔ |
| Record payments, waive/adjust charges, see all balances | | | ✔ |
| Approve members, promote/demote admins | | | ✔ |
| Configure reminder rules, send broadcasts, create polls | | | ✔ |

There must always be at least one admin; demoting the last admin is blocked. The first admin is seeded from an env var (`BOOTSTRAP_ADMIN_EMAIL`). This replaces today's `ADMIN_RECOVERY_TOKEN`/organizer token model, which closes the "Real login/roles" item in `NEW-FEATURES.md`.

---

## 5. Domain model

### 5.1 Entities

```
Member            id, display_name, email (unique), google_sub?, role{member,admin},
                  status{pending,active,inactive}, player_id → players, payment_ref (e.g. "BC-ASHO42"),
                  created_at
AuthSession       id, member_id, token_hash, created_at, last_seen, expires_at (rolling 90 days)
LoginChallenge    id, email, code_hash (6-digit), link_token_hash, expires_at (15 min), used_at, attempts
Invite            id, token, created_by, expires_at, max_uses, uses

Term              id, name ("Spring 2027"), starts_on, ends_on, status{draft,open_for_passes,active,closed}
Series            id, term_id, name, format{MD,WD,XD,mixed,open}, level{social,competitive},
                  weekday, start_time, duration_min, location, capacity, pass_price, adhoc_fee,
                  max_guests_default, rsvp_close_offset_min (default 1440), pass_cap (derived, A8)
Event             id, series_id?, created_by, title, starts_at, ends_at, location, capacity,
                  adhoc_fee (0 for one-off), max_guests_per_member, rsvp_close_at,
                  status{scheduled,closed,cancelled,completed}, share_slug (unique),
                  roster_session_id?, closed_processed_at?
Pass              id, member_id, series_id, price_charged, events_covered, purchased_at, granted_by?
Rsvp              id, event_id, member_id, status{requested,confirmed,waitlisted,cancelled,
                  late_cancelled}, tier{1 prepaid, 2 member}, requested_at, confirmed_at?,
                  cancelled_at?, attendance{unknown,attended,no_show}
Guest             id, rsvp_id (host), name, status (same enum as Rsvp), tier=3, requested_at,
                  attendance

LedgerEntry       id, member_id, kind{charge,payment,reversal,adjustment}, amount_sek (signed:
                  + owed, − paid/credited), reason{pass,adhoc,guest,late_cancel,no_show,manual,
                  payment,waiver}, event_id?, pass_id?, guest_id?, reverses_entry_id?,
                  note, created_by, created_at, idempotency_key (unique)

Notification      id, member_id, category, title, body, link, created_at, read_at, idempotency_key
PushSubscription  id, member_id, endpoint, keys, user_agent, created_at, last_success_at, failures
NotificationPref  member_id, category, muted (bool); global_mute on Member
ReminderRule      id, category, enabled, trigger params (json), min_interval_days, template, updated_by
NotificationSendLog member_id, category, rule_id?, sent_at (used by frequency caps)
OutboundPush      id, notification_id, status{queued,sent,failed,deferred}, not_before (quiet hours)

Poll              id, title, description, kind{single,multi}, closes_at, results_visibility
                  {admins,members_after_vote,members_always}, anonymous (bool), created_by, status
PollOption        id, poll_id, label, image_id?, sort
PollVote          poll_id, option_id, member_id (unique per option; single-choice enforced)
Image             id, mime, bytes (≤ 300 KB after client-side resize), created_by

AuditLog          id, actor_id, action, entity, entity_id, before/after (json), at
```

### 5.2 Key invariants (each becomes a test)

1. **The ledger is append-only.** Entries are never updated or deleted. Corrections are `reversal` entries pointing at the original. Balance = Σ amount.
2. Every ledger entry has an `idempotency_key`, e.g. `adhoc:{event}:{member}` or `guest:{guest_id}`. Re-running close processing or a cron tick can never double-charge.
3. Confirmed tier-1 (prepaid) RSVPs ≤ event capacity, always. This is enforced by the pass cap and by capacity-change validation.
4. A guest can only be `confirmed` if their host's RSVP is `confirmed`. If the host cancels, their guests are cancelled too, with the same late-cancel charging rules.
5. One RSVP per member per event. Guests per RSVP ≤ `max_guests_per_member`.
6. Passes per series ≤ `pass_cap`. The check runs inside the purchase transaction with a row lock.
7. One-off events always have `adhoc_fee = 0` and never create ledger entries.

---

## 6. Core business rules

### 6.1 RSVP lifecycle

```
            ┌──────── before close ────────┐   ┌─────────── after close ───────────────┐
 RSVP ──▶ prepaid? ─yes─▶ CONFIRMED (shown) │   │ free spot? ─yes─▶ CONFIRMED (+charge)  │
           │                              │   │     no ──▶ WAITLISTED (tier order)     │
           └─no──▶ REQUESTED              │   │                                        │
 cancel before close ─▶ CANCELLED, no fee │   │ cancel ─▶ LATE_CANCELLED                │
            └──────────────────────────────┘   │   non-prepaid: charge stands unless    │
                       │ close                 │   refilled (reverse, earliest first A7)│
                       ▼                       │   prepaid: 0                           │
             Allocation engine (6.2)           └────────────────────────────────────────┘
```

### 6.2 Allocation engine (pure function, the heart of the app)

`allocate(capacity, rsvps, guests, now) → {confirmed[], waitlisted[]}`

- Candidates are sorted by `(tier, requested_at, id)`: tier 1 = member holding a pass for the event's series, tier 2 = other members, tier 3 = guests.
- Fill spots in that order. A guest is only eligible once its host has been confirmed. If a guest doesn't fit, it is waitlisted. The host is not.
- Waitlist order uses the same key. After close, new RSVPs join the waitlist in tier order (A5).
- Deterministic and side-effect free, with property-based tests: never over capacity; never a guest without a confirmed host; a lower tier never confirmed while a higher-tier person waits; same input always gives the same output.

### 6.3 Close processing (idempotent)

Triggered by **whichever comes first**: (a) any read or write touching the event after `rsvp_close_at` ("close-on-read"), or (b) the scheduler tick. Steps run in one transaction guarded by `closed_processed_at`:
1. Run the allocation engine and persist statuses.
2. For each confirmed tier-2 member: charge `adhoc` = event fee. For each confirmed guest: charge the host `guest` = event fee. (Series events only.)
3. Enqueue notifications: "You're in" for newly confirmed non-prepaid members, "You're waitlisted (#n)" for waitlisted ones.
4. Seed the roster planner draft (Section 8).

**Why close-on-read:** on Render's free tier the server sleeps when idle and an external cron can be late or missed. Correctness therefore never depends on the cron; it only affects how quickly notifications go out.

### 6.4 Charging rules

| Situation | Prepaid (pass holder) | Non-prepaid member | Guest (charged to host) |
|---|---|---|---|
| Confirmed at/after close | 0 | ad-hoc fee | ad-hoc fee |
| Cancel before close | 0 | 0 (nothing charged yet) | 0 |
| Late cancel, spot refilled | 0 | charge reversed | charge reversed |
| Late cancel, not refilled | 0 | charge stands | charge stands |
| No-show | 0 | charge stands | charge stands |
| One-off member session | 0 | 0 | 0 |

The charge is created **when the person is confirmed**, so late-cancel and no-show need no new charge, only a reversal on refill. One code path, fewer bugs.

### 6.5 Passes and proration

- `price = round(pass_price × remaining_events / total_events)`, where `remaining_events` counts the series' scheduled (non-cancelled) events whose RSVP has not yet closed at purchase time.
- Buying a pass creates one `pass` ledger charge. No refunds. Admins can apply a `waiver` adjustment if they decide to make an exception.
- Buying a pass mid-term upgrades the member's open RSVPs in that series to tier 1. Already-closed events are unaffected.
- Admins can open pass sales before the term starts (`open_for_passes`).

### 6.6 Event cancellation and capacity changes

- Cancelling an event reverses every charge linked to it and notifies all RSVPs.
- Lowering capacity below the number of confirmed tier-1 members is blocked unless the admin explicitly overrides. The override waitlists the latest prepaid RSVPs and notifies them.
- Raising capacity after close immediately promotes from the waitlist.

---

## 7. Single-link RSVP (WhatsApp flow)

1. The organizer taps **Share** on an event. The Web Share API (or a copy fallback) shares text like `🏸 Thu Mixed Doubles 19:00 @ Hall X, 6/16 spots: https://<app>/e/k3f9xq`.
2. `/e/{slug}` is served by the **backend** as a small HTML page with Open Graph tags (title, time, spots left). WhatsApp then shows a rich preview, which a client-side SPA can't produce. The page then boots the SPA at the event.
3. Logged-in member: the event page opens with one big **RSVP** button and a guest stepper. One tap and they're done.
4. Not logged in: the page shows event basics with **Continue with Google** or **Email me a code**. After login it returns to the event and completes the RSVP intent, so they don't have to tap again.
5. Series link `/s/{slug}` always resolves to the series' next open event. Admins can pin it in the WhatsApp group description.

**iOS gotcha (designed for, not discovered later):** an installed iOS PWA has separate storage from Safari, and WhatsApp links open in Safari. Therefore:
- Login emails contain **both** a magic link **and** a 6-digit code. Inside the installed PWA, the member types the code.
- Sessions last 90 days (rolling), so each surface only needs one login per device.
- Google sign-in uses the redirect flow, which works in standalone mode.

---

## 8. Roster generator integration

- `Event.roster_session_id` links an event to the existing planner/session model. Each member has `player_id` (backfilled by matching names; unmatched ones are resolved by an admin in a one-time screen). Guests become players flagged `is_guest`, which are excluded from directory lists by default.
- **At close:** create a planner draft for the event, preloaded with confirmed members and guests and with the series format as the default draw config.
- **Before the roster is started:** waitlist promotions and cancellations update the draft's player list, and the organizer sees an "attendees changed" banner. This reuses the existing stale-roster detection.
- **After the session:** attendance defaults to "attended" for everyone in the started roster. The organizer flips no-shows on an attendance screen, which takes about 10 seconds. If no roster was used, attendance is marked from the RSVP list.
- The existing organizer token check is replaced by role checks: the event creator or an admin.

---

## 9. Money: balances and reconciliation

- **Member view:** balance at the top ("You owe 450 kr"), bank details with **your payment reference** to put in the transfer message, then an itemized list ("Guest fee: Ali, Thu XD 12 Mar, 80 kr") with each charge marked paid or unpaid via FIFO allocation of payments. Payment history sits below.
- **Admin view:** a table of all members with balance, oldest unpaid date, and last payment. **Record payment** takes amount, date, and note; matching the reference to a member is one search box. Admins can also waive a charge (reason required) and add a manual charge, and there is a CSV export for the club treasurer.
- Automatic bank matching is out of scope. The free route would be a monthly bank CSV upload matched on payment reference, which is listed as a backlog stretch story.
- Every money action is written to the audit log.

---

## 10. Notifications, reminders, and polls

### 10.1 Channels
- **In-app inbox** (always written; unread badge in the nav).
- **Web push** via VAPID (free). Android Chrome works in browser or installed. **iOS needs 16.4+ and the app installed to the home screen**, so the app shows an iOS-specific "Add to Home Screen to get notifications" guide. Push permission is asked for only after a meaningful action (first RSVP), never on first load.
- Email is used for login codes only (Resend or Brevo free tier; 45 members is far under limits).

### 10.2 Categories (each mutable per member, plus a global mute)
| Category | Examples | Source |
|---|---|---|
| `rsvp_status` | You're in / waitlisted / promoted / spot open to claim | transactional |
| `event_changes` | Event cancelled, time or location changed | transactional |
| `new_events` | New event you haven't RSVPed to | rule |
| `payment_due` | "Pay 450 kr now, ref BC-ASHO42" | rule |
| `polls` | New poll / poll closing soon | on publish + rule |
| `announcements` | Admin broadcast | manual |

Muting turns off push. Inbox entries are still written, so nothing is lost and the member can catch up.

### 10.3 Reminder rules (admin-configured)
- **Payment due:** balance ≥ X kr; send at most every N days (default 90); template with `{amount}`, `{ref}`, `{bank}`.
- **Un-RSVPed event:** for eligible members who haven't responded, send at publish (optional) and/or H hours before close (default 12h). Pass holders are always eligible for their series; others are eligible for all events.
- **Poll closing:** 24h before close, to members who haven't voted.
- A global frequency cap per member per category (`min_interval`) is enforced from `NotificationSendLog`. A preview shows "this rule would notify 12 members now" before enabling.
- Delivery: the scheduler tick evaluates rules and drains the push queue with quiet hours applied. Idempotency keys prevent double sends.

### 10.4 Polls
Single or multi choice, optional image per option (resized client-side to ≤ 300 KB and stored in Postgres, so no paid storage), close date, results visibility (admins / members after voting / always), and an optional anonymous mode. Publishing notifies the `polls` category. Admins see counts plus voter names unless the poll is anonymous. Out of scope for v1: polls that convert into series drafts or charges (backlog).

---

## 11. Architecture

### 11.1 Stack (extends what exists)
- **Backend:** FastAPI + SQLAlchemy, plus **Alembic** for migrations. Today schema changes are lazy; a ledger needs real migrations.
- **Frontend:** React 19 + Vite + react-router, plus `vite-plugin-pwa` (Workbox) for the manifest and service worker.
- **DB:** Postgres on a **persistent free tier (Neon recommended)**. Render's free Postgres expires after about 30 days, which is unacceptable for money data.
- **Push:** `pywebpush` with VAPID keys in env.
- **Login email:** Resend free tier (fallback: Brevo).
- **Scheduler:** **cron-job.org** (free) calls `POST /internal/tick` with a shared secret every 10 minutes. GitHub Actions cron is the fallback, but it is coarse and burns minutes on private repos. Close-on-read keeps the app correct when ticks are missed.
- **Backups:** a weekly GitHub Actions `pg_dump`, encrypted and kept as an artifact (90-day retention). This is required because the database holds money data.
- **Hosting:** stays on Render free. Cold start is about 20–50s, so the PWA shell is served from the service worker cache, shows cached data immediately, and displays a "waking up…" state. The tick also keeps the service warm in the evenings when sessions happen.

### 11.2 Code structure (needed for parallel agents)
`backend/app.py` is about 3,000 lines. Agents editing one file in parallel will conflict constantly, so **story S0.1 splits it first** into routers:
```
backend/
  app.py                  (composition only)
  roster/                 (existing planner, sessions, scoring, stats moved as-is)
  club/
    auth/  members/  terms/  events/  rsvp/  allocation/  passes/
    ledger/  notifications/  reminders/  polls/  share/  scheduler/
  core/  (db, clock, audit, permissions, idempotency)
```
Frontend gets matching `routes/club/*` and `hooks/club/*`, so each epic owns its own folder.

### 11.3 Cross-cutting
- `Clock` abstraction (injectable `now()`) so every time rule can be tested with time travel.
- Permission dependency `require(role|ownership)` on every endpoint, with a test asserting that no endpoint is missing a guard.
- Money is stored as integer kronor. No floats anywhere.
- Every write that can repeat (tick, close, notify, charge) carries an idempotency key.

### 11.4 API surface (contract summary, versioned under `/api/v1`)
```
Auth      POST /auth/google  POST /auth/email/start  POST /auth/email/verify  POST /auth/logout  GET /me
Members   GET/PATCH /members  POST /invites  POST /members/{id}/approve  PATCH /members/{id}/role
Terms     CRUD /terms   CRUD /series   POST /series/{id}/generate-events
Events    GET /events?from&to&series&mine   POST /events (one-off)   GET/PATCH/DELETE /events/{id}
          GET /events/by-slug/{slug}   GET /series/by-slug/{slug}/next
RSVP      PUT /events/{id}/rsvp {guests:[names]}   DELETE /events/{id}/rsvp   POST /events/{id}/claim
Attend    PUT /events/{id}/attendance
Passes    GET /passes/offers   POST /passes   POST /admin/passes (grant)
Ledger    GET /me/ledger   GET /admin/balances   POST /admin/payments   POST /admin/adjustments
          GET /admin/ledger.csv
Notify    GET /notifications   POST /notifications/read   PUT /me/notification-prefs
          POST /push/subscriptions   DELETE /push/subscriptions/{id}
Reminders CRUD /admin/reminder-rules   POST /admin/reminder-rules/{id}/preview   POST /admin/broadcasts
Polls     CRUD /polls   PUT /polls/{id}/vote   POST /images
Share     GET /e/{slug}  GET /s/{slug}   (HTML with OG tags; outside /api)
Internal  POST /internal/tick (secret header)
```

---

## 12. Screens (mobile-first)

Bottom nav: **Home · Events · Money · Inbox · More**.
- **Home:** next RSVPs, balance chip, pass status, open polls, install/push prompt card.
- **Events:** list grouped by week, filters by series and "mine"; FAB "New session".
- **Event detail:** time, place, spots bar, RSVP button + guest stepper, status chip (Confirmed / Requested / Waitlisted #3), attendee list by status, share button. Organizer tools: edit, roster, attendance.
- **Money:** balance, bank details + reference, itemized charges, passes, "Buy series pass".
- **Inbox:** notifications, polls inline.
- **More:** profile, notification settings, attendance history, install guide, admin section.
- **Admin:** Members (approve, roles), Terms & Series, Balances & payments, Reminders, Broadcast, Polls, Audit log.
- The existing **Planner / Sessions / History / Stats / Players** move under "Roster" in More, with direct deep-links from events.

---

## 13. Testing strategy

- **Pure-core unit + property tests** (Hypothesis): allocation engine, proration, ledger balance/FIFO, reminder eligibility, recurrence with DST. These are the money and fairness paths, so they get the deepest coverage.
- **API tests per router**, using time travel through the Clock: close-on-read, idempotent tick, late-cancel/refill sequences, the permission matrix.
- **Scenario tests** that read like club life: "Thursday XD, 16 spots, 10 prepaid, 9 members, 2 guests, 1 late cancel, refill from waitlist → expected ledger".
- **Playwright**: keep the desktop + iPhone + Android projects. Journeys: WhatsApp link → login → RSVP; admin records payment → member balance updates; poll vote; PWA manifest/service-worker checks; push subscription with a mocked push service.
- **Manual device checklist per release:** install on a real iPhone (Safari) and Android (Chrome), receive a push, open a share link from WhatsApp. Push and install can't be fully automated.
- Each story ships tests first (red), then code (green), then a PR. Stacked PRs follow the existing repo convention.

---

## 14. Rollout

1. **Alpha (admins only, 1 week):** set up the term, series, and passes; import members.
2. **Beta (one series, e.g. Thursday XD):** real RSVPs and charges, with ledger reconciliation done side by side with the treasurer's spreadsheet.
3. **Club-wide launch** at the start of a term (passes only make sense at term start).
4. Track weekly: RSVP-via-link rate, push opt-in rate (iOS install friction is the main risk), time admins spend reconciling, disputes.

---

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| iOS push requires installation | Many iPhone users never get reminders | In-app inbox is the source of truth; install guide card; prompt after first RSVP |
| Render free-tier cold start | First open of a WhatsApp link takes 30s+ | Service worker shell, warm-up via tick, OG page served by backend, "waking up" UI |
| Missed cron ticks | Late notifications | Close-on-read makes state correct regardless; notifications are only delayed |
| Free Postgres expiry or loss | Money data lost | Neon persistent tier + weekly encrypted dumps + restore drill |
| Ledger bugs cause disputes | Trust loss | Append-only ledger, idempotency keys, itemized reasons, audit log, scenario tests |
| Parallel agents conflict on `app.py` | Merge hell | S0.1 modularization first; one epic per folder; contracts fixed in this plan |
| Magic link opens in the wrong context on iOS | Users stuck logged out in the PWA | 6-digit code in every login email |
| Scope creep (polls → shop, bank import) | Delays launch | Explicit backlog; v1 freezes at Section 16 |

---

## 16. Out of scope for v1 (backlog)
- Bank CSV import with automatic reference matching
- Polls that convert to series drafts or create charges (T-shirt orders)
- Card/Swish payments
- Email/WhatsApp notification channels
- Realtime (WebSocket) updates
- Multi-club tenancy
- Court booking with the hall
