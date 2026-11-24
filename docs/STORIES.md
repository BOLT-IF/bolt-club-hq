# Bolt Club HQ: Epics, Stories & Build Order (v3)

Companion to `PLAN.md` (§ refers to it). This is a greenfield repo: **`BOLT-IF/bolt-club-hq`**. One story (R1) lands in **`BOLT-IF/roster-generator`**. v2 is preserved; dropped content is in `history/DISCARDED-v3.md`.

## The DP framing
- Each story is a subproblem. **Depends on** lists the solved subproblems it reuses.
- **Owns** lists the only paths the story may edit. A CI check enforces this, with a small shared allow-list.
- **Waves** are a topological order. A wave runs fully in parallel, one agent per story.
- Base case: W0 scaffold + W1 contracts. Final answer: all 48 stories merged = the full app.

Sizes: **S** ≤ ½ day of agent effort · **M** ≈ 1 day · **L** ≈ 2 days.

### Definition of done (every story)
1. A failing-tests commit comes first, so CI shows red. Then the code turns it green.
2. These all pass: `npm run typecheck`, `npm run lint`, `npm test` (Vitest: domain, workers-pool against **Postgres**, UI), and the affected Playwright projects.
3. No new migration unless it goes through the integrator queue. CI checks there is a single migration chain.
4. Every new route has a permission guard. Money and RSVP POSTs require an `Idempotency-Key`.
5. The work is behind its area feature flag.
6. `docs/areas/<area>.md` is updated.
7. Stack the PR on its parent when it has exactly one parent. Otherwise branch from main once all parents have merged.
8. The story that implements an interface removes the fake from production wiring, and a test asserts the fake is gone.

---

## Dependency graph (waves)

```
W0  S0.1 scaffold
W1  S0.2 core+schema · S0.3 PWA/SW · S0.4 FE foundation · S0.5 CI/deploy/ops · S0.6 device spike
    S0.7 observability · S4.1 allocation (pure) · R1 roster import (roster repo)
W2  S1.1 Clerk · S2.1 members · S2.3 settings · S3.0 events core · S3.1 terms/series
    S5.1 ledger · S6.1 notifications · S6.4 cron
W3  S1.3 invites/join · S2.4 audit viewer · S3.2 recurrence · S3.3 one-offs · S4.2 RSVP pre-close
    S5.2 member money · S5.4 admin money · S6.2 push · S6.3 prefs
W4  S4.3 close · S5.3 passes · S5.5 claims · S6.5a reminder engine · S6.6 broadcasts
    S7.1 share/OG · S9.1 polls · S10.2 install UX
W5  S4.4a late/refill · S4.4b claim/capacity · S4.4c event changes · S8.1 attendance
    S8.3 roster deep link · S9.2 images (R2) · S6.5b reminder UI · S5.6 manager.io export · S2.5 privacy
W6  S8.2 attendance history · S10.1 home · S11.2 member import
W7  S11.1 club-week scenarios
W8  S11.3 device QA + launch
```

| Wave | Count | Notes |
|---|---|---|
| 0 | 1 | Everything depends on the scaffold. Small, so do it fast. |
| 1 | 8 | S0.6 needs a human with an iPhone and Android phone, plus the domain bought |
| 2 | 8 | |
| 3 | 9 | |
| 4 | 8 | |
| 5 | 9 | |
| 6 | 3 | |
| 7 | 1 | |
| 8 | 1 + human | |

**Critical path (9 steps):** S0.1 → S0.2 → S3.0 → S4.2 → S4.3 → S4.4a → S10.1 → S11.1 → S11.3.

Login is off the critical path. From W2 on, stories use the **test-identity override** from S0.2. It only works in test builds.

---

## E0: Foundations

### S0.1 Repo scaffold: M · W0
- **Depends on:** none · **Owns:** the whole repo (the only story in W0)
- One Worker serves the API and the static assets.
  - npm, TypeScript strict, Vite with `@cloudflare/vite-plugin`, React 19, Hono, Drizzle, `wrangler.jsonc` (bindings for KV, R2, Hyperdrive, cron), ESLint and Prettier.
  - Vitest projects: `domain`, `worker` (`@cloudflare/vitest-pool-workers`), `ui` (jsdom). Playwright projects: desktop, iPhone, Android.
- Folder layout per PLAN §11.4. **Every v1 dependency is pre-added**, so later stories never edit the lockfile: Clerk (backend + React), the Neon driver, fast-check, MSW, axe, `vite-plugin-pwa`, a WebCrypto web-push library, toucan-js.
- Route auto-registration:
  - backend: generated from `src/worker/*/routes.ts` via `import.meta.glob`;
  - frontend: `src/app/routes/*/routes.tsx`.
- `docker-compose.yml` with Postgres for local tests.
- **Tests first:**
  - A probe route is registered automatically on both sides.
  - `wrangler dev` serves `/healthz` and the SPA from the same origin.
  - Each Vitest project and Playwright run executes one passing test.

### S0.2 Core contracts + full schema: L · W1
- **Depends on:** S0.1 · **Owns:** `src/worker/core/`, `db/`, `src/worker/test-support/`, plus integrator-sanctioned additions (2026-11-23): `docs/ops/db.md`, `vitest.config.ts` (db project), `drizzle.config.ts`, `src/worker/types/pg.d.ts` (interim, replace with `@types/pg` at next dependency change), and the one-time `pg` dependency addition (`package.json`, `package-lock.json`, `.github/workflows/generate-lockfile.yml` branch trigger)
- **One initial Drizzle migration** creating every table in PLAN §5.1, plus the append-only ledger trigger.
- **DB access:** go with Hyperdrive if it is available on the free plan. Otherwise use the Neon WebSocket driver. Record the decision in `docs/ops/db.md`. Real transactions are required either way.
- **Core services:**
  - `Clock` with a test override.
  - `audit()`.
  - Permission middleware for member, admin, owner-or-admin and captain-of-series.
  - **Test-identity override**, active only when `ENV=test`.
  - DB idempotency helper, plus HTTP `Idempotency-Key` middleware backed by `IdempotencyRecord`.
  - Outbox event bus.
  - Cron hook registry.
- **Interfaces with recording fakes:** `notify`, `isPrepaid`, `charge`, `reverse`, `publishOg` (KV), `currentMember`.
- Factories for tests.
- **Tests first:**
  - The migration applies cleanly to empty Postgres.
  - The ledger trigger rejects UPDATE and DELETE, apart from a one-time `exported_at`.
  - With 10 concurrent idempotent inserts, exactly 1 row results.
  - The HTTP idempotency middleware replays the stored response.
  - The test-identity override is rejected when `ENV≠test`.
  - The route-guard lint: every `/api/v1` route declares a guard.
  - A transaction holding `FOR UPDATE` blocks a second one (proves the driver choice).

### S0.3 PWA manifest + service worker: M · W1
- **Depends on:** S0.1 · **Owns:** `vite.config.ts` (PWA section), `public/`, `src/sw/`, `tests/e2e/pwa.spec.ts` (integrator-approved spec home, 2026-11-23)
- `vite-plugin-pwa` in **injectManifest** mode.
  - Manifest with icons 192, 512 and maskable. Apple meta tags. Precache the app shell.
  - Allowlisted GET routes: network-first, 3 s timeout, then cache with a "stale" badge.
  - Clear the cache on logout (the hook is exported).
  - `navigateFallback` excludes `/api`, `/e`, `/s` and `/media`.
  - New versions show a prompt to reload.
- **Tests first (Playwright):**
  - The manifest is valid and the service worker registers.
  - Offline + reload still shows `[data-testid=app-shell]`.
  - `/api` requests never receive the fallback page.
  - Caches are empty after logout.
  - The update prompt appears.

### S0.4 Frontend foundation: M · W1
- **Depends on:** S0.1 · **Owns:** `src/app/shell/`, `src/app/components/ui/`, `src/app/api/client.ts`, `src/app/lib/`
- **`apiFetch`:**
  - Sends the Clerk bearer token, an `Idempotency-Key` helper and `X-Client-Version`.
  - Maps errors: 401 goes to sign-in with a return-to, 426 shows a refresh banner.
- **Registries:** routes, nav badges, the More menu, the Admin index.
- **Navigation:** bottom nav (Home · Events · Money · Inbox · More), plus explicit back controls.
- **UI kit:** Button, StatusChip, SpotsBar, Stepper, BottomSheet, Toast, Empty/Error/Skeleton states, ConfirmDialog.
- **Other:** feature-flag hook, MSW fixtures, axe checks in Playwright.
- **Tests first:**
  - Nav works on iPhone and Android.
  - A probe route registers.
  - A disabled flag hides its nav entry.
  - axe reports no serious issues.
  - `apiFetch` maps 401 and 426.

### S0.5 CI, deploy, backups, budgets: M · W1
- **Depends on:** S0.1 · **Owns:** `.github/workflows/`, `scripts/ci/`, `docs/ops/`
- **CI:** typecheck, lint, Vitest with a **Postgres service container**, Playwright sharded across 4 runners (the pattern that already works in the roster repo), the Owns-path check, and the single-migration-chain check.
- **Deploy:** `wrangler deploy` on main, then run migrations, then a smoke test.
- **Scheduled jobs:**
  - weekly encrypted `pg_dump` (the key lives only in secrets; the repo is private);
  - monthly restore drill;
  - monthly Lighthouse run.
- **Docs:**
  - `budgets.md`: verified current free limits for Workers, Cron Triggers, KV, R2, Hyperdrive, Neon and Clerk.
  - Secrets inventory: Clerk keys, VAPID (backed up, **never rotate casually**), Neon URL, healthchecks URL, Sentry DSN, `BOOTSTRAP_ADMIN_EMAIL`.
- **Tests first:**
  - A fixture PR diff that breaks its Owns list fails the check.
  - Two migration heads fail the check.
  - The restore drill restores the latest dump and runs a smoke query.

### S0.6 Real-device spike (human-in-the-loop): M · W1
- **Depends on:** S0.1, plus the domain purchase · **Owns:** `docs/ops/spike-devices.md`, `spike/` (deleted after the spike)
- Set up the domain on Cloudflare and a Clerk production instance. Deploy a throwaway page.
- Prove on an iPhone (in Safari *and* installed) and an Android phone (in Chrome and installed):
  1. Clerk email-code sign-in works, and the session survives relaunch.
  2. Clerk Google sign-in: record per platform whether it works in the installed app.
  3. A WhatsApp share of `/e/x` shows the KV-backed OG preview.
  4. A web push sent from the Worker arrives on the installed iOS app. Measure the CPU time per push encryption.
- **Output:** a decision record covering the Google-in-standalone rule, the push batch size, and any caveats.
- **Tests first:** a scripted check that `/e/x` returns OG tags in under 200 ms from KV.

### S0.7 Observability: S · W1
- **Depends on:** S0.1 · **Owns:** `src/worker/ops/`, `src/app/ops/`
- `/healthz` reports DB status, `last_tick_at` and queue depth.
- Structured logs carry a request ID.
- Sentry free on both sides: toucan-js in the Worker, and the browser SDK with an error boundary.
- Launch-metric counters: link-RSVP rate, push opt-in, time from claim to confirmation.
- **Tests first:** `/healthz` reports the tick as stale after 2× the cron interval; every log line has a request ID; the error boundary renders.

---

## E1: Identity (Clerk)

### S1.1 Clerk integration: M · W2
- **Depends on:** S0.2, S0.4, S0.6 · **Owns:** `src/worker/auth/`, `src/app/routes/auth/`, `src/app/auth/`, plus integrator-sanctioned (2026-11-24): `src/app/main.tsx` (wrap the app in `AuthProvider`)
- **Frontend:**
  - `<ClerkProvider>` and sign-in screens.
  - The installed iOS app leads with **email code**. Google is shown according to the S0.6 rule.
- **Backend:** JWT verification without a network call, using a cached JWKS. The `currentMember` implementation:
  - The first call creates a `pending` Member.
  - It re-asserts the bootstrap admin.
- **RSVP intent** is stored before sign-in and restored after.
- Logout clears the service-worker cache.
- Playwright signs in via Clerk testing tokens.
- **Tests first:**
  - Missing, expired or wrong-issuer JWTs get 401.
  - The first sign-in creates exactly one pending member, even with concurrent requests.
  - The bootstrap email becomes admin.
  - The intent survives the round trip.
  - State-changing requests from a bad `Origin` get 403.

### S1.3 Invites, join requests, approval: M · W3
- **Depends on:** S1.1, S2.1, S6.1 · **Owns:** `src/worker/members/invites*`, `src/worker/members/join*`, `src/app/routes/join/`, `src/app/routes/admin/approvals/`
- Invites support expiry, max uses and revocation.
- A JoinRequest can come from an invite, an event link or a series link.
- Pending members see a waiting screen. They get no member directory and no attendee names.
- Admins work through an approval queue. Approval completes the member's stored RSVP intent.
- Each new request sends an `admin_tasks` notification.
- **Tests first:**
  - A pending member can't RSVP or see members, attendees or the ledger.
  - A revoked or expired invite is refused.
  - Approval completes the stored intent.
  - Admins are notified exactly once.

---

## E2: Members, settings, privacy

### S2.1 Members, roles, exit lifecycle: M · W2
- **Depends on:** S0.2, S0.4 · **Owns:** `src/worker/members/` (except invites and join), `src/app/routes/members/`, `src/app/routes/admin/members/`, `src/app/routes/profile/`
- Admin member list.
- Roles, with last-admin protection.
- Unique `payment_ref`.
- Profile, including `roster_name`.
- **Deactivate** (PLAN §6.7): cancels the member's future RSVPs through the `rsvp.cancel` interface.
- **Tests first:**
  - The 4-role permission matrix, table-driven.
  - The last admin can't be demoted.
  - `payment_ref` stays unique under concurrency.
  - An inactive member gets 403 on events and 200 on their own ledger.
  - Every change is audited.

### S2.3 Club settings: S · W2
- **Depends on:** S0.2, S0.4 · **Owns:** `src/worker/settings/`, `src/app/routes/admin/settings/`
- Bank details, quiet hours, days before an unpaid pass can be revoked, promotion cutoff, defaults, account codes, **`roster_app_url`**. The public subset is exposed at `/config`.
- **Tests first:** admin only; IBAN/bankgiro and URL validation; `/config` never leaks private fields.

### S2.4 Audit-log viewer: S · W3
- **Depends on:** S2.1 · **Owns:** `src/worker/audit/`, `src/app/routes/admin/audit/`
- **Tests first:** members get 403; filters work; pagination is stable.

### S2.5 Privacy: export, erasure, retention: M · W5
- **Depends on:** S2.1, S5.1, S6.2, S1.1 · **Owns:** `src/worker/privacy/`, `src/app/routes/privacy/`
- `/me/export` returns the member's data.
- Erasure (PLAN §16) is gated on a zero balance (or a waiver) and **deletes the Clerk user through the Clerk API**.
- Retention purges run as cron hooks.
- A privacy notice page.
- **Tests first:**
  - After erasure, there is no PII and the Clerk delete was called (mocked).
  - Ledger sums are unchanged.
  - The export covers every PII table (schema-driven).
  - The purge deletes only data past its retention window.

---

## E3: Terms, series, events

### S3.0 Events core: M · W2
- **Depends on:** S0.2, S0.4 · **Owns:** `src/worker/events/` (model, list and detail, slugs), `src/app/routes/events/` (list + detail with **slots**), `src/app/api/events.ts`
- Random slugs of 8+ characters for events and series.
- `by-slug` endpoints, plus `series/…/next`.
- Event page slots: `RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`.
- Calls `publishOg` on every write.
- **Tests first:**
  - Slugs are unique and the right length.
  - `next` skips cancelled and closed events.
  - Past events are read-only.
  - Each slot renders what is registered in it.
  - A pending member sees no attendees.

### S3.1 Terms, series, captains, clone: M · W2
- **Depends on:** S0.2, S0.4 · **Owns:** `src/worker/terms/` (except recurrence), `src/app/routes/admin/terms/`
- Term status machine, series CRUD, captains, clone term, derived `pass_cap`.
- **Tests first:** invalid transitions are rejected; clone copies series without events or passes; captain permissions apply only to their own series.

### S3.2 Recurrence, skip-dates, occurrence edits: M · W3
- **Depends on:** S3.0, S3.1 · **Owns:** `src/domain/recurrence*`, `src/worker/terms/recurrence*`, `src/app/routes/admin/terms/schedule*`
- Weekly generation that is safe across DST changes.
- `rsvp_close_at` is computed in UTC from absolute minutes before start.
- Skip-dates lock at `open_for_passes`.
- An occurrence edit that would push the cap below passes sold is blocked unless overridden.
- **Tests first:**
  - fast-check property: every event lands on the right weekday and local time across both DST shifts.
  - Generation is idempotent and keeps manual edits.
  - The skip-date lock holds.
  - The cap-below-sold block holds.

### S3.3 One-off events: S · W3
- **Depends on:** S3.0 · **Owns:** `src/worker/events/oneoff*`, `src/app/routes/events/new*`
- Member one-offs: free, instant. Admin one-offs: optional fee, tiered with no tier 1.
- **Tests first:** a member can't set a fee or tiered allocation; a pass holder is treated as tier 2 at an admin paid one-off; only the owner, a captain or an admin can edit.

---

## E4: RSVP & allocation (critical path)

### S4.1 Allocation engine (pure TS): M · W1
- **Depends on:** S0.1 · **Owns:** `src/domain/allocation/`
- `allocate` (tiered or instant), `waitlistInsert` (A5), `promote` (with the cutoff, A6).
- **Tests first:**
  - The worked example from PLAN §6.2 with its exact output.
  - A table of waitlist order after close.
  - fast-check properties.
  - Instant allocation is pure first-come.

### S4.2 RSVP pre-close: M · W3
- **Depends on:** S3.0, S4.1 · **Owns:** `src/worker/rsvp/` (pre-close), `src/app/components/rsvp/` (pre-close; fills `RsvpSlot`)
- PUT and DELETE an RSVP, with guests. Tier comes from `isPrepaid` (a fake until S5.3).
- Status shows Confirmed or Requested. Instant mode confirms straight away. Guest stepper.
- Emits `rsvp_changed`.
- **Tests first:**
  - One RSVP per member.
  - The guest limit holds.
  - A cancel before close creates no ledger entries.
  - Instant mode puts people on the waitlist when full.
  - Pending and inactive members are blocked.
  - A double-submitted PUT has a single effect.

### S4.3 Close processing + charges: M · W4
- **Depends on:** S4.2, S5.1, S6.1 · **Owns:** `src/worker/rsvp/close*`
- Implements PLAN §6.3: a row lock with `SKIP LOCKED`, close-on-read capped at 5 events, registered as a cron hook, charges via the ledger, notifications, and an `event_closed` outbox row.
- **Tests first:**
  - Running close twice gives an identical result.
  - Concurrent closes produce one set of charges (Postgres).
  - A member one-off produces no ledger entries.
  - At an admin paid one-off, everyone is charged.
  - Prepaid members are never charged.
  - Each notification is sent once.

### S4.4a Late RSVP, cancel, promotion, refill: M · W5
- **Depends on:** S4.3 · **Owns:** `src/worker/rsvp/postclose*`, `src/app/components/rsvp/postclose*`
- **Tests first:**
  - One test per row of the PLAN §6.4 table.
  - Cancelling while spots are free means the charge stands.
  - With two late cancels and one refill, the earliest cancel is reversed.
  - A host cancel cascades to their guests.
  - A promoted member who then cancels is a late cancel.
  - A guest added after close is tier 3.

### S4.4b Claim-a-spot + capacity changes: S · W5
- **Depends on:** S4.3 · **Owns:** `src/worker/rsvp/claim*`, `src/worker/rsvp/capacity*`, `src/app/components/rsvp/claim*`
- **Tests first:**
  - In a race between two claims, exactly one wins.
  - Lowering capacity below confirmed tier-1 is blocked without an override.
  - The override waitlists the latest prepaid members and notifies them.
  - Raising capacity promotes from the waitlist.

### S4.4c Event cancellation + material changes: S · W5
- **Depends on:** S4.3, S3.2 · **Owns:** `src/worker/rsvp/eventchange*`, `src/app/components/organizer/edit*`
- **Tests first:**
  - Cancelling an event leaves its net charges at 0.
  - A cancel inside the 24h window after a material change is reversed for free; outside it, normal rules apply.
  - Editing the fee of a closed event returns 409.

---

## E5: Passes & money

### S5.1 Ledger core: M · W2
- **Depends on:** S0.2 · **Owns:** `src/domain/ledger/`, `src/worker/ledger/` (service, me-read)
- `charge`, `reverse`, `recordPayment`, `adjust`, `balance`, `itemize` (FIFO allocation, partial payments, credit). Includes the self-ledger guard.
- **Tests first:**
  - fast-check: the balance always equals the sum of entries.
  - FIFO: a partial payment splits correctly; credit is consumed by later charges.
  - Reversing a reversal is refused.
  - Amounts are integers only.
  - The self-ledger guard works: blocked, and flagged when the admin is the only admin.

### S5.2 Member money screen: S · W3
- **Depends on:** S5.1, S2.3 · **Owns:** `src/app/routes/money/` (except passes and claims), `src/app/api/ledger.ts`
- **Tests first (Playwright):**
  - A member sees only their own entries.
  - Items show the event date and guest name.
  - Credit displays correctly.
  - Requesting another member's ledger returns 403.

### S5.3 Passes: offers, cap, proration, revocation: M · W4
- **Depends on:** S3.2, S5.1, S4.2 · **Owns:** `src/domain/proration*`, `src/worker/passes/`, `src/app/routes/money/passes*`
- Implements `isPrepaid`.
- **Tests first:**
  - Proration table, including round half-up, and a pass is not offered when 0 events remain.
  - Two buyers for one remaining seat: exactly one succeeds.
  - Buying a pass upgrades the member's open RSVPs from Requested to Confirmed.
  - Revocation is gated on N days and the pass still being unpaid. It reverses the charge, frees the seat, downgrades the member's RSVPs and notifies them.
  - There is no refund path.

### S5.4 Admin balances, payments, adjustments: M · W3
- **Depends on:** S5.1, S2.1 · **Owns:** `src/worker/ledger/admin*`, `src/app/routes/admin/money/` (except claims and export)
- **Tests first:**
  - Members get 403.
  - A payment updates the balance and the FIFO allocation.
  - A waiver creates a reversal and an audit entry.
  - A double-tapped payment is recorded once.
  - The self-ledger guard applies.

### S5.5 Payment claims ("I've paid"): S · W4
- **Depends on:** S5.2, S5.4, S6.1 · **Owns:** `src/worker/ledger/claims*`, `src/app/routes/money/claims*`, `src/app/routes/admin/money/claims*`
- **Tests first:**
  - A pending claim doesn't change the balance.
  - Confirming creates exactly one payment, even when double-tapped.
  - Rejecting notifies the member with the reason.
  - An admin can't confirm their own claim.

### S5.6 manager.io export: S · W5
- **Depends on:** S5.4, S2.3 · **Owns:** `src/worker/accounting/`, `src/app/routes/admin/money/export*`
- First step: the treasurer confirms the manager.io import format.
- **Tests first:**
  - Golden-file CSV.
  - Totals equal the ledger sum for the period.
  - A second export contains nothing new unless re-export is chosen.

---

## E6: Notifications & reminders

### S6.1 Notification core + inbox + policy chain: M · W2
- **Depends on:** S0.2, S0.4 · **Owns:** `src/worker/notifications/` (core), `src/app/routes/inbox/`, `src/app/api/notifications.ts`
- **Tests first:**
  - `notify` is idempotent.
  - Members see only their own notifications.
  - Deep links resolve to the right screen.
  - A policy can suppress the push while the inbox entry is still written.

### S6.2 Web push from the Worker: M · W3
- **Depends on:** S6.1, S0.3, S0.6 · **Owns:** `src/worker/notifications/push*`, `src/worker/notifications/policies/quiet-hours*`, `src/sw/push*`, plus integrator-sanctioned (2026-11-24): `src/worker/notifications/routes.ts` (one-line mount of the push sub-app)
- VAPID with a WebCrypto encryption library.
- Pushes are sent from a cron hook in **batches** sized per the S0.6 measurement.
- The client re-subscribes on every app open. The service worker always calls `showNotification`.
- 404/410 responses delete the subscription; 5xx responses back off.
- Quiet hours. A push-coverage endpoint.
- **Tests first:**
  - Mocked push service: success, 410, and 5xx with retry.
  - A message held by quiet hours is delivered at 08:00 Stockholm.
  - A batch never exceeds the size cap.
  - The SW handler shows a notification for every payload.

### S6.3 Preferences + mute: S · W3
- **Depends on:** S6.1 · **Owns:** `src/worker/notifications/policies/mute*`, `src/worker/notifications/prefs*`, `src/app/routes/settings/notifications*`, plus integrator-sanctioned (2026-11-24): `src/worker/notifications/routes.ts` (one-line mount of the prefs sub-app)
- **Tests first:** a muted category still writes to the inbox but sends no push; global mute overrides per-category settings; everything is on by default.

### S6.4 Cron Triggers: S · W2
- **Depends on:** S0.2 · **Owns:** `src/worker/scheduler/`, the cron section of `wrangler.jsonc`, `wrangler.jsonc`, plus integrator-sanctioned (2026-11-24): `src/worker/index.ts` (`scheduled()` delegates to the scheduler), `src/worker/ops/wiring.test.ts` (KV cleanup between tests)
- `scheduled()` takes an overlap lock, then reads `next_due_at` from KV. If nothing is due, it never touches Neon. Otherwise it runs the registered hooks within a time bound.
- Pings healthchecks.io. Raises an `admin_tasks` alert when the tick is stale.
- **Tests first:**
  - Nothing due means zero DB queries.
  - Overlapping runs: the second is a no-op.
  - A missed run catches up exactly once.
  - A failing hook is recorded and the other hooks still run.

### S6.5a Reminder rules engine: M · W4
- **Depends on:** S6.3, S6.4, S5.1, S4.2 · **Owns:** `src/domain/reminders/`, `src/worker/reminders/`
- **Tests first (fixed timestamps):**
  - A 500 kr balance from 2027-01-01 with a 90-day rule fires on 01-01 and 04-01, and not in between.
  - Paying below the threshold stops the reminders.
  - The un-RSVPed rule skips members who responded.
  - A muted member gets the inbox entry only.
  - The preview count equals the number actually sent.

### S6.5b Reminder admin UI: S · W5
- **Depends on:** S6.5a · **Owns:** `src/app/routes/admin/reminders/`
- **Tests first:** placeholders render; an unknown placeholder is rejected; members get 403.

### S6.6 Broadcasts: S · W4
- **Depends on:** S6.1 · **Owns:** `src/worker/broadcasts/`, `src/app/routes/admin/broadcast/`
- **Tests first:** audiences resolve correctly (all, pass holders, an event's RSVPs, captains); mute is respected; every broadcast is audited.

---

## E7: Sharing

### S7.1 Share links, edge OG, request-to-join: M · W4
- **Depends on:** S3.0, S4.2, S1.3, S0.6 · **Owns:** `src/worker/share/`, `src/app/components/share/` (fills `ShareSlot`), `src/app/routes/share/`
- `/e` and `/s` pages are built from KV, falling back to Neon and then to a generic page.
- Pages carry `noindex` and a CSP, and show no attendee names.
- The real `publishOg` implementation.
- Share via the Web Share API, with copy as a fallback.
- The sign-in intent is kept. Non-members are offered "request to join".
- **Tests first:**
  - A malicious title is escaped in every OG attribute.
  - A KV miss falls back as expected.
  - An unknown slug shows a friendly 404.
  - Playwright: logged out → email code → RSVP in at most 1 extra tap.
  - Playwright: a non-member sees "request to join".

---

## E8: Attendance & roster hand-off

### S8.1 Attendance marking: S · W5
- **Depends on:** S4.3 · **Owns:** `src/worker/attendance/`, `src/app/components/organizer/attendance*`
- Everyone confirmed defaults to attended. The organizer flips no-shows. Editable for 7 days, then admin only.
- An `admin_tasks` alert fires if attendance is still unmarked 24h after the event. No charges change.
- **Tests first:**
  - A prepaid no-show changes nothing.
  - A non-prepaid no-show's charge stands.
  - Permissions are enforced.
  - The 7-day lock holds.

### S8.2 Member attendance & "why" history: S · W6
- **Depends on:** S8.1, S5.2 · **Owns:** `src/app/routes/me/attendance*`, `src/worker/attendance/me*`
- **Tests first:** every ledger row tied to an event links to the history and back, in both directions.

### S8.3 Roster deep link (club side): S · W5
- **Depends on:** S4.3, S2.3 · **Owns:** `src/domain/roster-link/`, `src/worker/events/roster-link*`, `src/app/components/organizer/roster*`, `contracts/roster-import-v1/` (copy of the fixtures)
- Builds the `roster-import/v1` URL (PLAN §8.1) from confirmed members and guests.
- An "Open in roster generator" button for organizers, captains and admins. A "Copy list" fallback.
- Hidden when `roster_app_url` is unset.
- **Tests first:**
  - Output matches the golden fixtures byte for byte, after decoding.
  - `short` uses `roster_name`, falling back to the first name.
  - Guests are flagged.
  - Ordering is by tier, then confirmation time.
  - A 30-player event stays under 2,000 characters.
  - Members can't see the button; it is hidden when the URL is unset.

### R1 Roster import sheet (in `BOLT-IF/roster-generator`): M · W1
- **Depends on:** none (the contract in PLAN §8.1) · **Owns (roster repo):** `frontend/src/components/ClubImport*`, `frontend/src/lib/clubImport.js`, an additive hook in `frontend/src/hooks/usePlannerState.js`, `contracts/roster-import-v1/` (**canonical fixtures**), `frontend/tests/club-import.spec.*`
- On `/planner#import=…`: decode, validate, and open an "Import from club event" sheet.
  - Match players to the directory by short name, then full name, ignoring case.
  - Unmatched players get "Add to directory", with guests labelled.
  - Confirm before replacing an unsaved draft.
  - Clear the URL fragment after import.
- **Tests first:**
  - The golden fixtures import correctly.
  - Malformed data, oversized data or an unknown `v` shows a banner and the planner still works.
  - Reloading after import doesn't re-import.
  - Unmatched players can be added.
  - The existing planner Playwright suite stays green.

---

## E9: Polls

### S9.1 Polls: M · W4
- **Depends on:** S6.1, S6.4 · **Owns:** `src/worker/polls/`, `src/app/routes/polls/`
- **Tests first:**
  - Single- and multi-choice rules are enforced.
  - Voting after close is rejected.
  - Anonymous polls never reveal voters (sweep every endpoint).
  - Visibility modes behave as set.

### S9.2 Image options on R2: S · W5
- **Depends on:** S9.1 · **Owns:** `src/worker/media/`, `src/app/components/ImagePicker*`
- Images are resized on the client to ≤ 300 KB. The server checks the real file type, allows at most 8 per poll, and stores them in R2.
- `/media/{key}` serves images to members only, with cache headers.
- A purge cron hook removes images 6 months after the poll closes.
- **Tests first:**
  - Non-images and oversized files are rejected.
  - Members only.
  - The purge deletes only expired images (R2 mocked via Miniflare).
  - Playwright: voting on a poll with images on mobile.

---

## E10: Experience

### S10.1 Home dashboard: S · W6
- **Depends on:** S4.4a, S5.5, S9.1 · **Owns:** `src/app/routes/home/`
- **Tests first:** explicit assertions for four fixtures: a new member, a prepaid member, a member who owes money with a pending claim, and an admin with tasks.

### S10.2 Install & push onboarding: S · W4
- **Depends on:** S6.2, S0.3 · **Owns:** `src/app/components/install/`
- **Tests first:** a user-agent matrix decides which prompt shows; no permission request on first load; no re-ask after a decline.

---

## E11: Launch

### S11.1 Club-week scenarios: M · W7
- **Depends on:** all functional stories · **Owns:** `tests/scenarios/`, `tests/e2e/club-week*`
- The integrator agent starts this from W2 and grows it every wave.
- It runs a full term end to end:
  1. Term setup, captains, passes, and one revocation.
  2. Series events, plus admin-paid and member one-offs.
  3. RSVPs and guests, close, late cancels and refills.
  4. A material change.
  5. Attendance and the roster deep link.
  6. Claims and payments, reminders, a poll, and the manager.io export.
- The final ledger is asserted line by line.

### S11.2 Member import with opening balances: S · W6
- **Depends on:** S2.1, S5.1 · **Owns:** `src/worker/importer/`
- Imported members are pre-provisioned as members without a Clerk link. The link is made on first sign-in, matched by verified email.
- **Tests first:**
  - Balances import exactly.
  - Re-running the import is idempotent.
  - Malformed rows are reported with no partial import.
  - First sign-in links to the imported member, not a duplicate.

### S11.3 Device QA & launch checklist (a checklist, not tests): S · W8
- **Depends on:** S11.1, S10.2 · **Owns:** `docs/LAUNCH.md`
- A real-device matrix covering installation, push, WhatsApp previews, Clerk sign-in and the roster deep link.
- Lighthouse, a restore drill, and a free-tier budget check.
- Rollout per PLAN §14.

---

## Execution protocol
1. **Contracts first.** W0 and W1 merge before W2 starts. After that, the schema, interfaces, registries and dependencies change only through a "contract change" PR reviewed by the integrator/root agent.
2. **Branching:** merge to main behind flags. Stack PRs only on a single parent.
3. **Migrations:** one initial migration. Any later change goes through the integrator queue, and CI enforces a single migration chain.
4. **After each wave:** the integrator runs the full suite plus Playwright and grows S11.1.
5. **Model tiering:** cheaper models for mechanical stories (S0.7, S2.4, S6.6, S6.5b). High effort for S0.2, all of E4 and all of E5.
6. **Human gates:**
   - S0.6 needs real devices and the domain.
   - S5.6 needs the treasurer.
   - S11.3 is done on real devices.
   - R1 is a PR to the roster repo.
7. **Cross-repo:** R1 owns the canonical `roster-import/v1` fixtures. S8.3 copies them. Any schema change bumps `v` and lands in both repos.

## Traceability
| Requirement / decision | Stories |
|---|---|
| PWA Android + iOS | S0.3, S0.4, S0.6, S6.2, S10.2, S11.3 |
| 1. Roles (+ captains) | S0.2, S1.1, S1.3, S2.1, S3.1 |
| 2. Member sessions, RSVP, guests | S3.3, S4.2, S4.4a |
| 3. Series, prepay, ad-hoc fee | S3.1, S3.2, S5.3, S4.3 |
| 4. Owed, bank transfer, paid/pending | S5.1, S5.2, S5.4, S5.5 |
| 5. Attendance and why | S8.1, S8.2, S5.2 |
| 6. Roster: separate app, deep link | S8.3, R1 |
| 7. One WhatsApp link | S3.0, S7.1, S0.6 |
| 8. Reminders, mute, frequency | S6.3, S6.4, S6.5a/b, S6.6 |
| 9. Polls + images | S9.1, S9.2 |
| Bookkeeping (manager.io) | S5.6 |
| Privacy / 7-year retention | S2.5 |
| Free-tier ops | S0.5, S0.7, S6.4 |

**Total: 12 epics, 48 stories (47 in bolt-club-hq + R1 in roster-generator). Critical path 9.**
