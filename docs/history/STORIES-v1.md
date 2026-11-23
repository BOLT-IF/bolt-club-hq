# Badminton Club App: Epics, Stories & Build Order (v1)

Companion to `PLAN-v1.md`. Section references (§) point there.

## How to read this (the dynamic-programming framing)

Each story is a **subproblem** with:
- **Depends on:** the subproblems whose solutions it reuses. It must not start until they are merged.
- **Owns:** the folders it may edit. Two stories in the same wave never own the same folder, so parallel agents don't conflict.
- **Contract:** the interface it exposes to later stories (taken from PLAN §5 and §11.4).
- **Tests first:** acceptance tests are written and failing before code, then code turns them green, then a PR opens.

The **waves** are a topological order of the dependency graph. Every story in a wave can run in parallel on its own agent. When every story is merged, the full app exists. This is the DP base case → final answer.

Sizing: **S** ≤ 0.5 day agent effort, **M** ≈ 1 day, **L** ≈ 2 days (L stories are already split as far as is useful).

Story definition of done (applies to all): tests written first; backend `pytest` and the affected Playwright projects are green; Alembic migration reversible; permission guard on every new endpoint; docs updated (`AI_CONTEXT.md`, `DATABASE_MODEL.md`); PR stacked on its dependencies.

---

## Dependency graph

```
W0  S0.1 split app.py ─┬─ S0.2 Alembic+core ─┬─ S0.3 PWA shell ── S0.4 CI/backup/hosting
                       │                     │
W1  ───────────────────┴─ E1 Auth: S1.1 login ─ S1.2 sessions/me ─ S1.3 invites/approve
                                     │
W2   S2.1 members+roles   S3.1 terms/series   S5.1 ledger core   S6.1 notif core   S4.1 allocation(pure)
         │                    │                   │                   │                  │
W3   S2.2 player link     S3.2 event gen      S5.2 member money   S6.2 web push      S3.3 one-off events
                          ─────────────── S4.2 RSVP API (needs 3.2/3.3, 4.1, 2.1) ───────
W4   S4.3 close processing (4.2, 5.1, 6.1)    S5.3 passes+proration (3.1, 5.1)   S6.3 prefs/mute
W5   S4.4 cancel/waitlist/refill   S7.1 share links+OG   S5.4 admin payments   S6.4 scheduler tick
W6   S8.1 roster seeding   S8.2 attendance   S6.5 reminder rules   S9.1 polls   S6.6 broadcasts
W7   S10.1 home/dashboard   S10.2 install+push UX   S9.2 poll images   S8.3 attendance history
W8   S11.1 end-to-end club scenarios   S11.2 migration/import   S11.3 device QA + launch checklist
```

---

## Epic E0: Foundations (Wave 0)

### S0.1 Modularize backend without behavior change: M
- **Depends on:** none · **Owns:** `backend/`
- Split `app.py` into `roster/` routers (planner, sessions, scoring, stats, players, deploy-info) and `core/` (db, cache, env). Create empty `club/` package.
- **Tests first:** the existing full backend suite and Playwright pass unchanged (this is the regression proof). Add a test that every route registered before the split is still registered with the same method and path.
- **Contract:** router registration pattern `club/<area>/router.py` with `include_router` in `app.py`.

### S0.2 Migrations, clock, audit, permissions core: M
- **Depends on:** S0.1 · **Owns:** `backend/core/`, `backend/migrations/`
- Alembic baseline matching the current schema (including lazy-migrated tables). `Clock` service with test override. `AuditLog` table + `audit(actor, action, entity, before, after)`. `require_member`, `require_admin`, `require_owner_or_admin` dependencies (stubbed identity until E1). Idempotency helper (`unique key → skip`).
- **Tests first:** migration up/down on an empty DB and on a DB snapshot of the current schema; clock override affects `now()`; idempotency helper inserts once under concurrent calls; route-guard lint test (every `/api/v1` route declares a guard).

### S0.3 PWA shell and club app navigation: M
- **Depends on:** S0.1 · **Owns:** `frontend/vite.config.*`, `frontend/public/`, `frontend/src/components/AppShell*`, `frontend/src/sw/`
- `vite-plugin-pwa`: manifest (name, icons 192/512/maskable, `display: standalone`, theme), service worker with app-shell precache and network-first API caching for GET. Apple meta tags and touch icon. New bottom nav (Home · Events · Money · Inbox · More), with existing roster areas moved under More → Roster. Offline/"waking up" banner.
- **Tests first:** Playwright checks that the manifest is valid and served, the SW registers, the shell renders offline after first load, all existing roster routes still reachable, and the bottom nav works on iPhone/Android projects.

### S0.4 Hosting, CI, backups: S
- **Depends on:** S0.2 · **Owns:** `.github/workflows/`, `docs/ops/`
- Neon Postgres migration runbook; Alembic `upgrade` on deploy; weekly encrypted `pg_dump` workflow; restore-drill doc; env var inventory (VAPID, RESEND, TICK_SECRET, BOOTSTRAP_ADMIN_EMAIL, GOOGLE_CLIENT_ID).
- **Tests first:** CI job that restores the latest dump into an ephemeral Postgres and runs migrations (restore drill as code).

---

## Epic E1: Authentication (Wave 1)

### S1.1 Login: Google + email magic link/code: M
- **Depends on:** S0.2 · **Owns:** `backend/club/auth/`, `frontend/src/routes/club/auth/`
- `Member`, `LoginChallenge`, `AuthSession` tables. Google ID token verification. Email start → send link + 6-digit code (Resend adapter + console adapter for dev/test). Verify via link or code. HttpOnly, Secure, SameSite=Lax session cookie, 90-day rolling.
- **Tests first:** valid/expired/reused link; wrong code 5× locks the challenge; code works when the link was opened elsewhere (iOS PWA case); Google token with wrong audience rejected; rate limit on `/email/start` per email and IP; no user enumeration (same response for unknown email).

### S1.2 Session, `/me`, logout, identity in guards: S
- **Depends on:** S1.1 · **Owns:** `backend/club/auth/`, `frontend/src/hooks/club/useMe.js`
- Wire real identity into the S0.2 guards. `GET /me`, logout (one device / all devices). Frontend `useMe` + route guard with return-to (preserves pending RSVP intent).
- **Tests first:** unauthenticated → 401; return-to survives the login round-trip; logout-all invalidates other sessions; session expiry rolls on activity.

### S1.3 Invites and approval: S
- **Depends on:** S1.2 · **Owns:** `backend/club/members/invites*`, `frontend/src/routes/club/join/`
- Invite link (expiry, max uses). A new sign-in via invite → `pending`; pending users see a "waiting for approval" screen; admin approves or rejects. Bootstrap admin from env.
- **Tests first:** pending user cannot RSVP or see the ledger; expired invite rejected; bootstrap admin created once; approval notification enqueued (stubbed until S6.1, via an interface).

---

## Epic E2: Members & roles (Waves 2–3)

### S2.1 Member directory, roles, profile: S
- **Depends on:** S1.3 · **Owns:** `backend/club/members/`, `frontend/src/routes/club/members/`
- Admin member list, promote/demote (last-admin protection), deactivate. Member edits display name. `payment_ref` generated once and unique.
- **Tests first:** permission matrix (PLAN §4) as a table-driven test; last admin cannot be demoted; payment_ref uniqueness under concurrency; all role changes audited.

### S2.2 Link members to roster players: S
- **Depends on:** S2.1 · **Owns:** `backend/club/members/player_link*`, `backend/roster/players*` (additive only)
- `Member.player_id`; auto-match by name; admin resolution screen for leftovers; `players.is_guest` flag, with guest players hidden from the directory by default.
- **Tests first:** existing player stats unchanged after linking; guest players hidden in the planner directory unless toggled; a member can't be linked to two players.

---

## Epic E3: Terms, series, events (Waves 2–3)

### S3.1 Terms and series admin: M
- **Depends on:** S1.2 · **Owns:** `backend/club/terms/`, `frontend/src/routes/club/admin/terms/`
- CRUD term and series (PLAN §5.1 fields). Term status machine (draft → open_for_passes → active → closed). Derived `pass_cap` (A8).
- **Tests first:** invalid transitions rejected; series fields validated (fee ≥ 0, capacity ≥ 2, close offset ≥ 0); pass_cap recalculates when an event capacity changes.

### S3.2 Generate series events (recurrence): M
- **Depends on:** S3.1 · **Owns:** `backend/club/terms/recurrence*`, `backend/club/events/`
- Generate weekly events from term start to end (Europe/Stockholm, DST-safe); skip-dates (holidays); edit a single occurrence (time, location, capacity); cancel an occurrence (charges reversal hook = interface, implemented in S4.4). Unique `share_slug`.
- **Tests first:** property test that every generated event falls on the right weekday at the right local time across both DST shifts; regenerate is idempotent; edited occurrences survive regeneration.

### S3.3 One-off member sessions + events list API/UI: M
- **Depends on:** S3.2 (shared `events/` model) · **Owns:** `backend/club/events/oneoff*`, `frontend/src/routes/club/events/`
- Any member creates an event (title, time, location, capacity, guest limit, close offset); `adhoc_fee` forced to 0. Events list (week grouping, filters), event detail page shell.
- **Tests first:** non-creator cannot edit; fee cannot be set on one-off; list filters; past events are read-only.

---

## Epic E4: RSVP & allocation (Waves 2–5). The critical path.

### S4.1 Allocation engine (pure): M
- **Depends on:** S0.2 only (pure code, no DB) · **Owns:** `backend/club/allocation/`
- `allocate()` per PLAN §6.2, plus `promote_from_waitlist(state, freed_spots, now, auto_cutoff)` per A5/A6.
- **Tests first (Hypothesis property tests):** never over capacity; no guest without a confirmed host; a higher tier never waits while a lower tier is confirmed (at close); deterministic; worked examples table from the interview ("10 prepaid, 9 members, 2 guests, 16 spots").

### S4.2 RSVP API and UI (pre-close): M
- **Depends on:** S4.1, S3.3, S2.1 · **Owns:** `backend/club/rsvp/`, `frontend/src/components/club/RsvpPanel*`
- `PUT/DELETE /events/{id}/rsvp` with guest names; tier computed from passes (interface returning False until S5.3). Status display: prepaid → Confirmed, others → Requested. Guest stepper bounded by the limit. Attendee list by status.
- **Tests first:** one RSVP per member; guest limit enforced; edit guests before close; cancel before close → no ledger entries; pending/inactive members blocked.

### S4.3 Close processing (idempotent) + charges: M
- **Depends on:** S4.2, S5.1, S6.1 · **Owns:** `backend/club/rsvp/close*`
- PLAN §6.3: close-on-read hook plus a callable for the tick. Persist allocation, create ad-hoc and guest charges with idempotency keys, enqueue "You're in" / "Waitlisted #n", publish an `event_closed` domain event (consumed by S8.1).
- **Tests first:** running close twice yields identical state and ledger; concurrent close (two requests) yields one charge set; one-off events create zero ledger entries; prepaid members are never charged; notifications exactly once.

### S4.4 Post-close: late RSVP, cancel, waitlist promotion, refill reversal, event cancel: L
- **Depends on:** S4.3 · **Owns:** `backend/club/rsvp/postclose*`, `frontend/src/components/club/RsvpPanel*` (post-close states)
- Late RSVP → confirmed if space, else waitlist (A5). Late cancel → `late_cancelled`; promotion per tier; refill reverses the earliest unrefilled late-cancel charge (A7). Host cancel cascades to guests. Claim-spot flow inside the cutoff (A6). Event cancellation reverses every linked charge and notifies everyone. Capacity change rules (PLAN §6.6).
- **Tests first:** scenario table from PLAN §6.4 (every row is a test); cascade host → guests; two late cancels, one refill → correct one reversed; capacity raise promotes; cancelling an event zeroes all event charges; claim race: two claimers, one wins.

---

## Epic E5: Passes & money (Waves 2–5)

### S5.1 Ledger core: M
- **Depends on:** S0.2, S2.1 (member FK) · *can start against a member stub if S2.1 slips* · **Owns:** `backend/club/ledger/`
- Append-only `LedgerEntry`; service `charge()`, `reverse()`, `record_payment()`, `adjust()`; `balance(member)`; `itemize(member)` with FIFO paid/unpaid allocation. DB-level guard: no UPDATE/DELETE (trigger or revoked privileges).
- **Tests first:** property test balance = Σ entries; FIFO marks oldest charges paid first, partial payment splits correctly; a reversal of a reversal is rejected; idempotency key prevents duplicates; integer-only money (rejects floats).

### S5.2 Member money screen: S
- **Depends on:** S5.1 · **Owns:** `frontend/src/routes/club/money/`, `backend/club/ledger/me*`
- Balance, bank details (admin-configured) + payment reference with copy button, itemized charges with reason/event/guest name, payment history.
- **Tests first:** Playwright: a member sees exactly their own entries; itemization text includes event date and guest name; another member's ledger returns 403.

### S5.3 Pass purchase, cap, proration, tier upgrade: M
- **Depends on:** S3.2, S5.1, S4.2 (tier interface) · **Owns:** `backend/club/passes/`, `frontend/src/routes/club/money/passes*`
- Offers for open terms, prorated price (PLAN §6.5), cap enforced with a row lock, `pass` charge, upgrade open RSVPs to tier 1, admin grant pass (e.g. comped).
- **Tests first:** proration table (full term, half term, last event, zero remaining → not offered); cap race: 2 buyers for 1 slot → 1 succeeds; purchase upgrades a Requested RSVP to Confirmed display; no refund path exists.

### S5.4 Admin balances, payments, adjustments, export: M
- **Depends on:** S5.1, S2.1 · **Owns:** `frontend/src/routes/club/admin/money/`, `backend/club/ledger/admin*`
- Balances table (sort by owed, oldest unpaid), record payment (search by name or ref), waive charge (reason required), manual charge, CSV export, bank details settings.
- **Tests first:** members can't access; payment recorded → member balance drops and FIFO updates; waiver writes a reversal + audit entry; CSV columns stable (snapshot test).

---

## Epic E6: Notifications & reminders (Waves 2–6)

### S6.1 Notification core + inbox: M
- **Depends on:** S2.1 · **Owns:** `backend/club/notifications/`, `frontend/src/routes/club/inbox/`
- `notify(member, category, title, body, link, idempotency_key)` writes the inbox row and enqueues an `OutboundPush`. Inbox UI, unread badge, mark read.
- **Tests first:** idempotent notify; unread count; deep links open the right event or poll; a member only sees their own notifications.

### S6.2 Web push delivery: M
- **Depends on:** S6.1, S0.3 · **Owns:** `backend/club/notifications/push*`, `frontend/src/sw/push*`
- VAPID keys, subscribe/unsubscribe endpoints, SW `push` and `notificationclick` handlers (focus or open deep link), `pywebpush` sender with 404/410 → delete subscription, quiet hours (A9) via `not_before`.
- **Tests first:** sender with a mocked push service (success, 410 gone, 5xx retry with backoff); quiet hours defer and deliver at 08:00; Playwright: subscription flow on Chromium with granted permission.

### S6.3 Preferences and mute: S
- **Depends on:** S6.1 · **Owns:** `frontend/src/routes/club/settings/notifications*`, `backend/club/notifications/prefs*`
- Per-category toggles + global mute (all categories mutable, per interview). Muted → inbox only, no push.
- **Tests first:** muted category produces an inbox entry but no OutboundPush; global mute overrides; defaults all on.

### S6.4 Scheduler tick: S
- **Depends on:** S4.3, S6.2 · **Owns:** `backend/club/scheduler/`, `docs/ops/cron.md`
- `POST /internal/tick` (secret header): close due events, run reminder evaluation (hook, filled by S6.5), drain the push queue, auto-close polls (hook for S9.1). Bounded runtime, safe under overlap (advisory lock).
- **Tests first:** wrong secret → 403; overlapping ticks → second is a no-op; a missed tick followed by a later one processes everything once.

### S6.5 Reminder rules engine + admin UI: M
- **Depends on:** S6.4, S6.3, S5.1, S4.2 · **Owns:** `backend/club/reminders/`, `frontend/src/routes/club/admin/reminders/`
- Rules: payment due (threshold, interval), un-RSVPed event (before-close hours, at publish), poll closing (registered when S9.1 lands). Per-member per-category min interval via SendLog. Preview "would notify N now". Templates with placeholders.
- **Tests first:** time-travel: a quarterly payment rule fires once per 90 days; a member who pays below threshold stops getting reminders; un-RSVPed reminder skips members who RSVPed or cancelled; muted members skipped for push but inbox written; preview count equals actual send count.

### S6.6 Admin broadcasts: S
- **Depends on:** S6.1 · **Owns:** `backend/club/reminders/broadcast*`, `frontend/src/routes/club/admin/broadcast/`
- Compose message to everyone, a series' pass holders, or an event's RSVPs; optional link.
- **Tests first:** audience resolution per target; announcements category respects mute; audited.

---

## Epic E7: Single-link sharing (Wave 5)

### S7.1 Share links, OG preview, RSVP intent: M
- **Depends on:** S4.2, S1.2 · **Owns:** `backend/club/share/`, `frontend/src/routes/club/share/`
- `/e/{slug}` and `/s/{slug}` backend HTML with OG tags (title, time, location, spots left) that boots the SPA. Share button (Web Share API + copy fallback with a prebuilt WhatsApp text). Logged-out flow keeps the RSVP intent through login and completes it.
- **Tests first:** OG tags present and HTML-escaped (XSS test with a malicious event title); unknown slug → friendly 404; `/s/` resolves to the next open event and skips cancelled ones; Playwright: logged-out user opens link → logs in by code → lands RSVPed in one more tap at most.

---

## Epic E8: Roster integration & attendance (Waves 6–7)

### S8.1 Seed planner from closed event: M
- **Depends on:** S4.3, S2.2 · **Owns:** `backend/club/roster_bridge/`, `frontend/src/routes/club/events/roster*` (+ minimal hook in `usePlannerState`)
- On `event_closed`, create a planner draft with confirmed members and guest players and a default draw config from the series format; "Open roster" button on the event. Attendee changes before start → stale banner (reuses existing detection). Organizer/admin authorization replaces the token check for event-linked sessions.
- **Tests first:** draft contains exactly the confirmed attendees; waitlist promotion updates the draft; a started session is not mutated by later RSVP changes; existing standalone planner flows unchanged (full Playwright regression).

### S8.2 Attendance marking: S
- **Depends on:** S8.1, S4.4 · **Owns:** `backend/club/attendance/`, `frontend/src/routes/club/events/attendance*`
- Default attended from the started roster (or RSVP list); organizer flips no-shows; no charge change (charges already exist, per PLAN §6.4), only recorded.
- **Tests first:** prepaid no-show → 0 change; non-prepaid no-show → charge remains; only organizer/admin can mark; editable for 7 days, then admin only.

### S8.3 Member attendance & "why" history: S
- **Depends on:** S8.2, S5.2 · **Owns:** `frontend/src/routes/club/me/attendance*`
- Per member: attended / no-show / late-cancel per event, with the linked charge for each row ("why do I owe this").
- **Tests first:** every ledger row tied to an event is reachable from attendance history and vice versa.

---

## Epic E9: Polls (Waves 6–7)

### S9.1 Polls (single/multi choice): M
- **Depends on:** S6.1, S6.4 · **Owns:** `backend/club/polls/`, `frontend/src/routes/club/polls/`
- Create, publish (notifies `polls`), vote/change vote until close, auto-close via tick, results visibility modes, anonymous mode, poll-closing reminder registration for S6.5.
- **Tests first:** single choice enforces one option; multi allows many; voting after close rejected; anonymous polls never expose voter names via any endpoint; visibility modes enforced.

### S9.2 Image options: S
- **Depends on:** S9.1 · **Owns:** `backend/club/images/`, `frontend/src/components/club/ImagePicker*`
- Client-side resize/compress to ≤ 300 KB, `POST /images` storing bytes in Postgres, served with cache headers; options show images in a grid with tap-to-zoom.
- **Tests first:** oversized/non-image upload rejected server-side (type sniffing, not extension); member-only access; Playwright vote on an image poll on mobile.

---

## Epic E10: Experience polish (Wave 7)

### S10.1 Home dashboard: S
- **Depends on:** S4.4, S5.2, S9.1 · **Owns:** `frontend/src/routes/club/home/`
- Next RSVPs with status, balance chip, pass status, open polls, unanswered events.
- **Tests first:** Playwright snapshot of states (new member, prepaid member, member owing money).

### S10.2 Install and push onboarding: S
- **Depends on:** S6.2, S0.3 · **Owns:** `frontend/src/components/club/InstallPrompt*`
- Android: `beforeinstallprompt` button. iOS: detect Safari, non-standalone → step-by-step "Share → Add to Home Screen" card. Ask for push permission only after the first RSVP; never re-ask after a decline (show a settings hint instead).
- **Tests first:** UA-matrix unit tests for which prompt shows; no permission request on first load (Playwright asserts no `Notification.requestPermission` call).

---

## Epic E11: Launch (Wave 8)

### S11.1 End-to-end club scenarios: M
- **Depends on:** all functional stories · **Owns:** `backend/tests/scenarios/`, `frontend/e2e/club/`
- Executable "club week" scenarios: term setup → passes → 3 series events + 1 one-off → RSVPs/guests → close → late cancels/refills → attendance → payments → reminders → poll. Final ledger asserted line by line.
- **Tests first:** this story *is* the tests. Any failure becomes a bug story for the owning epic.

### S11.2 Data migration and import: S
- **Depends on:** S2.2, S5.4 · **Owns:** `backend/club/importer/`
- CSV import of members (name, email, opening balance as a `manual` ledger entry with a note).
- **Tests first:** opening balances import exactly; re-import is idempotent; malformed rows reported, not partially applied.

### S11.3 Device QA and launch checklist: S
- **Depends on:** S11.1, S10.2 · **Owns:** `docs/club-app/LAUNCH.md`
- Real-device checklist (iPhone Safari install + push + WhatsApp link + login by code; Android Chrome same), Lighthouse PWA audit, backup restore drill, rollout plan PLAN §14.

---

## Critical path and parallelism

Critical path (longest chain): **S0.1 → S0.2 → S1.1 → S1.2 → S1.3 → S2.1 → S4.2 → S4.3 → S4.4 → S8.1 → S8.2 → S11.1** (about 12 sequential steps). Everything else hangs off it in parallel. Peak parallelism is about 5 agents in Waves 2–6.

| Wave | Stories (parallel) | Agents |
|---|---|---|
| 0 | S0.1 → then S0.2 ∥ S0.3, then S0.4 | 1–2 |
| 1 | S1.1 → S1.2 → S1.3 (+ S4.1 can start here; it is pure) | 2 |
| 2 | S2.1, S3.1, S5.1, S6.1, (S4.1 if not done) | 4–5 |
| 3 | S2.2, S3.2, S5.2, S6.2, then S3.3 | 4–5 |
| 4 | S4.2 → S4.3, S5.3, S6.3, S5.4 | 4 |
| 5 | S4.4, S7.1, S6.4, S6.6 | 4 |
| 6 | S8.1, S6.5, S9.1 | 3 |
| 7 | S8.2, S9.2, S10.1, S10.2, then S8.3 | 4 |
| 8 | S11.1, S11.2, then S11.3 | 2 |

Total: 12 epics (E0–E11), 37 stories.

## Traceability: your requirements → stories

| Requirement | Stories |
|---|---|
| PWA installable on Android + iOS | S0.3, S6.2, S10.2, S11.3 |
| 1. Admin + member roles | S1.1–S1.3, S2.1, S0.2 guards |
| 2. Any member adds session; RSVP; guests | S3.3, S4.2, S4.4 |
| 3. 6-month recurring series, prepay, ad-hoc fee | S3.1, S3.2, S5.3, S4.3 |
| 4. Track owed; bank transfer; admin confirms | S5.1, S5.2, S5.4 |
| 5. Members see attendance and why | S8.2, S8.3, S5.2 |
| 6. Roster generator integration | S2.2, S8.1, S8.2 |
| 7. Single RSVP link for WhatsApp | S7.1 |
| 8. Reminders, mute, admin frequency | S6.3, S6.4, S6.5, S6.6 |
| 9. Polls incl. T-shirt designs | S9.1, S9.2 |
