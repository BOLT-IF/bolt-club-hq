# Session handoff — 2026-11-24 (afternoon)

Status of the parallel build of `docs/STORIES.md` (48 stories). Read this, then `docs/STORIES.md`, `docs/DECISIONS.md` (newest first) and `docs/PLAN.md` before continuing. Area docs live in `docs/areas/`. Update this file at the end of every session.

## Where things stand

- **W0, W1 and W2 are done. Most of W3 and part of W4 are done or in final landing.** 29 of 48 stories have code on `main` or in a PR (table below).
- **The session ended on budget, not on a blocker.** The last integrator loop was landing the PRs marked "landing". Run `gh pr list --state open` first. An open PR is either green and only needs the gated merge, or needs `git merge origin/main` and a re-run (see "Finishing open PRs").
- **No feature flag is on.** `FLAG_EVENTS`, `FLAG_MONEY` and `FLAG_INBOX` in `wrangler.jsonc` are all "off", and `FLAG_POLLS` does not exist yet. Flip them in one integrator chore PR once the open PRs are merged.
- **Deploy still skips** (no Cloudflare secrets), so nothing has run against production.

## Story status

**merged** = on `main`. **landing** = PR open, green or one `git merge origin/main` away from green. **partial** = PR open, work incomplete.

| Story | State | PR | Notes for the next agent |
|---|---|---|---|
| R1, S0.1–S0.5, S0.7, S4.1, S0.2 | merged | #2–#12, roster#53 | W0/W1. |
| S0.6 device spike | **not started** | – | Human: Clerk prod instance + real iPhone/Android. Push batch cap (20) and the Google-in-installed-iOS rule are provisional until it runs. |
| S1.1 Clerk | merged | #34 | Needs secrets (Ashok's queue). Origin guard is a `use("*")` in `auth/routes.ts`; move it to `app.ts`. |
| S1.3 Invites, join, approval | landing | #47 | RSVP intent completed client-side (`bcq.join-rsvp-intent`). |
| S2.1 Members | merged | #30 | `noopRsvpCancel` still wired (see follow-ups). |
| S2.3 Settings | merged | #27 | Public subset at `GET /settings/public` (members), not `/config`. |
| S2.4 Audit viewer | merged | #41 | |
| S2.5 Privacy | not started | – | All deps merged or landing. |
| S3.0 Events core | merged | #28 | Slot registry: `src/app/routes/events/slots`. |
| S3.1 Terms, series | merged | #31 | Captains cannot edit capacity (decision). |
| S3.2 Recurrence | landing | #45 | Needs the "Schedule and occurrences" link (follow-ups). |
| S3.3 One-offs | landing | #38 | S4.2 must use `rsvpTier` (follow-ups). |
| S4.2 RSVP pre-close | landing | #40 | Was CONFLICTING at hand-off: merge main and re-run. Prepaid is `nobodyPrepaid` until S5.3. |
| S4.3 Close + charges | not started | – | **Next on the critical path.** Use `registerTickHook` + `markDue(ctx.kv, rsvp_close_at)`. |
| S4.4a/b/c | not started | – | After S4.3. Their Owns already include the slot-import line in `events/routes.tsx`. |
| S5.1 Ledger | merged | #36 | |
| S5.2 Member money | landing | #44 | |
| S5.3 Passes | not started | – | Implements `isPrepaid`; replace `nobodyPrepaid` via `configureRsvpDeps({ prepaid })`. |
| S5.4 Admin money | merged | #43 | Exports `LEDGER_ERROR_STATUS`. |
| S5.5 Claims | **partial** | #50 | API and db tests done. **Screens not built** (`src/app/routes/money/claims*`, `src/app/routes/admin/money/claims*`). `docs/areas/ledger.md` lacks the claim routes. Finish on the same branch or a follow-up story PR. |
| S5.6 manager.io export | not started | – | Treasurer must confirm the import format first. |
| S6.1 Notifications | merged | #26 | |
| S6.2 Web push | landing | #39 | The `notifications/routes.ts` conflict with S6.3 is resolved (both mounts kept). Needs VAPID secrets. |
| S6.3 Prefs + mute | merged | #33 | |
| S6.4 Cron, scheduler | merged | #29 | |
| S6.5a Reminder engine | **landing, unverified** | #48 | Needs `TickContext.kv` (#46). Tests and code are in one commit and the db tests have not run yet. Lint may flag a spread in the test helper. |
| S6.5b Reminder UI | not started | – | Uses S6.5a's API (`/admin/reminder-rules`, preview, placeholder list). |
| S6.6 Broadcasts | merged | #35 | |
| S7.1 Share/OG | not started | – | Must call `configureEventsDeps({ publishOg })` and remove the no-op. |
| S8.1, S8.2, S8.3 | not started | – | After S4.3. |
| S9.1 Polls | landing | #42 | Ships migration `0001_polls` (approved by Ashok). |
| S9.2 Images (R2) | not started | – | After S9.1. |
| S10.1 Home | not started | – | After S4.4a, S5.5, S9.1. May take over `<InstallPrompt/>` from `AppShell`. |
| S10.2 Install, push onboarding | landing | #49 | Needs #46 (Owns grant) and #39 (`push-client.ts`) on main, then merge main and re-run. |
| S11.1 Club-week scenarios | not started | – | The integrator should start growing it now. |
| S11.2 Member import | not started | – | Deps (S2.1, S5.1) are merged; can start any time. |
| S11.3 Launch checklist | not started | – | Last. |

Integrator/contract PRs this session: #24, #25, #37 merged. #46 (`TickContext.kv`, Owns grants for S5.5 and S10.2) is landing. #32 was closed and superseded by #37.

## Finishing open PRs (do this first)

Order: #46, #40, #39, #38, #44, #45, #42, #47, #48, #50, #49.

1. `git fetch origin`. If `origin/main` has commits the branch lacks, merge main in a temp worktree (`git worktree add --detach .worktrunk/land-N origin/<branch>`, `git merge origin/main`, push to `<branch>`). `docs/DECISIONS.md` merges itself (`merge=union`). Any other conflict needs a real look; two one-line mounts in the same `routes.ts` means keep both.
2. `gh pr checks N --watch --fail-fast`, then merge only if every check is SUCCESS: `gh pr checks N --json state --jq '[.[].state]|unique|join(",")' | grep -qx SUCCESS && gh pr merge N --squash`.
3. If only "Install Playwright browsers" failed on one shard: `gh run rerun <run-id> --failed`.

## Integrator follow-ups (one chore PR is fine)

Small wiring that stories could not do inside their Owns:

- **Links:**
  - "New event" on `EventListPage.tsx` → `/events/new` (S3.3).
  - "Schedule and occurrences" on `admin/terms/SeriesPage.tsx` → `/admin/terms/series/:id/schedule` (S3.2).
  - Claims links on `MoneyPage.tsx` and `AdminBalances.tsx`, once the S5.5 screens exist.
  - "Request to join" on the event page's 403 state → `/join/event/<slug>` (S1.3; may overlap S7.1).
- **Shell wiring:** call `completeJoinRsvpIntent()` (`src/app/routes/join/joinIntent.ts`) from `AppRoot.tsx`; add the inbox unread badge (`badges.inbox`; the API returns `unreadCount`); call `unsubscribePush()` on sign-out (S10.2 already re-subscribes on open).
- **RSVP:**
  - Call `noteRsvpSaved()` (`src/app/components/install/`) in `RsvpPanel` after a successful save.
  - Make S4.2 use `rsvpTier` from `src/worker/events/oneoff-rules.ts`, so pass holders aren't tier 1 at one-offs.
  - Wire `configureRsvpCancel(rsvpCancelAdapter(db, clock))` so deactivating a member cancels their RSVPs. S2.1's port has no db parameter, so this needs per-request wiring or a port change.
- **Inactive members:** add `allowInactive: true` to `GET /settings/public` and `GET /me/profile` so exited members can see how to pay.
- **Flags:** flip `FLAG_EVENTS`, `FLAG_MONEY` and `FLAG_INBOX`; add `FLAG_POLLS` to `wrangler.jsonc` and `worker-configuration.d.ts`.
- **Cleanup:**
  - Remove the S0.1 probe route and its route-guard allowlist entry.
  - Align the frequent window in `src/worker/ops/health.ts` with `scheduler/schedule.ts`.
  - Fold the series slug generator in `terms/routes.ts` into S3.0's `slugs.ts`.
  - Optional migration-queue items: a unique index on `rsvp(event_id, member_id)` and an index on `audit_log(at desc, id desc)`.

## Repo settings (GitHub)

- Squash merge only. Branches auto-delete on merge.
- **No branch protection** (it needs GitHub Pro on a private repo). "Merge only on green" is a working agreement, not a gate.
- No workflow waits for manual approval. The `production` environment has **no** required reviewer.
- No GitHub secrets or variables are set yet.
- `docs/DECISIONS.md` uses `merge=union` (`.gitattributes`).

## Production state

- **Neon:** live, PostgreSQL 18.7 (project `autumn-term-77415320`, branch `production`, database `neondb`). The connection string is in `.env.local` (gitignored; never commit it). This machine reaches Neon only over HTTPS.
- **Local Postgres:** `~/.rd/bin/docker compose up -d postgres` (Postgres 18.7, database `club_test`).
- **Migrations:** `0000_initial` and `0001_polls` (once #42 merges). Deploy runs `drizzle-kit migrate`.
- **Cloudflare:** the KV, R2 and Hyperdrive ids in `wrangler.jsonc` are still `REPLACE_WITH_*`.

## Ashok's queue

1. Cloudflare API token + account ID → GitHub secrets; create real KV, R2 and Hyperdrive; replace the `REPLACE_WITH_*` ids.
2. Decide on a required reviewer for the `production` environment **before** adding deploy secrets.
3. GitHub secrets: `DATABASE_URL`, `RESTORE_TARGET_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_BUCKET_TOKEN`, `LHCI_TARGET_URL`. Repo variable `PUBLIC_BASE_URL`. **Build variable `VITE_CLERK_PUBLISHABLE_KEY`.** See `docs/ops/secrets.md`.
4. Worker secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `BOOTSTRAP_ADMIN_EMAIL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (back them up; never rotate casually), `HEALTHCHECK_PING_URL` (healthchecks.io, ~1 h period), `SENTRY_DSN`.
5. Off-site backup store (90-day retention).
6. Clerk production instance + the S0.6 device spike.
7. Treasurer: confirm the manager.io import format (S5.6) and the provisional account-code keys (`pass`, `adhoc`, `guest`, `payment`).
8. GitHub Pro, if "merge only on green" should be enforced.
9. Rotate the Neon password eventually.

## Open technical follow-ups

- **Vitest pool:** `@cloudflare/vitest-pool-workers` 0.23 is deprecated (now `@cloudflare/vitest-plugin`). Migrating may let the db suites back into the Worker pool.
- **`worker-configuration.d.ts`:** hand-edited for the `FLAG_*` vars. A `wrangler types` refresh rewrites 28k lines; do it alone in its own PR.
- Done this session: stale idempotency-claim cleanup and the winter cron window (both S6.4).

## How this session worked (keep doing it)

- **Request context:** in `src/worker/core/context.ts`, an area mounts `contextMiddleware()` on **its own paths only** (never `use("*")`) and reads `c.var.db`, `c.var.clock` and `c.var.actor`. Postgres-backed tests are `*.db.test.ts` (db project, CI only).
- **Frontend routes:** any `src/app/routes/**/routes.tsx`, exporting one route or an array, with `:param` paths and `useRouteParams()`.
- **Owns:**
  - A trailing `*` is a prefix match. `docs/areas/` and `tests/e2e/` are shared.
  - When a story needs one line elsewhere (a route mount in another area's `routes.ts`, a slot import), the integrator adds it to that story's Owns line in a contract PR.
  - UI links on other stories' pages are integrator follow-ups, not grants.
- **Tick hooks** get `{ db, clock, now, cron, kv }`. Use `markDue(kv, at)` for the next wake-up.
- **Worker brief:** `.worktrunk/WORKER-BRIEF.md` (local, git-ignored). Sub-agents cannot read the root session folder, so keep the brief inside the repo.

## Environment / infra recipes (this machine is hostile)

- **Worktrees:** `git worktree add .worktrunk/<slug> -b story/<id>-<slug> origin/main`. Symlink `node_modules` (`ln -s ../../node_modules node_modules`) and remove the link before every commit. `npm ci` fails here.
- **Local tests:** typecheck, lint and the `domain`, `worker` and `ui` Vitest projects run (escalated). The `db` project only runs in CI (`pg` can't be installed). Locally, typecheck errors in `db/client.ts`, `test-support/database.ts` and `migration.test.ts` are expected.
- **Dependencies:** never install locally. Use a `deps/<slug>` branch and the lockfile bot.
- **Commits:** Ashok approved **unsigned** commits for this run (`git -c commit.gpgsign=false commit`) because the 1Password agent kept failing. Ask before assuming that still holds.
- **GitHub CLI:** `gh` needs escalated permissions.
- **Auto-reviewer:** it blocks pushes, PR creation and merges it can't tie to an explicit approval, even with standing approvals. What worked:
  - One visible command per action, with the exact approval quoted in the justification.
  - No unseen helper scripts for merges.
  - Never `reset --hard` or force-remove a worktree without first showing it is clean.

  Sub-agents get blocked more often; let them hand "push <branch>" back to root. Consider Full Access for the next fan-out.
- **Sonnet is no longer allowed** on this account (403 "model not allowed"). Spawn workers on the inherited model.
- **Playwright CI:** the browser install flakes; run `gh run rerun <id> --failed`.

## Working agreements (from Ashok)

- The orchestrator decides with maximum autonomy. Merge on green (squash), with no per-PR asking where the reviewer allows it.
- Tests first, one story per PR, Owns paths only, decisions logged in DECISIONS.md (newest first).
- Turn repeat work into reusable scripts. This session's merge loop is the "Finishing open PRs" recipe above.
