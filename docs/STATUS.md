# Session handoff — 2026-11-23 (evening)

Status of the parallel build run of `docs/STORIES.md` (48 stories). Read this, then `docs/STORIES.md`, `docs/DECISIONS.md` and `docs/PLAN.md` before continuing. This file is a living record: update it at the end of each session.

## Completed and merged (W0, W1)

| Story | PR | Notes |
|---|---|---|
| R1 roster import (roster-generator repo) | BOLT-IF/roster-generator#53 | Deep-link import sheet, 11 tests + full suites green. Decisions in DECISIONS.md. |
| S0.1 repo scaffold | #2 | One Worker, Hono, Drizzle, Vitest ×3 projects, Playwright ×3. |
| S0.4 frontend foundation | #7 | UI kit, apiFetch, nav/registries, axe-clean. |
| S0.7 observability | #5 | /healthz, request IDs, fetch-based Sentry reporters (see DECISIONS: toucan-js breaks typecheck; @sentry/browser not installed). |
| S0.5 CI/deploy/ops | #8 | Sharded Playwright ×4, owns + migration checks, deploy/backup/lighthouse workflows (skip until secrets exist). |
| S4.1 allocation engine | #6 | Pure TS, 42 tests + 11 fast-check properties. |
| S0.3 PWA + service worker | #9 | Update-prompt test uses faked waiting-state (real second build impossible: SW updates are same-origin only). |
| S0.2 core contracts + schema | #12 | 26 tables, append-only ledger trigger, core services. 99 tests incl. 4 DB suites against Postgres in CI. |

Integrator chore PRs also merged: #1 (CI bootstrap), #3 (R1 decision log), #4 (allowScripts), #10 (tarball relay, temporary), #11 (S0.3 owns + relay removal), #13 (handoff + S0.2 owns), #14 (vite `rolldownOptions` lint fix), plus the repo-audit cleanup and fix PRs (see DECISIONS, "Repo audit").

## Repo audit follow-ups (2026-11-23)

All merged branches and story worktrees were deleted; the repo auto-deletes branches on merge. Audit fixes landed as separate PRs: ops wiring (`/healthz` + `scheduled()` tick), `/api/v1/config`, idempotency claim-first, and the dependency trim. See DECISIONS for each.

Follow-ups (2026-11-24): the secrets gate now skips cleanly (Deploy, backup, drill and Lighthouse stay green until secrets exist); local, CI and backup clients all run Postgres 18 like Neon; the repo allows squash merges only. See DECISIONS.

**Not enforceable on this plan:** branch protection and rulesets need GitHub Pro on a private repo. "Merge only on green" is a working agreement, not a gate.

## Not started

- **W2 (S0.2 is merged, so unblocked):** S1.1 (Clerk), S2.1, S2.3, S3.0, S3.1, S5.1, S6.1, S6.4 — fan out in parallel worktrees (recipe below).
- **S0.6 device spike:** blocked on Ashok (Clerk production instance, real iPhone + Android). Domain `boltif.eu` is on Cloudflare (nameservers moved) — done.
- W3–W8 per docs/STORIES.md wave table.

## Production state

- **Neon:** live, PostgreSQL 18.7 (org `org-ancient-hat-10361899`, project `autumn-term-77415320`, branch `production`, database `neondb`). Connection string (pooled, `-pooler` host) is in `.env.local` at the repo root — gitignored, never commit it. This dev machine can only reach Neon over its **HTTPS endpoint** (`@neondatabase/serverless`, installed; verified working). Raw Postgres 5432 is network-blocked here; Cloudflare/GitHub CI reach it directly — unaffected.
- **Local Postgres:** Rancher Desktop runs the docker engine — binary at `~/.rd/bin/docker` (not on default PATH). docker-compose Postgres is the local/CI test DB. docker-compose, CI and the backup clients all run Postgres 18, matching Neon. Change all of them together.
- **Deploy:** `deploy.yml` merges to main → wrangler deploy → drizzle-kit migrate → smoke. Blocked on secrets (below).

## Ashok's queue (needed for deploy + S0.6)

1. Cloudflare API token + account ID → GitHub secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; create real KV/R2/Hyperdrive resources and replace `REPLACE_WITH_*` IDs in `wrangler.jsonc`.
2. GitHub secrets: `DATABASE_URL` (production Neon URL from `.env.local`), `RESTORE_TARGET_URL`, `BACKUP_ENCRYPTION_KEY`, `LHCI_TARGET_URL`; repo variable `PUBLIC_BASE_URL` (https://boltif.eu). Create the `production` GitHub environment with a required reviewer.
3. Wrangler runtime secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VAPID_*`, `HEALTHCHECKS_URL`, `SENTRY_DSN`, `BOOTSTRAP_ADMIN_EMAIL`.
4. Off-site backup store choice (GitHub artifacts = 30 days; plan requires 90).
5. Clerk production instance (for S0.6 + S1.1 wiring).
6. Rotate the Neon password eventually (it transited chat).

## Environment / infra recipes (this machine is hostile — follow these)

- **Worktrees:** parallel workers each get `git worktree add .worktrunk/<slug> -b story/<id>-<slug> main` (inside the repo root = session root, so file tools work). `.worktrunk/` is excluded via `.git/info/exclude`. Bootstrap: `npm ci --prefer-offline --no-audit --no-fund` (Peons npm cache). `allowScripts` is already in package.json.
- **npm network:** registry.npmjs.org tarballs are network-BLOCKED (even escalated raw curl → 403). The private mirror (`~/.npmrc`, us-central1-npm.pkg.dev) denies a rotating subset of packages. If a dependency must be added: worker adds it to package.json → push → the **lockfile bot** (`generate-lockfile.yml`, triggers on any `deps/**` branch, or `gh workflow run generate-lockfile.yml --ref <branch>`) updates the lockfile on a GitHub runner and commits it back → compute the lockfile diff (node script comparing `packages` vs old lockfile) → relay just those tarballs via a temporary workflow with `curl` + `upload-artifact` (must be added to MAIN first — GitHub only registers workflow_dispatch workflows from the default branch; it was removed in #11, re-add temporarily, remove after) → download artifact → `npm cache add <tgz>` each → `npm ci --prefer-offline`.
- **GitHub CLI:** `gh` uses the github.com auth (the github.paypal.com account in `gh auth status` is stale/invalid — ignore it).
- **Playwright CI:** browser-install step can stall (once hung 25 min) — it now has `timeout-minutes: 10`; cancel+rerun if it stalls anyway.
- **DECISIONS.md conflicts:** every story adds a section at the top, so every merge conflicts on it. Rule: workers do a PLAIN `git merge origin/main` (never rebase/force-push) and keep ALL sections from both sides, newest-first.
- **Owns check:** `check-owns.sh` reads only `docs/STORIES.md` — integrator-sanctioned exceptions must be written into the story's Owns line (see S0.3 and S0.2 entries) or CI stays red. Stories adding e2e specs must own the spec path.

## Working agreements (from Ashok)

- Worker model: claude-haiku-5-5 (worked well; the S0.2 stall was environment + turn limits, not model quality). Orchestrator on the strongest model. Consider higher reasoning effort or a stronger model for L-sized stories.
- Merge rule: CI green + integrator review = merge (squash, delete branch), no per-PR asking.
- Route routine pushes through workers where possible; pick persistent-allow on approval popups.
- Budget: NOT tracked as a token goal — Ashok said drop it (a misconfigured durable goal is stuck at `budget_limited`; ignore that goal machinery entirely in the next session if it resurfaces).
- Tests first, one story per PR, owns paths only, decisions logged in DECISIONS.md.
