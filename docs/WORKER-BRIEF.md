# Worker brief: BOLT HQ story agents

Give this file to every story agent you spawn (it is tracked in the repo so sub-agents can read it). Repo: GitHub `BOLT-IF/bolt-club-hq`. A story agent delivers ONE story end to end: branch, tests first, code, PR, green CI. The integrator (root agent) merges.

## Read first

- `AGENTS.md`, the story in `docs/STORIES.md`, the `docs/PLAN.md` sections the story cites, the top of `docs/DECISIONS.md` (newest first), the matching `docs/areas/<area>.md`, and `docs/STATUS.md` "Environment recipes".

## Setup

```
git fetch origin
git worktree add .worktrunk/<slug> -b story/<id>-<slug> origin/main    # id lower-case, e.g. story/s4.3-close
cd .worktrunk/<slug> && ln -s ../../node_modules node_modules
```

- The branch name must be `story/<id>-<slug>`. CI maps it to the story id (`story/s6.5a-x` becomes `S6.5a`) and enforces that story's **Owns** line.
- `git` and `gh` need `sandbox_permissions: require_escalated` on this machine.
- Commit unsigned: `git -c commit.gpgsign=false commit` (1Password signing keeps failing here; Ashok approved this).
- Remove the `node_modules` symlink before `git add` and commit, and recreate it after. Never commit it.
- Keep git commands single-purpose (no `&&` chains mixing commit, push and symlink changes): the auto-reviewer blocks chained ones.

## Rules

- Edit ONLY the paths in your story's **Owns** line, plus the shared allow-list: `docs/DECISIONS.md`, `docs/areas/<area>.md`, `tests/e2e/<id>-*.spec.ts`. A trailing `*` in an Owns entry is a prefix match.
- If you need one line in a file you don't own (a route mount in another area's `routes.ts`, a slot import, a link on another story's page), STOP and message the integrator with the exact file and line. The integrator adds it to your Owns line in a contract PR. UI links on other stories' pages are integrator follow-ups, not grants.
- No migrations, dependency changes, or `wrangler.jsonc` edits unless the integrator grants it (migration `0001_polls` was granted this way). Feature flags stay off; the integrator flips them.
- First commit = failing tests for the story's "Tests first" list. Push it, then the implementation.
- Money is whole kronor (integers). Time comes from the injected `Clock` (`c.var.clock`), never `Date.now()` or `new Date()` in worker or domain code. Every `/api/v1` route needs `requireGuard(...)`. Money and RSVP POSTs need `idempotencyKeyMiddleware`. The ledger is append-only.
- Don't guess product behaviour: check `docs/PLAN.md`. If it is still ambiguous, take the most conservative reading, record it as a new section at the TOP of `docs/DECISIONS.md`, and mention it in the PR body.
- Smallest complete change. Reuse `src/worker/core/*`, `src/app/components/ui/*`, `apiFetch`. No abstractions nobody asked for.

## Patterns

- **Backend area:** `src/worker/<area>/routes.ts` default-exports a Hono app:
  `new Hono<AppEnv>().use("/<area>", contextMiddleware()).use("/<area>/*", contextMiddleware()).get("/<area>…", requireGuard(...), handler)`.
  NEVER `use("*")`: all areas mount at `/api/v1`, so it leaks onto other areas' routes. Read `c.var.db`, `c.var.clock`, `c.var.actor`. Exited (inactive) members on their own money or attendance routes: `requireGuard("member", { allowInactive: true })`.
- **Part of an area only (e.g. `claims*`, `admin*`):** export a Hono sub-app from your own file; the integrator grants a one-line `.route("/", subApp)` mount in the area's `routes.ts`.
- **Scheduled work:** `registerTickHook(name, ({ db, clock, now, cron, kv }) => …)` from `src/worker/scheduler/`; call `markDue(kv, at)` to schedule the next wake-up. See `docs/areas/scheduler.md`.
- **Notifications:** `createNotifyPort({ db, clock })`. Mute and quiet hours are policies under `src/worker/notifications/policies/`.
- **Money:** `createLedgerService` (`charge`, `reverse`, `recordPayment`, `adjust`, `balance`). Pass stable idempotency keys (for example `close:<eventId>:<memberId>`). `LEDGER_ERROR_STATUS` in `ledger/admin-routes.ts` maps ledger errors to HTTP statuses.
- **Postgres tests:** name them `*.db.test.ts` (the `db` project, plain Node, real Postgres). Pattern in `src/worker/core/context.test.ts`: `configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(...) })`, call `routes.request(path, { headers: { "X-Test-Identity": m.clerkUserId } }, { ENV: "test" } as unknown as Cloudflare.Env)`, reset in `afterEach`. Factories live in `src/worker/test-support/factories.ts`.
- **Pure logic:** `src/domain/<x>/` with plain `*.test.ts` (the `domain` project).
- **Frontend:** `src/app/routes/<area>/routes.tsx` default-exports an `AppRoute` or an array; `:param` paths; `useRouteParams()`; `navigate()` from `src/app/lib/navigate`. Event-page slots (`RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`) are filled with `registerSlot` from `src/app/routes/events/slots`. Nav entries already exist in `src/app/shell/navigation.ts`. UI tests are `*.test.tsx` in the `ui` project; stub the API with `configureApiClient({ fetch })`.
- **UI quality:** mobile first, labelled and focus-visible, UI kit from `src/app/components/ui/` and the BOLT HQ palette tokens in `ui.css`. Orange fills take dark text, never white. Follow `web-design-guidelines`; axe must be clean.

## Local verification

- `npm run typecheck`, `npm run lint`, and `npx vitest run --project domain --project worker --project ui` (escalated). `pg` is installed now, so the `db` project runs locally too if Postgres is up: `~/.rd/bin/docker compose up -d postgres`, then `npx vitest run --project db`. (If a container already holds port 5432, use that one.)
- Never `npm ci` (it wipes `node_modules` and can't reinstall here). Dependencies change only on a `deps/<slug>` branch via the lockfile bot.

## PR

- `gh pr create --base main --title "<ID> <title>" --body "…"` with what, tests, decisions, and anything deferred.
- Watch CI with `gh pr checks <n> --watch`. Fix failures yourself. If only "Install Playwright browsers" failed on one shard: `gh run rerun <run-id> --failed`. Ignore Cloudflare's "Workers Builds" check on branches; it is not a GitHub Actions check.
- If main moved and conflicts: `git merge origin/main` (never rebase or force-push). `docs/DECISIONS.md` merges itself (`merge=union`); check the new sections are still newest first. Two one-line mounts in the same `routes.ts` conflict: keep both.
- If the auto-reviewer denies a push or `gh pr create`, do not stop: commit locally and message the integrator "push <branch>" with the PR title and body. Keep working.
- Done = green PR. Remove your worktree (delete the symlink first), then reply with: PR number, green status, decisions made, and follow-ups the integrator must do (flags, links, contract asks).
