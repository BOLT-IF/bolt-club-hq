# Badminton Club App: Product & Technical Plan (v2)

Status: Planning only. No code. v2 = v1 + council review (`COUNCIL-REVIEW-v1.md`) + Ashok's council-round decisions. Dropped and superseded content is in `DISCARDED-v2.md`. Companion file: `STORIES-v2.md`.
Date: 2026-11-21. Owner: Ashok Bommisetti.

---

## 1. Vision

One installable app (PWA on Android Chrome and iOS Safari) that runs the club: sessions, RSVPs, term series and passes, money owed, reminders, polls, and the existing roster generator, all on one member identity. A WhatsApp message with one link is enough to get people signed up.

Success criteria (measured at the end of the first term):
- 100% of club sessions are created and RSVPed in the app. WhatsApp only carries the link.
- Admins reconcile all bank transfers in under 10 minutes a week, mostly by confirming member payment claims.
- Zero "why do I owe this" disputes: every charge has a reason and an event attached.
- The treasurer's monthly manager.io import takes under 5 minutes.
- Running cost is the domain only (~100–150 SEK/yr). Everything else is on free tiers.

---

## 2. Decision record (from Ashok)

### Interview (round 1)
| Topic | Decision |
|---|---|
| Login | Passwordless email (magic link + 6-digit code) + Google sign-in |
| Club size | 45 members, 3–4 sessions/week, each a different format |
| Notification channels | Web push + in-app inbox. Email is used for login only. |
| Full sessions | Priority allocation when RSVP closes: **prepaid series members → non-prepaid members → guests**, first-come within each tier. Waitlist promotion follows the same order. |
| Late cancellation | After close: non-prepaid members are charged the ad-hoc fee unless the spot is refilled. Prepaid members: 0. |
| Guests | Max per member is set by the organizer (default 1). The host is charged the event's ad-hoc fee. |
| Member-created one-offs | Free. Money is settled outside the app. |
| Prepay unit | A whole series per 6-month term |
| Refunds | None |
| Mid-term joiners | Pro-rated |
| No-shows | Prepaid: 0. Non-prepaid: ad-hoc fee. |
| RSVP close | Default 24h before start, set by the event creator. Before close, prepaid members see **Confirmed** and non-prepaid see **Requested**. Non-prepaid members are notified when confirmed. |
| Prepaid overflow | Pass sales are capped at series capacity |
| Payments | Bank transfer. Recorded and confirmed by an admin. |
| Roster | Auto-seed the planner at close |
| Reminders | Admin rules with frequency settings, plus manual blasts. Every category can be muted. |
| Polls | Single and multi choice, image options |
| Platform | Free |

### Council round (round 2)
| Topic | Decision |
|---|---|
| "Pay XXX quarterly" | A reminder to **settle the balance**. There is no membership fee and no instalments. |
| Unpaid pass | Priority starts at purchase. An admin can **revoke** a pass still unpaid after N days (default 21). |
| Cancelled series night | **No compensation.** The pass covers "up to N sessions". Skip-dates are locked once pass sales open. |
| Domain | **Buy one.** Cloudflare (free) fronts it. This is the only running cost. |
| Admin paid one-off events | Yes. **Pass holders pay** the event fee too. |
| Member leaves mid-term | The pass seat is **not** resold |
| Series captains | Yes: non-admin organizers per series |
| Waitlist promotion acceptance | Not required. Auto-promotion is final. |
| Member-created polls | No. Admins only. |
| Free member one-offs | **Instant first-come confirmation** (no tiers) |
| Repo | Private (`BOLT-IF/roster-generator`) |
| Bookkeeping | The club has a legal duty. The balance sheet and P&L are kept in **manager.io**, so the app must export to it. |

---

## 3. Assumptions (correct before Wave 2 starts)

| # | Assumption |
|---|---|
| A1 | Currency is SEK in whole kronor. Timezone is Europe/Stockholm. Stored as UTC `timestamptz`. |
| A2 | Closed club. People join via an admin invite link **or** "request to join" from any event/series link. An admin approves every new member. |
| A3 | Approved members can see attendee names. Pending members and anonymous visitors cannot. |
| A4 | Guests need a display name only |
| A5 | After close it is first-come for free spots. A late prepaid RSVP goes to the top of the waitlist but never bumps anyone already confirmed. |
| A6 | Auto-promotion runs until 3h before start (configurable). After that, an open spot is offered to the whole waitlist and the first to claim it gets it. A promoted person who then cancels is a late cancel. |
| A7 | When several late cancellations compete for refills, the earliest canceller is reversed first |
| A8 | The pass cap is the minimum capacity across the term's series events |
| A9 | Push quiet hours run 22:00–08:00. Messages are queued, not dropped. |
| A10 | Existing roster players link to members. Guests become flagged guest players. |
| A11 | Money records are kept **7 years** (Swedish bookkeeping law; confirm with the treasurer). Personal data outside money records is erasable. |
| A12 | One member can be both treasurer and player. An admin cannot record payments or waivers on their own ledger unless they are the sole admin, and then it is flagged in the audit log. |

---

## 4. Roles & permissions

| Capability | Member | Event creator | Series captain | Admin |
|---|---|---|---|---|
| View events, RSVP, bring guests (within limit), claim "I've paid" | ✔ | ✔ | ✔ | ✔ |
| Create free one-off session | ✔ | ✔ | ✔ | ✔ |
| Edit/cancel the event, set close time, guest limit, capacity | | own one-offs | events of own series | all |
| Run roster / mark attendance | | own | own series | all |
| Buy series passes, view own balance and attendance | ✔ | ✔ | ✔ | ✔ |
| Create paid one-off events | | | | ✔ |
| Manage terms, series, pricing, captains, club settings | | | | ✔ |
| Record payments, confirm/reject claims, waive/adjust, revoke unpaid passes, see all balances, accounting export | | | | ✔ (not on own ledger, A12) |
| Approve members, roles, invites | | | | ✔ |
| Reminder rules, broadcasts, polls, audit log | | | | ✔ |

Admin safety rules:
- The last admin cannot be demoted.
- `BOOTSTRAP_ADMIN_EMAIL` can always **re-assert** admin on deploy, so a lost sole admin is recoverable.

This replaces `ADMIN_RECOVERY_TOKEN` and the organizer token, and closes "Real login/roles" in `NEW-FEATURES.md`.

---

## 5. Domain model

### 5.1 Entities (all created by the single v1 baseline migration, S0.5)

```
Member            id, display_name, email (unique), google_sub?, role{member,admin},
                  status{pending,active,inactive,erased}, player_id → players, payment_ref (unique,
                  e.g. "BC-ASHO42"), joined_at, left_at?, created_at
AuthSession       id, member_id, token_hash, created_at, last_seen, expires_at (rolling 90d), user_agent
LoginChallenge    id, email, code_hash, link_token_hash, expires_at (15m), used_at, attempts
RateLimit         key, window_start, count                      (Postgres-backed; survives restarts)
Invite            id, token, created_by, expires_at, max_uses, uses, revoked_at?
JoinRequest       id, member_id, via{invite,event_link,series_link}, source_id?, created_at

ClubSettings      singleton: club_name, bank_name, account/IBAN, bankgiro?, payment_instructions,
                  quiet_hours, pass_unpaid_revoke_days (21), auto_promote_cutoff_min (180),
                  defaults (close offset, guests), accounting account codes (S5.6)

Term              id, name, starts_on, ends_on, status{draft,open_for_passes,active,closed},
                  cloned_from_term_id?
Series            id, term_id, name, format{MD,WD,XD,mixed,open}, level{social,competitive},
                  weekday, start_time, duration_min, location, capacity, pass_price, adhoc_fee,
                  max_guests_default, rsvp_close_offset_min (1440), share_slug (unique),
                  skip_dates[], skip_dates_locked (bool), pass_cap (derived, A8)
SeriesCaptain     series_id, member_id
Event             id, series_id?, kind{series,member_oneoff,admin_oneoff}, created_by, title,
                  starts_at, ends_at, location, capacity, adhoc_fee, max_guests_per_member,
                  rsvp_close_at, allocation_mode{tiered,instant}, status{scheduled,closed,cancelled,
                  completed}, share_slug (unique, ≥ 8 chars random), roster_session_id?,
                  closed_processed_at?, material_change_at?
Pass              id, member_id, series_id, price_charged, events_covered, status{active,revoked},
                  purchased_at, revoked_at?, granted_by?
Rsvp              id, event_id, member_id, status{requested,confirmed,waitlisted,offered,cancelled,
                  late_cancelled}, tier{1,2}, requested_at, confirmed_at?, cancelled_at?,
                  refilled (bool), attendance{unknown,attended,no_show}
Guest             id, rsvp_id, name, status (as Rsvp), tier=3, requested_at, refilled, attendance

LedgerEntry       id, member_id, kind{charge,payment,reversal,adjustment}, amount_sek (signed),
                  reason{pass,adhoc,guest,manual,payment,waiver,revocation,opening_balance},
                  event_id?, pass_id?, guest_id?, payment_claim_id?, reverses_entry_id?, note,
                  created_by, created_at, idempotency_key (unique), exported_at?
PaymentClaim      id, member_id, amount_sek, paid_on, note, status{pending,confirmed,rejected},
                  decided_by?, decided_at?, reject_reason?
IdempotencyRecord key, actor_id, route, response_hash, created_at        (HTTP double-submit)

Notification      id, member_id, category, title, body, link, created_at, read_at, idempotency_key
PushSubscription  id, member_id, endpoint, keys, user_agent, created_at, last_success_at, failures
NotificationPref  member_id, category, muted;  Member.global_mute
ReminderRule      id, category, enabled, params (json), min_interval_days, template, updated_by
NotificationSendLog member_id, category, rule_id?, sent_at
OutboundPush      id, notification_id, status{queued,sent,failed,deferred}, not_before, attempts
SchedulerState    singleton: next_due_at, last_tick_at, last_tick_duration_ms, last_error

Poll / PollOption / PollVote / Image   (as v1; Image has poll_id for purge)
AuditLog          id, actor_id, action, entity, entity_id, before/after (json), at
DomainEventOutbox id, type{event_closed,rsvp_changed,event_changed,…}, payload, created_at,
                  processed_at        (in-process bus with durable outbox)
```

### 5.2 Invariants (each becomes a test)

1. The ledger is append-only. A DB trigger blocks UPDATE and DELETE. The only exception is `exported_at`, set once by the accounting export. Balance = Σ amount.
2. Every ledger write has an idempotency key. Every money-mutating HTTP call carries an `Idempotency-Key` header (§11.3).
3. Confirmed tier-1 members ≤ capacity. Passes with `status=active` per series ≤ `pass_cap`.
4. A guest is confirmed only if their host is confirmed. A host cancel cascades to their guests.
5. One RSVP per member per event. Guests per RSVP ≤ the event's limit.
6. **Member one-offs** have `adhoc_fee = 0` and `allocation_mode=instant`, and never create ledger entries. Admin one-offs may be paid and use `tiered` allocation with no tier 1 (nobody is prepaid for them).
7. An admin cannot create payment, waiver or adjustment entries on their own ledger, except when they are the sole admin (flagged).
8. The erasure (GDPR) path never deletes ledger amounts. It pseudonymizes the people attached to them.

---

## 6. Business rules

### 6.1 RSVP lifecycle

```
                ┌─────────────── before close ───────────────┐ ┌───────────── after close ─────────────┐
 RSVP ─▶ instant (member one-off)? ─▶ CONFIRMED if space else  │ │ space? ─▶ CONFIRMED (+charge if paid)  │
         WAITLISTED, first-come; no money ever               │ │ else ─▶ WAITLISTED (tier order, A5)    │
       tiered: tier 1 (pass for this series) ─▶ CONFIRMED*     │ │ cancel ─▶ LATE_CANCELLED                │
               else ─▶ REQUESTED                              │ │   charge stands unless REFILLED (6.4)  │
 cancel before close ─▶ CANCELLED, no fee                      │ │ promotion: auto until cutoff (A6),     │
                └───────────── close ─▶ allocation (6.2) ─────┘ │   then OFFERED to all → first claim   │
 * guaranteed by pass cap                                       └────────────────────────────────────────┘
```

### 6.2 Allocation engine (pure function)
- Candidates are sorted by `(tier, requested_at, id)`. A guest is eligible only once their host is confirmed. A guest who doesn't fit is waitlisted; the host keeps their spot.
- Waitlist after close (A5): new arrivals are inserted in tier order, behind existing entries of the same tier. A prepaid late RSVP goes ahead of every non-prepaid and guest entry.
- **Worked example (becomes a test):** 16 spots, 10 prepaid, 9 members, 2 guests (hosted by two of the prepaid) at close. Result: 10 prepaid confirmed, then the first 6 members by `requested_at` confirmed. Waitlist: members 7, 8, 9, then guest A, then guest B (by `requested_at`).
- Properties: never over capacity; no orphan guests; a higher tier never waits while a lower tier is confirmed at close; deterministic.

### 6.3 Close processing
Triggered by close-on-read **or** the scheduler tick. Runs in one transaction:
1. `SELECT … FOR UPDATE SKIP LOCKED` on the event, then re-check `closed_processed_at`.
2. Run the allocation and persist it.
3. Charge `adhoc` to confirmed tier-2 members and `guest` to hosts. Paid events only; idempotency keys.
4. Enqueue notifications and write an `event_closed` outbox row. The roster seed (§8) consumes it.

Read paths close at most 5 due events per request; the tick handles the rest. Correctness never depends on the tick.

### 6.4 Charging rules

| Situation | Prepaid | Non-prepaid member | Guest (charged to host) |
|---|---|---|---|
| Confirmed at/after close (paid event) | 0 | event fee | event fee |
| Cancel before close | 0 | 0 | 0 |
| Late cancel, refilled | 0 | reversed | reversed |
| Late cancel, not refilled | 0 | stands | stands |
| No-show | 0 | stands | stands |
| Admin one-off (paid) | n/a: everyone is tier 2/3 and pays | event fee | event fee |
| Member one-off | 0 | 0 | 0 |

Definitions:
- **Refill:** a person is confirmed into a spot freed by a late cancel *while the event was at capacity*. If spots were already free, the charge stands. Refills reverse the earliest unrefilled late cancel first (A7).
- **Spot hand-over:** there is no direct transfer. You late-cancel and the next person is promoted, which counts as a refill.
- **Guest name edits** are free at any time. **Guests added after close** join the waitlist as tier 3.

### 6.5 Passes
- Price = `round_half_up(pass_price × remaining / total)`. `remaining` counts the series' non-cancelled events whose RSVP hasn't closed at purchase time. If remaining = 0, the pass is not offered.
- The purchase screen states the terms: **"Covers up to N sessions; no refunds; nights cancelled by the hall are not compensated."**
- Skip-dates are editable in `draft`. They lock when the term moves to `open_for_passes`. An admin can override with a warning that lists the affected pass holders.
- Priority starts at purchase. **Revocation:** after `pass_unpaid_revoke_days`, if the member's balance still includes the unpaid pass charge (FIFO, §9), the admin sees "revocable". Revoking reverses the pass charge, sets the pass to `revoked`, frees the seat, downgrades open RSVPs to tier 2 (they become Requested), and notifies the member. Revocation is never automatic.
- Mid-term purchase upgrades open RSVPs in that series to tier 1.

### 6.6 Event changes, cancellation, capacity
- **Cancel event:** reverse every linked charge and notify everyone (`event_changes`).
- **Material change** (date, time or location) after close: notify all, and open a **24h free-cancel window**. A cancel in that window reverses the charge with no refill needed.
- **Fees** are immutable on closed events. A change to a series `adhoc_fee` applies only to events not yet closed.
- **Capacity:** lowering it below confirmed tier-1, or making `pass_cap` < active passes sold, is blocked unless an admin overrides. The override waitlists the latest prepaid RSVPs and notifies them. Raising capacity after close promotes from the waitlist.

### 6.7 Member exit
- Becoming `inactive` cancels future RSVPs under the normal rules (late-cancel charges apply).
- The member can still log in to see Money and attendance only. Payment reminders continue while the balance is above 0.
- An active pass is kept but cannot be used, and the **seat is not resold**. There is no refund.
- Admin filter: "inactive with balance".
- Erasure (S2.5) is only allowed once the balance is 0, or by an admin override with a waiver.

### 6.8 One-off events
- **Member one-off:** free, `instant` allocation, first-come with a waitlist and auto-promotion. No charges ever.
- **Admin one-off:** optional fee, `tiered` allocation where everyone is tier 2 or guests are tier 3. Pass holders pay. All charging rules in §6.4 apply.

---

## 7. Single-link RSVP (WhatsApp flow)

1. **Share** on an event uses the Web Share API, or copies a prebuilt text: `🏸 Thu Mixed Doubles 19:00 @ Hall X, 6/16 spots: https://<domain>/e/k3f9xq2m`.
2. **`/e/{slug}` and `/s/{slug}` are rendered by a Cloudflare Worker.** It reads OG data (title, time, location, spots) from **Workers KV**, which the backend writes on every event change. The crawler therefore gets a preview in milliseconds even when Render is asleep. Any KV miss falls back to a generic club preview. The page sets `noindex` and shows no attendee names. Human visitors get the SPA from Cloudflare Pages immediately, plus a "waking up" state while the API boots.
3. Logged-in approved member: one big **RSVP** button and a guest stepper.
4. Not logged in: event basics plus **Email me a code**, and **Continue with Google** (in Safari and Android, see below). The RSVP intent is kept through login and completes automatically.
5. Logged in but not a member (no account, or pending): **Request to join**. This creates a `JoinRequest` that admins see in their inbox. Once approved, the stored RSVP intent completes and the member is notified.
6. `/s/{slug}` always resolves to the series' next open event.

**iOS reality:**
- WhatsApp opens links in Safari, never inside the installed PWA, and the two have separate storage. So every login email has a link **and** a 6-digit code, and the PWA asks for the code.
- Google sign-in inside the installed iOS app is **unproven**. Spike S0.8 decides. Until it is proven, the installed-iOS login screen leads with "Email me a code".
- Magic links open a confirm page. The session is only created on a button POST, so email scanners can't burn the link.

---

## 8. Roster generator integration
- Members get a `player_id`. Guests become `is_guest` players, hidden from the directory by default.
- An `event_closed` event seeds the planner draft with confirmed attendees and a default draw config from the series format.
- `rsvp_changed` events before the roster starts update the draft, and the organizer sees the existing stale-roster banner. Started sessions are never mutated.
- Attendance defaults to "attended" from the started roster, or from the RSVP list if no roster was used. The organizer flips no-shows. Editable by the organizer for 7 days, then admin only.
- Event creator, series captain and admin authorization replace the organizer token for event-linked sessions.

---

## 9. Money: balances, claims, reconciliation, accounting

**Member Money screen:**
- The balance at top: "You owe 450 kr", or "Credit 100 kr".
- "Pending confirmation 450 kr" shown separately when a claim is open.
- Bank details from ClubSettings, plus **your payment reference** with a copy button.
- Itemized charges (reason, event date, guest name), each marked paid or unpaid by FIFO allocation of payments and credits.
- Payment and claim history.

**"I've paid" flow:**
- The member enters the amount (prefilled with the balance), the date and an optional note. This creates a `PaymentClaim` (pending), and admins get an `admin_tasks` notification.
- When an admin confirms, a `payment` ledger entry is created, linked to the claim. A reject needs a reason and the member is notified.
- Admins can also record payments with no claim, for example cash or a transfer without a claim.

**Admin money screen:**
- Pending claims queue (one tap to confirm).
- Balances table: owed, oldest unpaid, last payment, "revocable pass" badge, "inactive with balance" filter.
- Record payment (search by name or ref), waive (reason required), manual charge, revoke pass. All money actions are audited and blocked on the admin's own ledger (A12).

**Accounting export (manager.io):**
- A monthly CSV export of ledger entries not yet exported. Columns: date, reference, description, amount, account code (from ClubSettings: pass income, ad-hoc income, guest income, receivables, bank). It can be imported as manager.io receipts and sales invoices, or as a journal.
- The export marks entries with `exported_at`. Re-export of a period is possible, flagged as a duplicate.
- The exact manager.io import format is confirmed with the treasurer in S5.6.

Out of scope: automatic bank matching. A bank CSV import is in the backlog.

---

## 10. Notifications, reminders, polls

### 10.1 Channels
- **In-app inbox:** the source of truth. Every notification is written here.
- **Web push** via VAPID, through a free sender.
  - Android works in the browser or installed.
  - iOS requires 16.4+ and the app installed to the home screen. iOS rules:
    - every push must show a notification (no silent pushes);
    - the app re-subscribes on every open;
    - VAPID keys are never rotated casually; they are backed up in the secrets inventory.
  - Permission is asked only after the first RSVP.
- Admins see **push coverage** ("31/45 reachable").
- Email is used for login only, through **Resend** with a verified sending domain on the purchased domain.

### 10.2 Categories (each mutable, plus a global mute)
| Category | Examples |
|---|---|
| `rsvp_status` | You're in / waitlisted / promoted / spot offered |
| `event_changes` | Cancelled, moved, time changed (with the free-cancel window) |
| `new_events` | A new event you haven't responded to |
| `payment_due` | "Pay 450 kr, ref BC-ASHO42" (quarterly by default) |
| `payment_status` | Claim confirmed/rejected, pass revoked |
| `polls` | New poll / closing soon |
| `announcements` | Broadcasts |
| `admin_tasks` (admins only) | Join requests, payment claims, revocable passes, unlinked players, attendance not marked 24h after an event, scheduler unhealthy |

Mute means no push, but the inbox is still written. Delivery runs through a **policy chain**: mute → quiet hours → frequency cap. Each policy is its own module.

### 10.3 Reminder rules
- **Payment due:** sent when balance ≥ X kr, at most every N days (default 90).
- **Un-RSVPed event:** sent at publish and/or H hours before close. Pass holders get it for their own series. Other members get it for every event they're eligible for.
- **Poll closing:** 24h before close, to members who haven't voted.

Each rule has a preview ("would notify N now") that must equal the actual send. Every send respects the per-member, per-category minimum interval, quiet hours, and mute.

### 10.4 Polls
- Admin-only creation. Single or multi choice, with an image per option.
- Images are resized client-side to ≤ 300 KB and stored in Postgres. Max 8 per poll; purged 6 months after the poll closes.
- Closing date, results visibility, and an anonymous mode that never exposes voters through any endpoint.

---

## 11. Architecture

### 11.1 Topology (all free except the domain)
```
           <club-domain>  (Cloudflare DNS, free)
                 │
   Cloudflare Pages ── SPA (PWA shell, SW)            ← instant, never sleeps
   Cloudflare Worker ── /api/*, /internal/* → proxy to Render (same origin → first-party cookies)
                    └─ /e/*, /s/*  → OG HTML from Workers KV (fallback generic), then SPA
                 │
   Render free web service (FastAPI)  ── Neon Postgres free (persistent)
        │  writes OG data to KV on event change (Cloudflare API)
   cron-job.org → /internal/tick (secret)   healthchecks.io ← tick success ping
   Resend (login email, domain-verified)    Sentry free (FE + BE errors)
   GitHub Actions: CI (Postgres service), weekly encrypted pg_dump, monthly restore drill + Lighthouse
```
- **Same origin is mandatory.** `onrender.com` is on the Public Suffix List, so split hosts break cookies on iOS. The wildcard CORS goes away.
- **Redis is dropped.** The in-memory cache is enough at 45 members, and Redis would be a second Render service consuming free hours.
- **Budgets:**
  - The tick runs **every 10 minutes from 07:00 to 23:00, hourly otherwise**.
  - Each tick first reads `SchedulerState.next_due_at` (a cheap query, or cached in the Worker) and skips the database work when nothing is due.
  - Target: Render under 600 instance-h/month, and Neon compute within the free allowance (to verify against current Neon limits in S0.4).
- **Fallback if a tick is missed:** close-on-read keeps money and RSVP state correct. Only notification timing slips. healthchecks.io emails the admins.

### 11.2 Code structure (built for parallel agents)
```
backend/
  app.py                (composition only; auto-discovers club/*/router.py)
  roster/               (existing planner/sessions/scoring/stats/players, moved as-is)
  core/                 (db, clock, audit, permissions, idempotency, events bus, tick registry,
                         rate limit, interfaces + fakes)
  club/<area>/          (router.py, service.py, models import from core schema, tests/)
  migrations/           (ONE v1 baseline; later changes via a merge queue, single-head CI check)
frontend/src/
  api/club/<area>.js    (on shared apiFetch)
  routes/club/<area>/routes.jsx   (auto-registered via import.meta.glob)
  components/ui/        (UI kit)   copy/club/<area>.js   sw/ (injectManifest; push in own file)
docs/club-app/areas/<area>.md   (one doc per area)
```

### 11.3 Cross-cutting rules
- An injectable `Clock`. All timestamps are `timestamptz`; the server runs on UTC; Stockholm time is computed only through Clock. `rsvp_close_at` is computed as absolute minutes before start and stored in UTC.
- Money is integer kronor only.
- **CSRF:**
  - State-changing routes require `Content-Type: application/json`, plus a same-origin `Origin` or `Sec-Fetch-Site` header.
  - Logout is POST only.
  - Cookies are `HttpOnly; Secure; SameSite=Lax`.
- **HTTP idempotency:** `Idempotency-Key` is required on payment, claim, adjustment, pass purchase, revoke and RSVP POSTs. The server replays the stored response.
- **Rate limits** are stored in Postgres: login start is limited per email and per IP, there are at most 5 open challenges per email per hour, and a challenge locks after 5 wrong codes.
- Every `/api/v1` route declares a permission guard, and a test asserts this.
- **Feature flags:** `CLUB_ENABLED`, plus one flag per area. Server env vars are mirrored to the frontend through `/api/v1/config`.
- **Client versioning:** the server checks the `X-Client-Version` header and replies 426 "please refresh" when it is below the minimum supported version.

### 11.4 API surface (`/api/v1`). v1 endpoints are kept; additions marked +.
```
Auth      POST /auth/google  POST /auth/email/start  POST /auth/email/verify(code|link-confirm)
          POST /auth/logout(all?)  GET /me
Members   GET/PATCH /members  PATCH /members/{id}/role|status  + POST /join-requests
          + POST /join-requests/{id}/approve|reject  POST/DELETE /invites
+ Privacy GET /me/export  POST /admin/members/{id}/erase
+ Settings GET/PUT /admin/settings   GET /config (public flags, club name)
Terms     CRUD /terms  + POST /terms/{id}/clone  CRUD /series  + PUT /series/{id}/captains
          POST /series/{id}/generate-events
Events    GET /events  POST /events (member one-off | admin one-off)  GET/PATCH/DELETE /events/{id}
          GET /events/by-slug/{slug}  GET /series/by-slug/{slug}/next
RSVP      PUT/DELETE /events/{id}/rsvp  POST /events/{id}/claim  PUT /events/{id}/attendance
Passes    GET /passes/offers  POST /passes  POST /admin/passes  + POST /admin/passes/{id}/revoke
Ledger    GET /me/ledger  + POST /me/payment-claims  GET /admin/balances
          + GET /admin/payment-claims  + POST /admin/payment-claims/{id}/confirm|reject
          POST /admin/payments  POST /admin/adjustments  + GET /admin/accounting-export.csv
Notify    GET /notifications  POST /notifications/read  PUT /me/notification-prefs
          POST/DELETE /push/subscriptions  + GET /admin/push-coverage
Reminders CRUD /admin/reminder-rules  POST …/{id}/preview  POST /admin/broadcasts
Polls     CRUD /polls  PUT /polls/{id}/vote  POST /images  GET /images/{id}
+ Audit   GET /admin/audit
Ops       GET /healthz (db, last_tick_at, queue depth)  POST /internal/tick
Edge      /e/{slug}  /s/{slug}  (Worker)
```

---

## 12. Screens
- Bottom nav: **Home · Events · Money · Inbox · More**. Explicit back navigation on every screen, because iOS standalone mode has no back button.
- **Home:** next RSVPs, balance chip (owed, credit or pending), pass status, open polls, unanswered events, install/push card.
- **Events:** list and filters. "New session" button (members create free one-offs; admins choose free or paid).
- **Event detail:** owned by S3.0, with slots for the RSVP panel, share, organizer tools (edit, roster, attendance) and captain tools.
- **Money:** balance, "I've paid", bank details and reference, items, passes, buy pass with terms.
- **Inbox:** notifications and polls.
- **More:** profile, notification settings, attendance history, privacy (export, delete request), install guide, Roster (existing planner, sessions, history, stats, players), Admin.
- **Admin:**
  - Members: join requests, approvals, roles, invites, player links.
  - Terms & Series: clone, captains, skip-dates.
  - Money: claims, balances, payments, revocations, accounting export.
  - Reminders, Broadcast, Polls, Settings, Audit log, System health (last tick, push coverage).

Accessibility: WCAG 2.1 AA target, with an axe check in Playwright. The app is English only in v1, with copy kept in per-area files so translation is possible later.

---

## 13. Testing strategy
- **Pure core:** unit and Hypothesis property tests for allocation, proration (round-half-up), FIFO and credit, reminder eligibility, recurrence across DST, and the refill rules.
- **Club API tests run on Postgres** (a service container in CI) because of row locks, advisory locks, the append-only trigger and the concurrency races. Existing roster tests stay on SQLite unittest. pytest runs both.
- **Time travel** through Clock. Permission-matrix table tests cover the four roles.
- **Scenario tests** read like club weeks, with ledger assertions line by line.
- **Playwright** (`frontend/tests/`) runs on desktop, iPhone and Android:
  - the link → login (code) → RSVP flow;
  - claim → admin confirm;
  - poll vote;
  - PWA manifest and service worker: offline shell, cache cleared on logout, `navigateFallback` exclusions;
  - push with a mocked sender;
  - an axe accessibility check;
  - a test asserting there is no permission prompt on first load.
- **Real-device checks:**
  - Spike S0.8 before auth is built.
  - A checklist per release: iPhone install, push, WhatsApp link, login by code, and Google sign-in in Safari; Android equivalents.
- **Scheduled CI:** a monthly restore drill and Lighthouse PWA audit.
- Story protocol: write failing tests first, then code, then the PR.

---

## 14. Rollout
1. **Pre-alpha:** buy the domain and set up Cloudflare. Run the S0.8 spike on real devices. Cut over to Neon with a frozen-write window (S0.4).
2. **Alpha (admins):** settings, the term and series, captains, member import with opening balances, and manager.io export tested with the treasurer.
3. **Beta (Thursday XD only):** real charges, reconciled against manager.io in parallel.
4. **Club-wide launch** at a term start.
5. **Metrics:** RSVP-via-link rate, push coverage, claim-to-confirm time, admin reconcile time, disputes.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| iOS push needs install | Inbox is the source of truth, plus the install guide and push-coverage view |
| Cross-site cookies on iOS | Same origin through the Cloudflare Worker (mandatory), proven by S0.8 |
| WhatsApp crawler vs cold start | Edge OG from KV, independent of Render |
| Render cold start for humans | SPA served by Pages, "waking up" UI, daytime tick keeps it warm |
| Free-tier budget exhaustion (Render hours, Neon compute) | Adaptive tick, `next_due_at` short-circuit, Redis dropped, monthly usage check in the admin health screen |
| Missed ticks | Close-on-read, healthchecks.io dead-man's switch |
| Money loss or disputes | Append-only ledger, idempotency at the DB and HTTP layers, claims, audit log, Postgres-backed tests, weekly encrypted backups (private repo, key in secrets), monthly restore drill |
| Prod schema drift (lazy migrations) | Baseline from the prod dump plus `alembic stamp`; remove `_ensure_table_columns` |
| Unpaid passes hogging priority | Admin revocation after N days |
| Email deliverability | Resend with domain SPF/DKIM; Google sign-in as an alternative |
| Magic link burned by scanners | Confirm-page POST |
| Parallel agent conflicts | Contracts-first waves, single baseline migration, registries, Owns-path CI check |
| GDPR vs bookkeeping | Pseudonymize people, keep amounts 7 years, documented retention |

---

## 16. Privacy & retention
- **Data:** name, email, Google subject ID, guest names, push endpoints, RSVPs and attendance, ledger, poll votes, audit log.
- **Member export** (`/me/export`) is JSON.
- **Erasure:** the member row becomes "Former member #id". Email, Google ID and push subscriptions are deleted. The member's guest names become "Guest". Personal fields in audit JSON are pseudonymized. Ledger amounts and dates are kept for 7 years (A11).
- **Retention:** login challenges 24h, sessions until expiry, send log 1 year, closed-poll images 6 months, backups 90 days (documented in the privacy notice).
- A privacy notice is linked at login.

---

## 17. Out of scope (backlog)
Bank CSV import and auto-matching · polls that convert to drafts or charges · Swish/card payments · email/WhatsApp notification channels · realtime updates · multi-club · hall booking · member-created polls · direct spot transfers · compensation for cancelled nights.
