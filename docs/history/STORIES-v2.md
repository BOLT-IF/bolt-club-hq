# Badminton Club App: Epics, Stories & Build Order (v2)

Companion to `PLAN-v2.md` (§ refers to it). v2 = v1 restructured per the council (`COUNCIL-REVIEW-v1.md`). Superseded v1 items are listed in `DISCARDED-v2.md`.

## The DP framing

- Each story is a **subproblem**. **Depends on** lists the solved subproblems it reuses.
- **Owns** lists the only paths it may edit. A CI check fails PRs that touch files outside those paths, apart from a small shared allow-list.
- **Waves** are a topological order. Every story in a wave depends only on earlier waves, so a wave runs fully in parallel, one agent per story.
- Base case: Waves 0–1 (contracts). Final answer: all 51 stories merged = the full app.

Sizes: **S** ≤ ½ day of agent effort · **M** ≈ 1 day · **L** ≈ 2 days.

### Definition of done (every story)

1. A **failing-tests commit first**, so CI shows the new tests red. Then the code that turns them green.
2. Green on:
   - backend `python -m unittest discover` (existing suite, kept);
   - `pytest backend/club` on **Postgres**;
   - the affected Playwright projects in `frontend/tests/`.
3. No new Alembic revision unless it went through the migration queue. CI checks there is a single head.
4. Every new route has a permission guard (route-guard test). Every money POST requires `Idempotency-Key`.
5. Behind its area feature flag. Nav entries register only when the flag is on.
6. The area doc `docs/club-app/areas/<area>.md` is updated.
7. The PR lists the Owns paths. Single-parent stories stack on their parent; multi-parent stories branch from main once all parents are merged.
8. The story that implements an interface **removes the fake from production wiring**, and a test asserts the fake isn't wired in.

---

## Dependency graph (waves)

```
W0  S0.1 backend split · S0.3 PWA/SW · S0.6 FE foundation · S0.8 same-origin + device spike
W1  S0.2 core contracts+schema · S0.5 CI/Postgres/guards · S0.7 observability · S4.1 allocation (pure)
W2  S1.1a email login · S2.1 members · S2.3 settings · S3.0 events core · S3.1 terms/series
    S5.1 ledger · S6.1 notifications · S6.4 tick · S0.4 hosting/Neon/backups
W3  S1.1b Google · S1.2 session/me · S2.2 player link · S3.2 recurrence · S3.3 one-offs
    S4.2 RSVP pre-close · S5.2 member money · S5.4 admin money · S6.2 push · S6.3 prefs
W4  S1.3 invites/join · S4.3 close · S5.3 passes+revoke · S5.5 claims
    S9.1 polls · S10.2 install UX · S6.5a reminder engine · S6.6 broadcasts · S2.4 audit viewer
W5  S4.4a late/refill · S4.4b claim/capacity · S4.4c cancel/changes · S8.1 roster seed · S7.1 share/edge
    S9.2 images · S6.5b reminder UI · S5.6 accounting export · S2.5 privacy
W6  S8.2 attendance · S10.1 home · S11.2 import
W7  S8.3 attendance history
W8  S11.1 club-week scenarios
W9  S11.3 device QA + launch
```

**Critical path (10 steps):** S0.1 → S0.2 → S3.0 → S4.2 → S4.3 → S8.1 → S8.2 → S8.3 → S11.1 → S11.3.

Login is **off** the critical path. Wave-2+ stories build against the test-identity override from S0.2 (`X-Test-Member`, available in test builds only).

| Wave | Stories | Agents |
|---|---|---|
| 0 | S0.1, S0.3, S0.6, S0.8 | 4 (S0.8 needs a human with an iPhone) |
| 1 | S0.2, S0.5, S0.7, S4.1 | 4 |
| 2 | S1.1a, S2.1, S2.3, S3.0, S3.1, S5.1, S6.1, S6.4, S0.4 | 9 |
| 3 | S1.1b, S1.2, S2.2, S3.2, S3.3, S4.2, S5.2, S5.4, S6.2, S6.3 | 10 |
| 4 | S1.3, S4.3, S5.3, S5.5, S9.1, S10.2, S6.5a, S6.6, S2.4 | 9 |
| 5 | S4.4a, S4.4b, S4.4c, S8.1, S7.1, S9.2, S6.5b, S5.6, S2.5 | 9 |
| 6 | S8.2, S10.1, S11.2 | 3 |
| 7 | S8.3 | 1 |
| 8 | S11.1 | 1 |
| 9 | S11.3 | 1 + human |

---

## E0: Foundations & contracts

### S0.1 Backend split + router auto-discovery: L · W0
- **Depends on:** none · **Owns:** `backend/` (exclusive in W0)
- Move `app.py` (about 3,000 lines) into `roster/` routers and `core/` (db, cache, env) with **no behavior change**. `app.py` keeps composition only and auto-mounts every `club/*/router.py`.
- **Drop Redis:** keep the in-memory cache and remove `redis` from requirements and env.
- Create an empty `club/` package.
- **Tests first:**
  - A route-parity test: the method and path set is identical before and after the split.
  - The full existing unittest suite and Playwright are green.
  - A dummy `club/_probe/router.py` is auto-mounted in test mode.

### S0.3 PWA manifest + service worker: M · W0
- **Depends on:** none · **Owns:** `frontend/vite.config.*`, `frontend/public/`, `frontend/src/sw/`
- `vite-plugin-pwa` in **injectManifest** mode, so later stories can add their own SW files.
- Manifest: icons 192/512/maskable, `standalone`, theme. Apple meta tags and touch icon.
- Precache the app shell.
- API caching:
  - Network-first on an **allowlist** of GETs, with `networkTimeoutSeconds: 3`. On timeout, show cached data with a "stale" badge.
  - **Clear Cache Storage on logout** (exported hook).
  - `navigateFallback` must exclude `/api`, `/internal`, `/e`, `/s` and `/auth`.
- Updates: prompt-to-reload. No silent `skipWaiting`.
- **Tests first (Playwright):**
  - The manifest is valid.
  - The SW registers.
  - Go offline in the browser context, reload, and `[data-testid=app-shell]` is still visible.
  - `/api/*` requests are never served the SPA fallback.
  - After logout, the caches are empty.
  - When a new SW is waiting, the update prompt appears.

### S0.6 Frontend foundation: M · W0
- **Depends on:** none · **Owns:** `frontend/src/App.jsx`, `frontend/src/components/AppShell*`, `frontend/src/components/ui/`, `frontend/src/api/` (core), `frontend/src/lib/`, `frontend/package.json` (adds all v1 deps)
- `apiFetch`:
  - JSON only, with CSRF-safe headers.
  - Adds an `Idempotency-Key` helper and the `X-Client-Version` header.
  - Error mapping: 401 → login with return-to; 426 → refresh banner.
- Route registry via `import.meta.glob('./routes/club/*/routes.jsx')`, plus registries for nav badges, the More menu and the Admin index.
- **New bottom nav:** Home · Events · Money · Inbox · More, with the existing roster areas under More → Roster. Explicit back buttons, because iOS standalone mode has none.
- UI kit: Button, StatusChip, SpotsBar, Stepper, BottomSheet, Toast, Empty/Error/Skeleton states, ConfirmDialog.
- Shared libraries: feature-flag hook (`/api/v1/config`), MSW fixtures, axe in Playwright.
- Pre-add all v1 frontend dependencies.
- **Tests first:**
  - Every existing roster route is still reachable.
  - Nav works on the iPhone and Android projects.
  - A probe route registers automatically.
  - A disabled flag hides its nav entry.
  - Axe finds no serious violations on the shell.
  - `apiFetch` maps 401 and 426 (unit tests).

### S0.8 Same-origin edge + real-device auth spike: M · W0 (human-in-the-loop)
- **Depends on:** none · **Owns:** `infra/cloudflare/` (Worker, Pages config), `docs/ops/spike-auth.md`
- Buy the domain and set up Cloudflare DNS.
- Pages serves the SPA. A Worker proxies `/api/*` and `/internal/*` to Render. The Worker has stubs for `/e` and `/s`.
- A throwaway endpoint sets a test cookie.
- **Prove on real devices** (iPhone Safari, iPhone installed PWA, Android Chrome, Android installed):
  - (1) the cookie survives a reload and a relaunch;
  - (2) the Google redirect flow works in Safari and in the **installed** app, recording the result per iOS version;
  - (3) a WhatsApp link opens Safari and shows the preview.
- **Output:** a decision record. Does standalone iOS show Google? Any Worker caveats?
- **Tests first:** a scripted check that the Worker forwards cookies and the `Origin` header, and that `/api` is not cached by the edge.

### S0.2 Core contracts, full v1 schema, test harness: L · W1
- **Depends on:** S0.1 · **Owns:** `backend/core/`, `backend/migrations/`, `backend/tests/club/factories.py`, `backend/conftest.py`, `backend/requirements.txt`
- **One Alembic baseline** creating **every PLAN §5.1 table**, so later stories add no migrations.
- Existing roster tables:
  - Baseline them from a **production schema dump**. Prod is `stamp`ed, never `upgrade`d.
  - Remove `_ensure_table_columns` once parity is proven.
- Services:
  - `Clock` with a test override.
  - `audit()` helper.
  - Permission dependencies: member / admin / owner-or-admin / captain-of-series.
  - Test-identity override, enabled only when `ENV=test`.
  - DB idempotency helper, plus HTTP `Idempotency-Key` middleware with the `IdempotencyRecord` table.
  - Postgres rate limiter.
  - Domain event bus with a durable outbox.
  - Tick hook registry.
  - Append-only ledger trigger.
- **Interfaces with recording fakes** (production wiring is replaced by the implementing story): `notify()`, `is_prepaid(member, series)`, `charge()`, `reverse()`, `kv_publish_og()`.
- Pre-add all v1 Python dependencies: alembic, pytest, hypothesis, pywebpush, google-auth, httpx.
- **Tests first:**
  - Migrations run up and down on empty Postgres.
  - `stamp` on a prod-schema fixture followed by autogenerate produces an empty diff.
  - Clock override works.
  - The idempotency helper inserts once under 10 concurrent calls.
  - The HTTP idempotency middleware replays the stored response.
  - The ledger trigger rejects UPDATE/DELETE, except a one-time `exported_at` set.
  - The test-identity override is rejected when `ENV≠test`.
  - The route-guard lint test (every `/api/v1` route declares a guard).

### S0.5 CI: Postgres, single head, Owns check: S · W1
- **Depends on:** S0.1 · **Owns:** `.github/workflows/ci.yml`, `scripts/ci/`
- Add a Postgres service container for `pytest backend/club`. Keep the unittest and SQLite Playwright jobs.
- `alembic heads` must return exactly 1.
- A PR Owns-path check: read paths from the PR body, compare with the diff, and allow a shared list.
- **Tests first:** a fixture PR diff that violates its Owns paths fails the script; two migration heads fail.

### S0.7 Observability: S · W1
- **Depends on:** S0.1 · **Owns:** `backend/ops/`, `frontend/src/ops/`
- `/healthz` reports DB status, `last_tick_at` and queue depth.
- Structured JSON logs with a request ID.
- Sentry free for backend and frontend, with an error boundary.
- Launch-metric counters: RSVP via link, push opt-in, claim-to-confirm time.
- **Tests first:**
  - `/healthz` reports a stale tick after 2× the expected interval.
  - Every log line carries the request ID.
  - The error boundary renders a fallback.

### S0.4 Hosting, Neon cutover, backups: M · W2
- **Depends on:** S0.2, S0.8 · **Owns:** `.github/workflows/backup*.yml`, `.github/workflows/scheduled*.yml`, `docs/ops/`
- Neon cutover runbook: freeze writes, dump, restore, stamp, verify, switch `DATABASE_URL`.
- Run `alembic upgrade` on deploy.
- Weekly encrypted `pg_dump` (key held only in secrets; the repo is private).
- Monthly restore drill and Lighthouse PWA audit as scheduled jobs.
- Budget check: verify current Render/Neon free limits and record them in `docs/ops/budgets.md`.
- Secrets inventory: VAPID (back up, **never rotate casually**), Resend, Cloudflare API token, TICK_SECRET, BOOTSTRAP_ADMIN_EMAIL, Google client, Sentry DSN.
- **Tests first:** the restore-drill job restores the latest dump into ephemeral Postgres and runs migrations plus a smoke query.

---

## E1: Authentication

### S1.1a Email login (link + code) and session cookie: M · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/auth/`, `frontend/src/routes/club/auth/`, `frontend/src/api/club/auth.js`
- Every login email carries both a magic link **and** a 6-digit code.
- The link opens a **confirm page**; the session is created only by a POST from that page (scanner-safe).
- Resend HTTP adapter, plus a console adapter for dev and test.
- Session cookie: `HttpOnly; Secure; SameSite=Lax`, 90 days, rolling.
- Rate limits stored in Postgres (PLAN §11.3).
- In installed iOS mode the login screen leads with the code.
- **Tests first:**
  - Expired, reused and wrong-code cases.
  - 5 wrong codes lock the challenge.
  - A 6th challenge within an hour is refused.
  - A prefetch GET of the link does not consume it.
  - The code works when the link was opened in another browser.
  - Unknown and known emails get the same response.
  - A state-changing request with a bad `Origin` or wrong content type gets 403.

### S1.1b Google sign-in (redirect): S · W3
- **Depends on:** S1.1a, S0.8 · **Owns:** `backend/club/auth/google*`, `frontend/src/routes/club/auth/google*`
- Redirect flow with state/nonce. Hidden in iOS standalone mode if S0.8 found it broken there.
- Links an existing member by verified email.
- **Tests first:**
  - Wrong audience, bad nonce and replayed state are rejected.
  - An existing email links to the existing member, not a duplicate.
  - Visibility follows the UA rule from S0.8.

### S1.2 Session, `/me`, logout, real identity in guards: S · W3
- **Depends on:** S1.1a · **Owns:** `backend/club/auth/session*`, `frontend/src/hooks/club/useMe.js`, `frontend/src/routes/club/guard*`
- Replace the test identity with the real one outside tests.
- `/me`, logout (one device or all), return-to with a stored **RSVP intent**, cache clear on logout (the S0.3 hook).
- **Tests first:**
  - Unauthenticated requests get 401.
  - The intent survives the login round-trip.
  - Logout-all kills other sessions.
  - The session's expiry rolls forward on activity.

### S1.3 Invites, join requests, approval, bootstrap admin: M · W4
- **Depends on:** S1.2, S2.1, S6.1 · **Owns:** `backend/club/members/invites*`, `backend/club/members/join*`, `frontend/src/routes/club/join/`, `frontend/src/routes/club/admin/approvals/`
- Invites: expiry, max uses, revoke.
- A `JoinRequest` can come from an invite, an event link or a series link.
- Pending members see a waiting screen, with no directory and no attendee names.
- Admin approval queue. Approving completes the stored RSVP intent.
- `admin_tasks` notification on every new request.
- The bootstrap admin is re-asserted on deploy.
- **Tests first:**
  - Pending members can't RSVP or see member, attendee or ledger data.
  - A revoked or expired invite is refused.
  - Approval auto-completes the intent.
  - Re-assert restores admin.
  - Admins are notified exactly once.

---

## E2: Members, settings, privacy

### S2.1 Members, roles, exit lifecycle: M · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/members/` (excluding invites/join/player_link), `frontend/src/routes/club/members/`, `frontend/src/routes/club/admin/members/`
- Admin member list, roles with last-admin protection, unique `payment_ref`.
- **Deactivate (PLAN §6.7):**
  - cancels future RSVPs through the `rsvp.cancel` interface;
  - limits the member to Money and attendance;
  - the pass seat is not resold.
- Profile editing.
- **Tests first:**
  - The 4-role permission matrix as a table-driven test.
  - Last-admin demotion is blocked.
  - `payment_ref` stays unique under concurrency.
  - An inactive member gets 403 on events and 200 on their ledger.
  - Every change is audited.

### S2.2 Member ↔ roster player link: S · W3
- **Depends on:** S2.1 · **Owns:** `backend/club/members/player_link*`, `backend/roster/players*` (additive), `frontend/src/routes/club/admin/player-links/`
- Auto-match by name, an admin screen to resolve leftovers, and an `is_guest` flag on players that hides them from the directory.
- **Tests first:**
  - Stats are unchanged after linking.
  - Guests are hidden from the planner directory by default.
  - A player can be linked to only one member.
  - The full roster Playwright suite stays green.

### S2.3 Club settings: S · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/settings/`, `frontend/src/routes/club/admin/settings/`
- Club name, bank details and payment instructions, quiet hours, revoke days, auto-promote cutoff, defaults, accounting account codes. Public part served through `/api/v1/config`.
- **Tests first:** admin only; validation (IBAN or bankgiro format, quiet hours); `/config` exposes no bank or private fields to anonymous callers.

### S2.4 Audit-log viewer: S · W4
- **Depends on:** S2.1 · **Owns:** `backend/club/audit/`, `frontend/src/routes/club/admin/audit/`
- `GET /admin/audit` with filters for actor, entity and date. Read-only UI.
- **Tests first:** members get 403; filters work; pagination is stable.

### S2.5 Privacy: export, erasure, retention: M · W5
- **Depends on:** S2.1, S5.1, S6.2 · **Owns:** `backend/club/privacy/`, `frontend/src/routes/club/privacy/`
- `/me/export` (JSON).
- Admin erase (PLAN §16): requires a zero balance or a waiver.
- Retention purges registered as tick hooks.
- Privacy notice page.
- **Tests first:**
  - After erasure: no email, Google ID or push subscriptions; guest names show as "Guest"; audit JSON is pseudonymized; ledger sums are unchanged.
  - The export covers every personal table (schema-driven test).
  - The purge removes expired challenges and old send logs only.

---

## E3: Terms, series, events

### S3.0 Events core: M · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/events/` (model service, list/detail, slugs), `frontend/src/routes/club/events/` (list + detail page with **slots**), `frontend/src/api/club/events.js`
- Event list and detail API.
- Random slugs of 8 or more characters for **events and series**.
- `by-slug` endpoints, including `/series/by-slug/{slug}/next`.
- Event page slots: `RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`.
- Publishes OG data through the `kv_publish_og` interface on every change.
- **Tests first:**
  - Slugs are unique and unguessable (length and charset).
  - `next` skips cancelled and closed events.
  - Past events are read-only.
  - Slots render the components registered in them.
  - Pending members see no attendee list.

### S3.1 Terms, series, captains, clone: M · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/terms/` (excluding recurrence), `frontend/src/routes/club/admin/terms/`
- Term status machine. Series CRUD. **Captains.** **Clone term** (series copied with new dates as a draft). The next term can be open for passes while the current one is active. `pass_cap` is derived.
- **Tests first:**
  - Invalid term transitions are rejected.
  - Clone copies series without events or passes.
  - Captain permissions apply only to their own series.
  - Field validation.

### S3.2 Recurrence, skip-dates, occurrence edits: M · W3
- **Depends on:** S3.0, S3.1 · **Owns:** `backend/club/terms/recurrence*`, `frontend/src/routes/club/admin/terms/schedule*`
- Weekly generation, DST-safe. `rsvp_close_at` is stored in UTC, computed from absolute minutes before start.
- Skip-dates lock at `open_for_passes`; an admin override shows the affected pass holders.
- Single-occurrence edits: an edit that would push `pass_cap` below active passes is blocked unless overridden. Overrides go through S4.4b's rules.
- **Tests first:**
  - Property test: correct weekday and local time across both DST changes.
  - Regeneration is idempotent and preserves edited occurrences.
  - Skip-date edits after the lock are refused without an override.
  - A cap-below-sold edit is blocked.

### S3.3 One-off events (member free + admin paid): S · W3
- **Depends on:** S3.0 · **Owns:** `backend/club/events/oneoff*`, `frontend/src/routes/club/events/new*`
- Member one-offs: `fee=0`, `instant` allocation.
- Admin one-offs: optional fee, `tiered` allocation with no tier 1.
- Only the creator, an admin, or (for series events) a captain can edit.
- **Tests first:**
  - A member can't set a fee or tiered mode.
  - An admin one-off with a fee treats a pass holder as tier 2.
  - Non-owners can't edit.

---

## E4: RSVP & allocation (critical path)

### S4.1 Allocation engine (pure): M · W1
- **Depends on:** S0.1 · **Owns:** `backend/club/allocation/`
- `allocate()` for `tiered` and `instant` modes. `waitlist_insert()` (A5). `promote()` with the auto/offer cutoff (A6).
- **Tests first:**
  - The **PLAN §6.2 worked example with its exact expected output**.
  - A table of waitlist order after close.
  - Hypothesis properties: capacity, orphan guests, tier precedence, determinism.
  - Instant mode is strictly first-come.

### S4.2 RSVP pre-close API + panel: M · W3
- **Depends on:** S3.0, S4.1 · **Owns:** `backend/club/rsvp/` (pre-close), `frontend/src/components/club/rsvp/` (pre-close states; fills `RsvpSlot`)
- `PUT` and `DELETE` RSVP with guest names. Tier comes from `is_prepaid` (a fake until S5.3).
- Status display: Confirmed for prepaid, Requested for others. Instant mode confirms immediately.
- Guest stepper bounded by the limit. Attendee list. Emits `rsvp_changed`.
- Idempotency-Key required.
- **Tests first:**
  - One RSVP per member.
  - The guest limit holds.
  - Cancel before close creates no ledger entries.
  - Instant mode with a full event goes to the waitlist.
  - Pending and inactive members are blocked.
  - A double-submitted PUT has a single effect.

### S4.3 Close processing + charges: M · W4
- **Depends on:** S4.2, S5.1, S6.1 · **Owns:** `backend/club/rsvp/close*`
- Implements PLAN §6.3: row lock and skip-locked; close-on-read capped at 5 events per request; registered as a tick hook; charges via the ledger; notifications; an `event_closed` outbox row.
- **Tests first:**
  - Closing twice gives an identical result.
  - Two concurrent closes create one charge set (Postgres).
  - Member one-offs create zero ledger entries.
  - In admin paid one-offs, everyone is charged.
  - Prepaid members are never charged.
  - Notifications are sent exactly once.

### S4.4a Post-close: late RSVP, cancel, promotion, refill: M · W5
- **Depends on:** S4.3 · **Owns:** `backend/club/rsvp/postclose*`, `frontend/src/components/club/rsvp/postclose*`
- Late RSVPs follow A5. A late cancel becomes `late_cancelled`.
- Auto-promotion runs until the cutoff. Refill reversal follows the PLAN §6.4 definition (event at capacity, earliest canceller first).
- A host cancel cascades to their guests. Guests added after close are tier 3. Guest name edits are free.
- **Tests first:**
  - Every row of PLAN §6.4 has a test.
  - A cancel while spots are free means the charge stands.
  - Two late cancels and one refill reverse the earliest.
  - Cascade.
  - A promoted member who then cancels is treated as a late cancel.

### S4.4b Claim-a-spot and capacity changes: S · W5
- **Depends on:** S4.3 · **Owns:** `backend/club/rsvp/claim*`, `backend/club/rsvp/capacity*`, `frontend/src/components/club/rsvp/claim*`
- After the cutoff a spot is `offered` to the whole waitlist and the first claim wins.
- Capacity rules (PLAN §6.6): override handling; raising capacity promotes.
- **Tests first:** in a race between two claimers, exactly one wins; lowering capacity below confirmed tier 1 is blocked without an override; an override waitlists the latest prepaid members and notifies them.

### S4.4c Event cancellation & material changes: S · W5
- **Depends on:** S4.3, S3.2 · **Owns:** `backend/club/rsvp/eventchange*`, `frontend/src/components/club/organizer/edit*`
- Cancelling an event reverses all of its charges and notifies everyone.
- A date, time or location change after close notifies everyone and opens a 24h free-cancel window.
- The fee is immutable after close. A series fee change applies only to events that haven't closed.
- **Tests first:**
  - Cancelling an event brings the event's net charge total to 0.
  - A cancel inside the window reverses the charge with no refill needed; outside the window the normal rules apply.
  - A fee edit on a closed event gets 409.

---

## E5: Passes & money

### S5.1 Ledger core: M · W2
- **Depends on:** S0.2 · **Owns:** `backend/club/ledger/` (service, me-read)
- `charge`, `reverse`, `record_payment`, `adjust`, `balance`, `itemize` (FIFO, partial payments, credit).
- Self-ledger guard (A12). Replaces the `charge`/`reverse` fakes.
- **Tests first:**
  - Property tests: balance equals the sum of entries; FIFO marks the oldest charges paid; a partial payment splits correctly; overpayment shows as credit and is used up by the next charge.
  - Reversing a reversal is refused.
  - Integers only.
  - An admin recording on their own ledger is blocked unless they are the sole admin, in which case it is flagged.

### S5.2 Member money screen: S · W3
- **Depends on:** S5.1, S2.3 · **Owns:** `frontend/src/routes/club/money/` (excluding passes/claims), `frontend/src/api/club/ledger.js`
- Balance (owed or credit), bank details and payment reference with copy, itemized entries, history.
- **Tests first (Playwright):**
  - Members see only their own entries.
  - Item text includes the event date and guest name.
  - Credit display is correct.
  - Another member's ledger gets 403.

### S5.3 Passes: offers, cap, proration, revocation: M · W4
- **Depends on:** S3.2, S5.1, S4.2 · **Owns:** `backend/club/passes/`, `frontend/src/routes/club/money/passes*`
- Offers, with the terms text shown before purchase.
- Prorated price with round half-up. Cap enforced under a row lock.
- Purchase upgrades the member's open RSVPs to tier 1. Admins can grant passes.
- **Revoke** an unpaid pass after N days (PLAN §6.5), which downgrades the member's RSVPs.
- Replaces the `is_prepaid` fake.
- **Tests first:**
  - A proration table: full term, half, last event, and 0 remaining means not offered.
  - Half values round up.
  - In a race of 2 buyers for 1 seat, exactly 1 succeeds.
  - Purchase turns Requested into Confirmed.
  - Revoke is unavailable before N days or when the pass is paid.
  - Revoke reverses the charge, frees the seat, downgrades RSVPs and notifies the member.
  - No refund endpoint exists.

### S5.4 Admin balances, payments, adjustments: M · W3
- **Depends on:** S5.1, S2.1 · **Owns:** `backend/club/ledger/admin*`, `frontend/src/routes/club/admin/money/` (excluding claims/export)
- Balances table with filters: revocable, and inactive with balance.
- Record a payment by searching name or payment reference.
- Waive (a reason is required). Manual charge.
- **Tests first:**
  - Members get 403.
  - Recording a payment updates the member's balance and FIFO allocation.
  - A waiver creates a reversal plus an audit entry.
  - A double-tapped payment is recorded once (Idempotency-Key).
  - The self-ledger guard holds.

### S5.5 Payment claims ("I've paid"): S · W4
- **Depends on:** S5.2, S5.4, S6.1 · **Owns:** `backend/club/ledger/claims*`, `frontend/src/routes/club/money/claims*`, `frontend/src/routes/club/admin/money/claims*`
- The member submits a claim. The balance screen then shows the pending amount.
- Admins get an `admin_tasks` notification and work through a queue.
- Confirming creates a linked payment. Rejecting requires a reason, and the member is notified (`payment_status`).
- **Tests first:**
  - A pending claim doesn't change the balance.
  - Confirm creates exactly one payment, even with a double tap.
  - Reject notifies the member with the reason.
  - An admin can't confirm their own claim (A12).

### S5.6 Accounting export (manager.io): S · W5
- **Depends on:** S5.4, S2.3 · **Owns:** `backend/club/accounting/`, `frontend/src/routes/club/admin/money/export*`
- First, confirm the import format with the treasurer. Then a CSV export of ledger entries not yet exported, mapped to the account codes in Settings; it sets `exported_at`. Re-exporting a period is flagged.
- **Tests first:**
  - Golden-file CSV with column order and a fixed format.
  - Export totals match the sum of the ledger for the period.
  - A second export of the same period contains nothing new unless re-export is chosen.

---

## E6: Notifications & reminders

### S6.1 Notification core + inbox + policy chain: M · W2
- **Depends on:** S0.2, S0.6 · **Owns:** `backend/club/notifications/` (core), `frontend/src/routes/club/inbox/`, `frontend/src/api/club/notifications.js`
- `notify()` writes the inbox row and enqueues the push through a **delivery policy chain**. Policies are pluggable modules.
- Categories include `admin_tasks` and `payment_status`.
- Unread badge registered in the nav registry.
- Replaces the `notify` fake, including the stubs in S1.3.
- **Tests first:**
  - Notify is idempotent.
  - Members see only their own notifications.
  - Deep links open the right screen.
  - A policy that returns "suppress push" still writes the inbox row.

### S6.2 Web push: M · W3
- **Depends on:** S6.1, S0.3 · **Owns:** `backend/club/notifications/push*`, `frontend/src/sw/push*`, `backend/club/notifications/policies/quiet_hours*`
- VAPID. Subscribe and unsubscribe; the app **re-subscribes on every open**.
- The service worker always calls `showNotification`. Clicking a notification opens its deep link.
- 404/410 deletes the subscription. 5xx errors back off and retry.
- Quiet-hours policy. Admin push-coverage endpoint.
- **Tests first:**
  - A mocked push service: success, 410, and 5xx with retry.
  - A message deferred by quiet hours is delivered at 08:00 Stockholm time.
  - The push handler shows a notification for every payload (SW unit test).
  - Coverage counts the healthy subscriptions.

### S6.3 Preferences & mute: S · W3
- **Depends on:** S6.1 · **Owns:** `backend/club/notifications/policies/mute*`, `backend/club/notifications/prefs*`, `frontend/src/routes/club/settings/notifications*`
- Per-category toggles and a global mute. Every category can be muted.
- **Tests first:** a muted category gets an inbox row but no push; global mute overrides the categories; defaults are all on.

### S6.4 Scheduler tick: S · W2
- **Depends on:** S0.2 · **Owns:** `backend/club/scheduler/`, `docs/ops/cron.md`
- `/internal/tick` requires the secret, holds an advisory lock and runs the registered hooks with bounded runtime.
- If `next_due_at` hasn't passed, it skips the DB work.
- Pings healthchecks.io on success. Updates `SchedulerState`.
- Raises an `admin_tasks` alert when the tick is stale.
- The cron-job.org schedule (every 10 minutes 07–23, hourly otherwise) is documented.
- **Tests first:**
  - A wrong secret gets 403.
  - An overlapping tick is a no-op.
  - A missed tick is processed once on the next run.
  - When nothing is due, no hook runs.
  - A hook failure records `last_error` and the other hooks still run.

### S6.5a Reminder rules engine: M · W4
- **Depends on:** S6.3, S6.4, S5.1, S4.2 · **Owns:** `backend/club/reminders/`
- Rules for payment due, un-RSVPed events and poll closing (registered by S9.1).
- Per-member, per-category minimum interval read from the send log. A preview that equals the actual send.
- Registered as a tick hook.
- **Tests first (fixed timestamps):**
  - A balance of 500 kr on 2027-01-01 with a 90-day rule fires on 01-01 and 04-01, not in between.
  - Paying below the threshold stops the reminders.
  - The un-RSVPed rule skips members who responded or cancelled.
  - Muted members get the inbox only.
  - The preview count equals the sent count.

### S6.5b Reminder admin UI: S · W5
- **Depends on:** S6.5a · **Owns:** `frontend/src/routes/club/admin/reminders/`
- Enable or disable rules, set parameters and templates with a placeholder preview, and show the "would notify N" preview.
- **Tests first:** the template renders `{amount}`, `{ref}` and `{bank}`; an invalid placeholder is rejected; members get 403.

### S6.6 Admin broadcasts: S · W4
- **Depends on:** S6.1 · **Owns:** `backend/club/broadcasts/`, `frontend/src/routes/club/admin/broadcast/`
- Audiences: everyone, a series' pass holders, an event's RSVPs, or the captains.
- **Tests first:** audience resolution; the `announcements` mute is respected; broadcasts are audited.

---

## E7: Sharing

### S7.1 Share links, edge OG, request-to-join: M · W5
- **Depends on:** S3.0, S4.2, S1.2, S1.3, S0.8 · **Owns:** `infra/cloudflare/worker/og*`, `backend/club/share/`, `frontend/src/components/club/share/` (fills `ShareSlot`), `frontend/src/routes/club/share/`
- The Worker renders `/e` and `/s` from KV, falling back to a generic preview. Pages are `noindex`, show no attendee names and send a CSP.
- The backend implements `kv_publish_og` through the Cloudflare API, replacing the fake.
- Share uses the Web Share API, with a copy fallback carrying the WhatsApp text.
- Logged-out visitors: the RSVP intent is carried through login.
- Non-members: a **request to join** creates a JoinRequest through the S1.3 API.
- **Tests first:**
  - OG attributes are escaped, tested with a `"><script>` title.
  - A KV miss gives the generic preview.
  - An unknown slug gives a friendly 404.
  - `/s` resolves to the next open event.
  - Playwright: logged out → code login → RSVPed with at most 1 extra tap.
  - Playwright: a non-member gets a request-to-join screen.

---

## E8: Roster & attendance

### S8.1 Seed planner from a closed event: M · W5
- **Depends on:** S4.3, S2.2 · **Owns:** `backend/club/roster_bridge/`, `frontend/src/components/club/organizer/roster*` (fills `OrganizerToolsSlot`), a minimal additive hook in `frontend/src/hooks/usePlannerState.js`
- Consumes `event_closed` and `rsvp_changed`. Creates and updates the draft. Stale banner.
- Event creator, captain or admin authorization for event-linked sessions.
- **Tests first:**
  - The draft equals the confirmed list.
  - A synthetic `rsvp_changed` updates the draft.
  - A started session is never mutated.
  - Full regression of the existing standalone planner in Playwright.

### S8.2 Attendance marking: S · W6
- **Depends on:** S8.1 · **Owns:** `backend/club/attendance/`, `frontend/src/components/club/organizer/attendance*`
- Attendance defaults from the started roster, or from the RSVP list if there was none.
- The organizer flips no-shows. The organizer can edit for 7 days; after that, admin only.
- No new charges.
- `admin_tasks` reminder if attendance is still unmarked 24h after the event.
- **Tests first:**
  - A prepaid no-show changes the ledger by 0.
  - A non-prepaid no-show's charge stands.
  - Permissions: organizer, captain, admin.
  - The 7-day lock.

### S8.3 Member attendance & "why" history: S · W7
- **Depends on:** S8.2, S5.2 · **Owns:** `frontend/src/routes/club/me/attendance*`, `backend/club/attendance/me*`
- **Tests first:** every event-linked ledger row is reachable from history, and every history row links to its charge, in both directions.

---

## E9: Polls

### S9.1 Polls: M · W4
- **Depends on:** S6.1, S6.4 · **Owns:** `backend/club/polls/`, `frontend/src/routes/club/polls/`
- Admin only. Single or multi choice. Publishing sends a notification.
- Members can change their vote until close. The tick closes polls automatically.
- Visibility modes. Anonymous mode. Registers the poll-closing reminder.
- **Tests first:**
  - Single and multi choice are enforced.
  - Voting after close is rejected.
  - Anonymous polls expose no voters through any endpoint (an endpoint sweep test).
  - Visibility modes behave as specified.

### S9.2 Image options: S · W5
- **Depends on:** S9.1 · **Owns:** `backend/club/images/`, `frontend/src/components/club/ImagePicker*`
- Images are resized client-side to 300 KB or less. The server sniffs the real type. At most 8 images per poll; purged 6 months after the poll closes (tick hook).
- **Tests first:**
  - Non-images and oversized files are rejected server-side.
  - Members only.
  - Purge removes only images from expired polls.
  - Playwright: voting on an image poll on mobile.

---

## E10: Experience

### S10.1 Home dashboard: S · W6
- **Depends on:** S4.4a, S5.5, S9.1 · **Owns:** `frontend/src/routes/club/home/`
- **Tests first:** explicit assertions for each fixture: a new member, a prepaid member, a member owing money with a pending claim, and an admin with pending tasks.

### S10.2 Install & push onboarding: S · W4
- **Depends on:** S6.2, S0.3 · **Owns:** `frontend/src/components/club/install/`
- Android: a button driven by `beforeinstallprompt`. iOS Safari outside standalone: an "Add to Home Screen" guide.
- Ask for push permission only after the first RSVP, and never ask again after a decline.
- **Tests first:** a UA matrix (unit); no permission request on first load (Playwright spy).

---

## E11: Launch

### S11.1 Club-week scenarios: M · W8
- **Depends on:** all functional stories · **Owns:** `backend/tests/scenarios/`, `frontend/tests/club/`
- The integration agent starts the skeleton in W2 and grows it each wave. This story finalizes it.
- The full script: term setup → captains → passes, including one revocation → 3 series events, an admin paid one-off and a member one-off → RSVPs and guests → close → late cancels, refills and claims → a material change → attendance → claims and payments → reminders → poll → manager.io export. The final ledger is asserted line by line.

### S11.2 Member import with opening balances: S · W6
- **Depends on:** S2.2, S5.1 · **Owns:** `backend/club/importer/`
- **Tests first:**
  - Opening balances import exactly, with reason `opening_balance`.
  - Re-running the import is idempotent.
  - Malformed rows are reported and nothing is partially applied.

### S11.3 Device QA & launch checklist (checklist, not automated tests): S · W9
- **Depends on:** S11.1, S10.2 · **Owns:** `docs/club-app/LAUNCH.md`
- A real-device matrix covering both install paths: push, the WhatsApp preview, code login and Google login.
- Lighthouse PWA audit. Restore drill. Free-tier budget check.
- The rollout steps from PLAN §14.

---

## Execution protocol for the agent team

1. **Contracts first.** W0 and W1 merge before W2 starts. After that, the schema, interfaces, registries and dependencies change only through a small "contract change" PR reviewed by the root/integrator agent.
2. **Merge to main behind flags.** Stack PRs only on single-parent stories. Multi-parent stories branch from main once their parents are merged.
3. **Migrations.** The baseline covers all v1 tables. Any later change goes through the integrator's merge queue, with `down_revision` set to the current head. CI enforces a single head.
4. **Integration cadence.** After every wave, an integration agent rebases onto main and runs the full unittest suite, Postgres pytest and all Playwright projects, then grows the S11.1 scenario.
5. **Escalation.** When the plan is ambiguous, an agent asks the root agent rather than guessing. Model tiering: a lower-cost model for mechanical stories (S0.1, S2.4, S6.6), and high effort for S0.2, S4.x and S5.x (money and allocation).
6. **Human gates.** S0.8 and S11.3 need real devices. S5.6 needs the treasurer to confirm the manager.io format. The domain purchase blocks S0.8.

## Traceability

| Requirement / decision | Stories |
|---|---|
| PWA on Android + iOS | S0.3, S0.6, S0.8, S6.2, S10.2, S11.3 |
| 1. Admin + member roles (and captains) | S0.2, S1.1a/b, S1.2, S1.3, S2.1, S3.1 |
| 2. Members add sessions, RSVP, guests | S3.3, S4.2, S4.4a |
| 3. 6-month series, prepay, ad-hoc fee | S3.1, S3.2, S5.3, S4.3 |
| 4. Track owed; bank transfer; admin confirms paid/pending | S5.1, S5.2, S5.4, **S5.5** |
| 5. Members see attendance and why | S8.2, S8.3, S5.2 |
| 6. Roster integration | S2.2, S8.1, S8.2 |
| 7. One RSVP link for WhatsApp | S3.0, S7.1, S0.8 |
| 8. Reminders, mute, admin frequency | S6.3, S6.4, S6.5a/b, S6.6 |
| 9. Polls incl. T-shirt designs | S9.1, S9.2 |
| Admin journeys (approvals, claims, term setup, health) | S1.3, S5.5, S3.1, S6.4, S0.7 |
| Bookkeeping in manager.io | S5.6 |
| Privacy/GDPR + 7-year retention | S2.5 |
| Member exit | S2.1 |
| Unpaid pass revocation | S5.3 |
| Event changes after close | S4.4c |
| Paid admin one-offs | S3.3, S4.3 |
| Free-tier budgets and ops | S0.4, S0.7, S6.4 |

**Total: 12 epics (E0–E11), 51 stories.**
