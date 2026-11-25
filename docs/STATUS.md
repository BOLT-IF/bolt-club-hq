# BOLT HQ: handoff and how to resume

Last updated 2026-11-25. **46 of 48 stories are on `main` (all non-blocked stories complete; 2 human-blocked: `S0.6`, `S5.6`).** Read this file top to bottom, then `docs/STORIES.md`, `docs/DECISIONS.md` (newest first) and `docs/PLAN.md`. Update this file at the end of every session.

## Resume prompt (copy and paste this to a new agent)

> You are the integrator (root agent) for the BOLT HQ build in `BOLT-IF/bolt-club-hq`. Read `docs/STATUS.md`, `docs/FOLLOWUPS.md`, `docs/WORKER-BRIEF.md`, `AGENTS.md`, `docs/STORIES.md` and the top of `docs/DECISIONS.md`. Then carry on delivery as the "Next steps" section says: check any open PRs first, then fan out the stories in the "Not started" table in dependency order, at most 2 stories at a time to avoid PR rebase churn, one story per PR on `story/<id>-<slug>` branches. Give each worker `docs/WORKER-BRIEF.md` and have it stop after pushing to its PR and running local checks (do not wait on CI inside the worker). As orchestrator, check CI status, merge each PR to `main` only when every GitHub Actions check is SUCCESS (ignore Cloudflare's "Workers Builds" check), and spawn a fix subagent if a PR fails CI. Ask me only for the human-only items in "Needs Ashok". Tick items in `docs/FOLLOWUPS.md` as you finish them and add any new ones your agents report. When you stop, update `docs/STATUS.md`.

## What is built (all on `main`)

| Area | Stories | State |
|---|---|---|
| Foundations | R1 roster import, S0.1–S0.5, S0.7 | merged: repo, CI, deploy workflow, PWA, UI kit, observability, schema, core contracts |
| Identity | S1.1 Clerk sign-in, S1.3 invites and approval | merged |
| Members | S2.1 members and roles, S2.3 club settings, S2.4 audit viewer, S2.5 privacy (#61) | merged |
| Events | S3.0 events core, S3.1 terms and series, S3.2 recurrence, S3.3 one-off events | merged |
| RSVP | S4.1 allocation engine, S4.2 RSVP before close, S4.3 close processing (#59), S4.4a post-close RSVP/cancel/refill (#63), S4.4b claim-a-spot & capacity (#67), S4.4c event cancel & material changes (#66) | merged |
| Money | S5.1 ledger, S5.2 member money screen, S5.3 passes (#60), S5.4 admin money, S5.5 payment claims & screens (#57) | merged |
| Notifications | S6.1 inbox and policies, S6.2 web push, S6.3 preferences and mute, S6.4 scheduler, S6.5a reminder engine, S6.5b reminder UI (#56), S6.6 broadcasts | merged |
| Attendance | S8.1 attendance marking (#65), S8.2 member attendance history (#68), S8.3 roster deep link (#69) | merged |
| Polls and install | S9.1 polls, S9.2 poll images on R2 (#62), S10.1 home dashboard (#70), S10.2 install and push onboarding | merged |
| Sharing | S7.1 share links, edge OG, request-to-join (#71) | merged |
| Brand and deploy | BOLT HQ theme, logo icons, KV/Hyperdrive/R2 config (#53), unslop UI polish (#64), deploy.yml migrate-only (#72) | merged |
| Integrator & import | Chore follow-up wiring (#55), S11.2 member import (#58), S11.1 club-week scenarios (#74), S11.3 launch checklist (#73) | merged |

Two migrations exist: `0000_initial` and `0001_polls`. Neither has been applied to Neon yet.

## In progress

None.

## Not started (2 human-blocked)

| Story | Size | Needs | Owns (summary) |
|---|---|---|---|
| S5.6 manager.io export | S | S5.4, S2.3 (met) | `src/worker/accounting/`, `src/app/routes/admin/money/export*`. **Blocked on the treasurer confirming the import format** |
| **S0.6 Real-device spike** | M | human | Needs a Clerk production instance and a real iPhone and Android. Until it runs, the push batch cap (20) and "hide Google sign-in in the installed iOS app" are provisional |

## Next steps (do these first)

**Every follow-up the earlier agents reported is in `docs/FOLLOWUPS.md`** (sections A to F, with an owner for each). The list below is the short version.

1. **Integrator follow-up chore PR** (one PR). These are small things the stories could not do inside their Owns:
   - **Links:** "New event" on `EventListPage.tsx` to `/events/new`; "Schedule and occurrences" on `admin/terms/SeriesPage.tsx` to `/admin/terms/series/:id/schedule`; claims links on `MoneyPage.tsx` and `AdminBalances.tsx` once the S5.5 screens exist; "Request to join" on the event page's 403 state to `/join/event/<slug>` (may overlap S7.1).
   - **Shell wiring:** call `completeJoinRsvpIntent()` (`src/app/routes/join/joinIntent.ts`) from `AppRoot.tsx`; add the inbox unread badge (`badges.inbox`; the API returns `unreadCount`); call `unsubscribePush()` on sign-out.
   - **RSVP:** call `noteRsvpSaved()` (`src/app/components/install/`) in `RsvpPanel` after a successful save; make S4.2 use `rsvpTier` from `src/worker/events/oneoff-rules.ts` (pass holders must not be tier 1 at one-offs); wire `configureRsvpCancel(rsvpCancelAdapter(db, clock))` so deactivating a member cancels their RSVPs (S2.1's port has no db parameter, so this needs per-request wiring or a port change).
   - **Inactive members:** add `allowInactive: true` to `GET /settings/public` and `GET /me/profile`, so exited members can see how to pay.
   - **Cleanup:** remove the S0.1 probe route and its allowlist entry in the route-guard test; align the frequent window in `src/worker/ops/health.ts` with `scheduler/schedule.ts`; fold the series slug generator in `terms/routes.ts` into S3.0's `slugs.ts`; move the Clerk origin guard from `auth/routes.ts` to `app.ts`. Optional migration-queue items: unique index `rsvp(event_id, member_id)` and an index `audit_log(at desc, id desc)`.
   - **Flags:** do this last, only after the site works end to end (see "Needs Ashok").
2. **Fan out the stories** above.
3. **Update `docs/STATUS.md`** at the end of every session.

## Needs Ashok (human-only: ask, don't guess)

The site is live at **https://bolt-club-hq.bashok001.workers.dev** but cannot be used yet:

1. **Neon tables.** The database is empty. Rotate the Neon password first (the old one passed through chat and the repo is public). Then either add the new connection string as the `DATABASE_URL` GitHub repo secret (the deploy workflow then runs `npx drizzle-kit migrate` on the next merge), or get an explicit OK to run the migration from the laptop. Raw port 5432 is blocked from the laptop, so only Neon's HTTPS route works there.
2. **Sign-in.** Cloudflare Worker secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `BOOTSTRAP_ADMIN_EMAIL`. Build variable in the Cloudflare build settings: `VITE_CLERK_PUBLISHABLE_KEY` (needed at build time, so trigger a rebuild afterwards). Set the app name in the Clerk dashboard to BOLT HQ.
3. **Flags.** Set `FLAG_EVENTS`, `FLAG_MONEY`, `FLAG_INBOX` to "on" in `wrangler.jsonc` once sign-in works. Add `FLAG_POLLS` to `wrangler.jsonc` and `worker-configuration.d.ts` first (it does not exist yet).
4. **Push and health.** Secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (back them up; never rotate casually) and `HEALTHCHECK_PING_URL` (a healthchecks.io check with about a 1 hour period). Optional `SENTRY_DSN`.
5. **GitHub secrets** (`deploy.yml` was simplified in #72 so only `DATABASE_URL` secret + `PUBLIC_BASE_URL` repo variable are needed for `deploy.yml`; `RESTORE_TARGET_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_BUCKET_TOKEN`, `LHCI_TARGET_URL` are for the backup/restore/Lighthouse workflows). See `docs/ops/secrets.md` and `docs/LAUNCH.md`. Decide on a required reviewer for the `production` environment before adding `DATABASE_URL`.
6. **S0.6 device spike:** a Clerk production instance and real iPhone and Android devices.
7. **Treasurer:** confirm the manager.io import format (S5.6) and the provisional account-code keys (`pass`, `adhoc`, `guest`, `payment`).
8. **Off-site backup store** with 90-day retention (GitHub artifacts keep only 30).
9. Optional: GitHub Pro, so "merge only on green" becomes a real rule instead of a convention.

## Production state

- **Site:** https://bolt-club-hq.bashok001.workers.dev (Cloudflare Worker `bolt-club-hq`, account `440a16d9fbe436e7133d5985ebd2a492`). Cloudflare Workers Builds builds it from GitHub `main`; every merge to `main` redeploys.
- **Resources (all created, ids in `wrangler.jsonc`):** KV namespace `KV` plus a preview namespace, Hyperdrive `bolt-club-hq` pointing at Neon, R2 bucket `bolt-club-hq-media`.
- **Health:** `/healthz` returns 200. `/healthz/ready` returns 503 ("degraded") until the Neon tables exist and a cron tick has run. That is expected for now.
- **Neon:** PostgreSQL 18.7 (project `autumn-term-77415320`, branch `production`, database `neondb`), empty. The connection string is in `.env.local` (gitignored; never commit it).
- **Brand:** the app is **BOLT HQ**, the club is **BOLT IF** (always upper case). Palette from the logo: orange `#fd8d27` actions with dark text, amber `#febe1d` highlights, burnt orange `#a63406` links, slate `#272e38` chrome. Tokens are in `src/app/components/ui/ui.css`.
- **CI:** GitHub Actions. The repo is public, which keeps Actions free; while it was private a "payments failed" block stopped every job. Cloudflare's own "Workers Builds" check also runs on PRs. It is not a GitHub Actions check, it failed while the config had placeholder ids, and it passes on `main` now.
- **GitHub settings:** squash merge only, branches auto-delete on merge, no branch protection (it needs GitHub Pro on a private repo, and "merge on green" is an agreement), no workflow waits for a manual approval, and `production` has no required reviewer.

## Rules learned the hard way (keep following them)

- **Contracts:** an area mounts `contextMiddleware()` on its own paths only, never `use("*")`. Exited members on own-data routes use `requireGuard("member", { allowInactive: true })`. A trailing `*` in an Owns entry is a prefix match. `docs/areas/` and `tests/e2e/` are shared. `docs/DECISIONS.md` merges with `merge=union`.
- **Owns exceptions:** one line elsewhere (a route mount, a slot import) is added to the story's Owns line in a contract PR. UI links on other stories' pages are integrator follow-ups, not grants.
- **Landing a PR:** one visible command per merge: `gh pr checks N --json state --jq '[.[].state]|unique|join(",")' | grep -qx SUCCESS && gh pr merge N --squash`. If GitHub says the branch is out of date, merge `origin/main` into the story branch in a temp worktree (`git worktree add --detach .worktrunk/land-N origin/<branch>`, `git merge origin/main`, push to `<branch>`), then wait for CI again. To rerun a failed job: `gh run rerun <id> --failed` (the Playwright browser install flakes).
- **Auto-reviewer:** it blocks pushes, PR creation and merges it can't tie to an explicit approval, even when a standing one exists. What works: one visible command per action, the exact approval quoted in the justification, no unseen helper scripts for merges, and never a `reset --hard` or force-removal of a worktree without first showing it is clean. When a sub-agent is blocked, it commits locally and asks the integrator to push. Ask Ashok for Full Access at the start of a long fan-out; it removes most of these prompts.
- **Commits** are unsigned (`git -c commit.gpgsign=false commit`); the 1Password SSH agent keeps failing here.
- **Models:** the Sonnet override returns 403 "model not allowed" on this account; spawn workers on the inherited model.
- **Machine quirks:**
  - `npm ci` fails (the PayPal mirror blocks some packages). `pg` was installed by hand with `npm install --no-save --registry https://registry.npmjs.org/ pg @types/pg`.
  - Worktrees go under `.worktrunk/` with a symlinked `node_modules`; remove the link before each commit.
  - The `db` tests need Postgres: `~/.rd/bin/docker compose up -d postgres`.
  - `gh` and `git` need escalated permissions in the sandbox.
  - Dependencies change only on a `deps/<slug>` branch, through the lockfile bot.
- **Process:** tests first, one story per PR, Owns paths only, decisions logged at the top of `docs/DECISIONS.md`, money in whole kronor, time via `Clock`.

## Decisions Ashok made

- Merge on green CI (squash) without asking per PR; the integrator decides the order. Story agents may push `story/*` branches and open PRs. Unsigned commits are fine. Contract fixes and one-line Owns grants may go through without a question each time.
- The polls migration `0001` was approved; later migrations need his OK.
- Naming: BOLT HQ for the app, BOLT IF for the club.
- He wants direct, opinionated recommendations and works Stockholm hours.
