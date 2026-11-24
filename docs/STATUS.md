# Session handoff — 2026-11-24 (morning)

Status of the parallel build run of `docs/STORIES.md` (48 stories). Read this, then `docs/STORIES.md`, `docs/DECISIONS.md` and `docs/PLAN.md` before continuing. This file is a living record: update it at the end of each session.

## Where things stand

- **W0 and W1 are done.** Every story PR and every integrator PR through #22 is merged. No PRs are open.
- **`main` is clean and green.** Only `main` exists on GitHub; locally there are no other branches or worktrees. CI is green (re-run a shard if the browser download flakes, see recipes). Deploy is green because it skips cleanly until the deploy secrets exist.
- **Next up: W2** (all unblocked by S0.2): S1.1 (Clerk), S2.1, S2.3, S3.0, S3.1, S5.1, S6.1, S6.4. Fan out in parallel worktrees (recipe below). Then W3–W8 per the `docs/STORIES.md` wave table.
- **S0.6 device spike:** blocked on Ashok (Clerk production instance, real iPhone + Android). Domain `boltif.eu` is already on Cloudflare.

## Completed and merged (W0, W1)

| Story | PR | Notes |
|---|---|---|
| R1 roster import (roster-generator repo) | BOLT-IF/roster-generator#53 | Deep-link import sheet, 11 tests + full suites green. |
| S0.1 repo scaffold | #2 | One Worker, Hono, Drizzle, Playwright ×3 device projects. |
| S0.4 frontend foundation | #7 | UI kit, apiFetch, nav and route registries, axe-clean. |
| S0.7 observability | #5 | Readiness check, request IDs, fetch-based Sentry reporters. Wired into the Worker by #16. |
| S0.5 CI/deploy/ops | #8 | Sharded Playwright ×4, Owns and migration checks, deploy/backup/drill/Lighthouse workflows. Secrets gate fixed by #20. |
| S4.1 allocation engine | #6 | Pure TS, 42 tests + 11 fast-check properties. |
| S0.3 PWA + service worker | #9 | Update-prompt test fakes the waiting state (SW updates are same-origin only). |
| S0.2 core contracts + schema | #12 | 26 tables, append-only ledger trigger, core services, 4 DB suites against real Postgres. |

Integrator PRs: #1 CI bootstrap, #3 R1 decision log, #4 allowScripts, #10/#11 tarball relay (added, then removed), #13 handoff, #14 vite lint fix.

**Repo audit (2026-11-23/24), all merged** (details in DECISIONS):

| PR | What |
|---|---|
| #15 | Cleanup: one Clock, dead files and doc duplicates removed, lockfile bot on `deps/**` only, test-DB teardown flake fixed. |
| #16 | `/healthz` = liveness (always 200); `/healthz/ready` = strict DB + cron tick + queue (503 when degraded). `scheduled()` records the tick and runs cron hooks. Request IDs on every route; uncaught errors go to Sentry. |
| #17 | `/api/v1/config` serves `FLAG_<AREA>` flags from `wrangler.jsonc`. Events, Money and Inbox start **off**; each area's story flips its flag on. |
| #18 | Idempotency middleware claims the key before running the handler (a concurrent double-tap runs it once; the loser gets 409). |
| #19 | Dependency trim: toucan-js, msw, workers-types removed; `@types/pg` replaces the hand-written typings. |
| #20 | Secrets gate writes `ready=true\|false`; workflows gate on it, so Deploy/backup/drill/Lighthouse skip green instead of failing. `.gitignore` ignores `.neon`. |
| #21 | Postgres 18 everywhere (docker-compose, CI services, backup/restore clients) to match Neon. |
| #22 | Lockfile bot starts CI itself after its push, so its PRs never wait for a manual Approve. Not yet proven: watch the next `deps/` push. |

## Repo settings (GitHub)

- Squash merge only (merge commits and rebase merges are off). Branches auto-delete on merge.
- **No branch protection.** It needs GitHub Pro on a private repo (the API returns 403). "Merge only on green CI" is a working agreement, not a gate. The `e2e-tests` summary job exists so a protection rule can target it once enabled.
- No workflow waits for manual approval. The `production` environment exists with **no** required reviewer (see Ashok's queue).
- No GitHub secrets or variables are set yet.

## Production state

- **Neon:** live, PostgreSQL 18.7 (org `org-ancient-hat-10361899`, project `autumn-term-77415320`, branch `production`, database `neondb`). The pooled connection string is in `.env.local` at the repo root — gitignored, never commit it. This dev machine reaches Neon only over its **HTTPS endpoint** (`@neondatabase/serverless`, a devDependency). Raw port 5432 is network-blocked here; Cloudflare and GitHub CI reach it directly.
- **Local Postgres:** Rancher Desktop runs Docker; the binary is `~/.rd/bin/docker` (not on PATH). Start the test DB with `~/.rd/bin/docker compose up -d postgres` from the repo root (container `bolt-club-hq-postgres-1`, Postgres 18.7, database `club_test`). docker-compose, CI and the backup clients all run major 18, like Neon. Change them together.
- **Deploy:** merge to main → `wrangler deploy` → `drizzle-kit migrate` → smoke (`/healthz` + SPA shell). Skips until the deploy secrets exist.
- **Cloudflare resources:** the KV, R2 and Hyperdrive ids in `wrangler.jsonc` are still `REPLACE_WITH_*` placeholders.

## Ashok's queue

1. Cloudflare API token + account ID → GitHub secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Create the real KV, R2 and Hyperdrive resources and replace the `REPLACE_WITH_*` ids in `wrangler.jsonc`.
2. **Before** adding the deploy secrets: decide on a required reviewer for the `production` environment. Without one, every merge to main deploys straight to production.
3. GitHub secrets: `DATABASE_URL` (production Neon URL from `.env.local`), `RESTORE_TARGET_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_BUCKET_TOKEN`, `LHCI_TARGET_URL`; repo variable `PUBLIC_BASE_URL`. Full list in `docs/ops/secrets.md`.
4. Wrangler runtime secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VAPID_*`, `HEALTHCHECKS_URL`, `SENTRY_DSN`, `BOOTSTRAP_ADMIN_EMAIL`.
5. Off-site backup store (GitHub artifacts keep 30 days; the plan requires 90). The restore drill's fetch step fails on purpose until this exists.
6. Clerk production instance (for S0.6 part B and S1.1's production config).
7. GitHub Pro (about $4/month) if "merge only on green" should be enforced rather than agreed.
8. Rotate the Neon password eventually (it transited chat).
9. Optional local tidy: three dangling Docker volumes (one is the old S0.2 test DB). `~/.rd/bin/docker volume prune` removes them if nothing else of yours uses them.

## Open technical follow-ups

- **Stale idempotency claims:** a Worker killed mid-request leaves an empty claim, and that key answers 409 until cleaned. The cleanup belongs to the S6.x cron work.
- **Cron in winter:** the 10-minute trigger window is fixed in UTC and matches Stockholm only in summer. S6.4 must fix it (DECISIONS, S0.1).
- **Vitest pool:** `@cloudflare/vitest-pool-workers` 0.23 is deprecated (renamed `@cloudflare/vitest-plugin`). Migrating may let the DB suites back into the Worker pool.
- **`worker-configuration.d.ts`:** hand-edited for the `FLAG_*` vars. A deliberate `wrangler types` refresh rewrites all 28k lines; do it alone, in its own PR.
- **Probe route:** `/api/v1/probe` (S0.1 placeholder) is still allowlisted in the route-guard test. Remove it when the first real route lands.

## Environment / infra recipes (this machine is hostile — follow these)

- **Worktrees:** each worker gets `git worktree add .worktrunk/<slug> -b story/<id>-<slug> origin/main` (inside the repo root = session root, so file tools work). `.worktrunk/` is excluded via `.git/info/exclude`. Bootstrap by symlinking the root `node_modules` (`ln -s ../../node_modules node_modules`) and remove the link before committing. `npm ci` fails here (the mirror blocks some packages, e.g. `wrangler`).
- **Running tests locally:** typecheck, lint and the `domain`/`worker`/`ui` Vitest projects run. The Worker pool needs escalated permissions (wrangler writes logs under `~/Library`). The `db` project cannot run locally (`pg` is not installable from the mirror); CI runs it.
- **Dependencies:** never install locally. Put the change on a `deps/<slug>` branch. The **lockfile bot** (`generate-lockfile.yml`) updates `package-lock.json` in place on a GitHub runner, commits it and starts CI. Check the lockfile diff for unexpected bumps. If a worker needs the new packages locally, relay the tarballs via a temporary `workflow_dispatch` workflow on main (`curl` + `upload-artifact`), then `npm cache add <tgz>`; remove the workflow afterwards.
- **Commits are signed** through the 1Password SSH agent. If a commit fails with "1Password: Could not connect to socket" or "failed to fill whole buffer", 1Password is locked or waiting on an approval prompt: ask Ashok to unlock or approve, then retry.
- **GitHub CLI:** `gh` uses the github.com auth (ignore the stale github.paypal.com account in `gh auth status`) and needs escalated permissions in the sandbox.
- **Playwright CI:** the browser-install step flakes (CDN stalls; capped at 10 minutes). If a single shard fails at "Install Playwright browsers" and nothing else failed, run `gh run rerun <id> --failed`.
- **Landing a stack of PRs:** squash-merge bottom-up. After each merge, retarget the next PR to `main`, merge `origin/main` into its branch (conflicts are expected because squash leaves the old commits behind; the PR branch is newer, so keep its side, but check that `DECISIONS.md` keeps every section), push, wait for green, merge. A modify/delete conflict needs a human look.
- **DECISIONS.md conflicts:** every story adds a section at the top. Workers do a plain `git merge origin/main` (never rebase or force-push) and keep all sections, newest first.
- **Owns check:** `check-owns.sh` reads only `docs/STORIES.md`. Integrator-sanctioned exceptions must be written into the story's Owns line or CI stays red. Non-story branches (`chore/`, `fix/`, `deps/`, `docs/`) skip the check. Stories adding e2e specs must own the spec path.

## Working agreements (from Ashok)

- Worker model: claude-haiku-5-5. Orchestrator on the strongest model. Higher reasoning effort or a stronger model for L-sized stories.
- Merge rule: CI green + integrator review = merge (squash), no per-PR asking. The auto-reviewer still blocks pushes and new PRs it can't tie to an explicit request, so get a blanket "push and merge on green" from Ashok at the start of each batch.
- Route routine pushes through workers where possible; pick persistent-allow on approval popups.
- Budget: not tracked. Ignore any leftover token-goal machinery.
- Tests first, one story per PR, Owns paths only, decisions logged in DECISIONS.md.
