# Decision log

Decisions made after `PLAN.md` (v3) was written. Newest first. Every entry gives the decision, the reason, and what it changes.

## 2026-11-24: S6.6 broadcasts: audiences, mute, audit

- **Route:** `POST /admin/broadcasts` (admin guard + `Idempotency-Key`), body `{ title, body, audience }`, returns `{ broadcastId, recipientCount }`. Title max 100, body max 1000 characters. Unknown event: 404 `event_not_found`.
- **Audiences** query the tables directly and only ever include `active` members (pending, exited and erased members get nothing): `all`; `pass_holders` (active passes, optionally one series); `event_rsvps` (RSVPs in `requested`, `confirmed`, `waitlisted`, `offered`; cancelled and late-cancelled are left out; the event may be named by id or share slug); `captains` (`series_captain`, optionally one series). Conservative reading: PLAN names the four audiences but not the RSVP statuses.
- **Sending** goes through `createNotifyPort` with category `announcements`, one call per member, idempotency key `broadcast:<id>:<memberId>`. The inbox row is always written; mute (S6.3, order 10) and the rest of the policy chain decide only about the push. An event audience deep-links to `/events/<slug>`; others use the category default.
- **Audit:** one `audit()` row per broadcast (`broadcast.send`, entity `broadcast`), written in the same transaction, also when there are zero recipients. Its id is derived from the broadcast id, which doubles as the "already sent" check, so a retry sends and audits once. The route derives the broadcast id from actor + `Idempotency-Key`.
- **Not in v1:** scheduling and an event picker (the screen takes an event ID or share slug).

## 2026-11-24: W2 contract 2: inactive members on own-data routes; S6.4 owns `scheduled()`

- **`requireGuard(kind, { allowInactive: true })`** lets `inactive` (exited) members through; `pending` and `erased` still get 403. PLAN §6.7: exited members keep Money and attendance history. S5.1/S5.2 (own ledger), S8.2 (own attendance) and S2.5 (own export) set it on their own-data routes; nothing else does. Asked for by S2.1.
- **Correction to W2 contract: scope `contextMiddleware()` to the area's own paths** (`.use("/events", …).use("/events/*", …)`), never `use("*")`. Every area sub-app is mounted at `/api/v1`, so `"*"` ran for every route registered after it, opened the DB for `/probe` and `/config`, and returned 500 in the workers pool. Found by S6.1.
- **S1.1 may edit `src/app/main.tsx`** to wrap the app in its `AuthProvider`. Without a Clerk publishable key (dev, CI, e2e) the app renders without Clerk.
- **S6.4 may edit `src/worker/index.ts`** so `scheduled()` delegates to `src/worker/scheduler/` (overlap lock, `next_due_at`, time bound, healthchecks ping wrap the hooks). S6.4's Owns line also lists `wrangler.jsonc` as a path, because the Owns check matches paths, not file sections; the story still edits only the cron section.

## 2026-11-24: S6.1 notifications: inbox first, push is a seam

- **Inbox row first, then policies, then push.** `createNotifyPort({ db, clock })` inserts the `notification` row (`id = ntf_<idempotencyKey>`, `ON CONFLICT (idempotency_key) DO NOTHING`), and only the call whose insert lands runs the policy chain and queues an `outbound_push` row. A retry therefore never queues a second push, including after a suppression. Callers pass their transaction as `db` so the notification commits with their work.
- **Policy chain** is `policy.ts`: files under `src/worker/notifications/policies/` default-export `{ id, order, evaluate }` and are auto-registered (`import.meta.glob`). Decisions: `allow`, `suppress`, or `defer { until }`. Ascending `order`, first non-allow wins. Slots: mute 10, quiet hours 20, frequency cap 30 (PLAN §10). S6.1 ships none. `defer` queues the push as `deferred` with `not_before`, which is what S6.2's quiet hours needs.
- **Fail closed:** a policy that throws (run in a savepoint so it cannot abort the inbox write) suppresses the push and calls `onPolicyError`. Conservative reading: a missed push is recoverable from the inbox, an unwanted one is not.
- **S6.2 seam:** S6.1 only writes `outbound_push` (`queued` or `deferred`). The sender (batching, 404/410, backoff) is S6.2.
- **Links:** `NotifyInput` gains an optional `link`. Only in-app paths (`/…`, not `//` or `/\`) are stored; anything else is replaced by the category's screen, so a push can never point off-site. The UI re-checks before navigating. `NotifyPort` in `core/ports.ts` is unchanged (`link` is an optional extra on the production adapter); a contract change to add it to the port is a follow-up for the integrator.
- **Categories** are the PLAN §10 list; an unknown one throws. `admin_tasks` for a non-admin recipient is silently dropped (PLAN: admins only).
- **Mark read** takes `{ ids }` or `{ all: true }`, stamps only the caller's unread rows, and needs no `Idempotency-Key` because it is naturally idempotent (it is not a money or RSVP POST).
- **Contract gotcha for every area:** `new Hono().use("*", contextMiddleware())` in an area's `routes.ts` is mounted under `/api/v1`, so it runs for **every** route registered after it (the registry mounts areas alphabetically), not just that area's. It made `/probe` open the database and 500 in the worker project. S6.1 scopes it to `/notifications` and `/notifications/*`. The other W2 areas should do the same, or the integrator should make `contextMiddleware` skip paths the area does not own.

## 2026-11-24: W2 contract: per-request context, DB test suites, shared Owns

Integrator contract-change PR before the W2 fan-out, so eight parallel stories do not each invent request wiring.

- **`src/worker/core/context.ts`.** An area mounts `new Hono<AppEnv>().use("*", contextMiddleware())` in its `routes.ts` and then reads `c.var.db`, `c.var.clock` and `c.var.actor` (`CurrentMember | null`). `requireGuard` already reads `actor`. Money and RSVP POSTs chain `idempotencyKeyMiddleware({ db: c.var.db … })` after the guard (build it per request inside a small wrapper, since the db is per request).
- **Actor resolution:** the `X-Test-Identity` header (ENV=test only) wins, then `authenticate()` (bearer JWT). The default `authenticate` returns null: **S1.1** calls `configureRequestDeps({ authenticate, currentMember })` from `src/worker/auth/` to plug in Clerk and pending-member creation. The default `currentMember` only looks up existing members (plus captained series).
- **DB is loaded lazily** (`await import("./db/client")`): the route registry imports every `routes.ts` eagerly and the workers Vitest pool cannot load `pg`. The production DB opens through Hyperdrive per request and is closed after the response.
- **Testing:** handler tests that need Postgres are named `*.db.test.ts` and run in the `db` Vitest project (plain Node, real Postgres). They call `configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(...) })`, then `app.request(path, { headers: { "X-Test-Identity": member.clerkUserId } }, { ENV: "test" })`, and reset with `configureRequestDeps({})`. Pure logic stays in `src/domain/` (domain project).
- **Shared Owns allow-list gains `docs/areas/`** (DoD 6 requires every story to update its area doc, but no Owns line listed it). `docs/STATUS.md` stays integrator-only.
- **Frontend routes:** the registry now globs `src/app/routes/**/routes.tsx` (so `admin/members/routes.tsx` etc. register), a module may export one route or an array, and paths may use `:param` segments (`/events/:slug`). Pages read params with `useRouteParams()`. Exact paths win over patterns.
- **Feature flags:** `wrangler.jsonc` is not in story Owns. Stories build behind their flag (off); the integrator flips `FLAG_EVENTS` / `FLAG_MONEY` / `FLAG_INBOX` in a chore PR once an area is usable end to end.
- **Playwright specs:** a story that adds one names it `tests/e2e/<story-id>-*.spec.ts`. The shared allow-list accepts `tests/e2e/` paths for that reason. UI behaviour is otherwise tested in the Vitest `ui` project.

## 2026-11-24: No workflow waits for a manual approval

- **Found:** every time the lockfile bot pushed (S0.1, S0.2, the dependency trim), the PR's CI run sat as `action_required` until a person clicked Approve. GitHub does this on purpose: a push made with `GITHUB_TOKEN` cannot start a PR workflow by itself.
- **Fix:** after it pushes, the bot starts CI with `gh workflow run ci.yml --ref <branch>`. A `workflow_dispatch` made with `GITHUB_TOKEN` is allowed to start a run, so no approval is needed. The run reports on the branch head, which is the PR head, so the PR's checks update. The workflow gets `actions: write` for this.
- **Checked, no approval needed:** CI (push and pull_request from our own branches), Deploy (`production` environment has no required reviewers), the scheduled backup, restore drill and Lighthouse (scheduled runs never wait for approval). Fork-PR approval does not apply to a private repo.
- **Deliberate future gate:** STATUS lists a required reviewer on the `production` environment as Ashok's choice. Adding it makes each deploy wait for his approval by design.

## 2026-11-24: Postgres 18 everywhere (Ashok)

- **Why 18, not "latest":** match production. Neon runs PostgreSQL 18.7. 17 was only the scaffold's default from before Neon existed. Testing on a newer major than production is the same mismatch the other way, so the rule is "same major as the Neon project". Moving production to a new major is a Neon upgrade first, then this set of pins.
- **Bumped together:** `docker-compose.yml`, both `ci.yml` service containers, and the backup and restore-drill clients (`postgresql-client-18`). The client bump also fixes a latent failure: `pg_dump` 17 refuses to dump an 18 server, so the weekly backup would have failed against Neon once the secrets existed.
- **Supersedes** "Postgres 18 parity deferred" in the S0.2 entry.

## 2026-11-24: Secrets gate writes the verdict, workflows read it

- **Bug:** `require-secrets.sh` exits 0 both when it proceeds and when it skips (so CI stays green), but all four workflows wrapped it in `if require-secrets.sh; then ready=true`. A skip therefore set `ready=true`, and Deploy ran `wrangler deploy` with no Cloudflare token on every push to main (red since S0.5). Backup, restore drill and Lighthouse had the same wiring and would have gone red on their first schedule.
- **Fix:** the script writes `ready=true|false` to `$GITHUB_OUTPUT` itself. Workflows call it bare and gate on `steps.guard.outputs.ready`. Exit codes are unchanged: 0 for proceed or skip, 2 for an unknown job name (fails closed).
- **Guarded by tests:** `test-require-secrets.sh` checks the written verdict and fails if any of the four workflows gates on the exit code again.
- **Also:** `.gitignore` ignores `.neon`, the Neon CLI's local project link.

## 2026-11-23: Repo audit: dependency trim

- **Removed (nothing imports them):** `toucan-js` (the Worker posts Sentry envelopes with `fetch`, see S0.7), `msw` (its only handler file was dead), and `@cloudflare/workers-types` (the generated `worker-configuration.d.ts` already carries the runtime types; worker typecheck and lint pass without it). `axe-core` and `@testing-library/dom` are dropped as direct entries: they arrive through `@axe-core/playwright` and `@testing-library/react`.
- **`@neondatabase/serverless` moves to devDependencies.** Production uses `pg` through Hyperdrive. The Neon HTTP driver is only a local tool for reaching Neon from the dev machine.
- **`@types/pg` replaces `src/worker/types/pg.d.ts`**, as the S0.2 entry required at the next dependency change.
- **Kept on purpose:** `@clerk/backend`, `@clerk/react` (S1.1, next wave) and `@block65/webcrypto-web-push` (S6.x). Nothing imports them yet, but this machine cannot install new packages (the npm mirror blocks a rotating set, see STATUS), so removing and re-adding them costs a tarball relay each. Remove them only if their stories change course.
- **Lockfile** regenerated by the lockfile bot on this `deps/` branch, updating in place.

## 2026-11-23: Repo audit: idempotency is claim-first

- **Found by the audit:** the `Idempotency-Key` middleware looked up the key, ran the handler, and only then stored the response. Two copies of one request arriving together (a double-tap on a slow phone) both missed the lookup and both ran the handler. The ledger's unique key still blocked a duplicate ledger row, but RSVPs, notifications and other side effects were not protected. The old test sent its two requests one after the other, so it never caught this.
- **Claim first, then run.** The middleware inserts an empty record for (key, actor, route) with `ON CONFLICT DO NOTHING ... RETURNING`. Only the request whose insert lands runs the handler. The unique index `idempotency_record_pk` serialises the race in Postgres, so it holds across Worker isolates.
- **Losers:** a stored response is replayed with `Idempotent-Replayed: true`. If the winner is still running, the loser gets **409 `idempotency_key_in_progress`**, and the client retries with the same key. The S0.4 `apiFetch` already throws `ApiError` on 409; the screen that uses a key decides whether to retry.
- **Failure releases the claim.** A handler that throws, or returns 5xx, deletes the record, so a retry runs again. 4xx responses are stored and replayed: they are the answer for that request.
- **Open:** a Worker killed mid-handler leaves an empty claim, and that key answers 409 until a cleanup removes it. Acceptable at club scale (the client uses a fresh key per action); a cleanup of empty claims older than a few minutes goes with S6.x cron work.

## 2026-11-23: Repo audit: `/api/v1/config`

- **Found by the audit:** the shell loads `/api/v1/config` at startup (S0.4), but no Worker route served it. Every real load got a 404, so every flag read as off. The tests passed only because they mocked the endpoint.
- **Flags come from `FLAG_<AREA>` vars** in `wrangler.jsonc` (PLAN §11.5: per-area env vars), lower-cased: `FLAG_EVENTS` → `events`. "on", "true" or "1" means on; anything else is off (fails closed). Only `FLAG_*` string vars are read, so no other binding or secret can reach the client.
- **All three areas start off.** No area page exists yet. The story that ships an area flips its flag to "on" in the same PR.
- **Public route.** `/config` is on the route-guard allowlist because the shell needs it before sign-in. S2.3 adds the public ClubSettings subset to the same response.
- **`worker-configuration.d.ts`** gets the three `FLAG_*` lines by hand. Re-running `wrangler types` rewrites all 28k lines (formatting and date changes), so it is left for a deliberate types refresh.

## 2026-11-23: Repo audit: ops wiring (Ashok chose the liveness/readiness split)

- **Found by the audit:** S0.7's ops app, request IDs and Sentry reporting were built and tested but never wired. `/healthz` was a hard-coded `{"status":"ok"}` and the Worker had no `scheduled()` handler, so the cron tick was never recorded.
- **`/healthz` is liveness, `/healthz/ready` is readiness.** `/healthz` returns 200 whenever the Worker runs. The deploy smoke test, Playwright's startup wait and `wrangler dev` use it, and all of them run before any cron tick exists. `/healthz/ready` is the strict S0.7 verdict (DB, tick, queue; 503 when degraded) for monitoring and the S6.x healthchecks.io alert. Rejected: one strict endpoint (fails smoke and e2e on every fresh deploy) and "missing tick = healthy" (hides a cron that never starts).
- **`scheduled()`** records the tick first, then runs every hook registered for that cron with `Promise.allSettled`. One failing hook does not stop the others; the first error is rethrown so Cloudflare marks the run failed.
- **Request IDs on every route.** `requestIdMiddleware` runs on the whole Worker app, so `/api/v1` handlers get `c.var.logger` and `c.var.requestId` (`AppEnv` includes `OpsEnv`).
- **Uncaught errors** go to Sentry through `app.onError` and `waitUntil`, only when the `SENTRY_DSN` secret is set, and return a JSON 500.

## 2026-11-23: Repo audit cleanup (integrator)

- **One `Clock`.** `src/worker/ops/clock.ts` was a stand-in until S0.2 landed (see S0.7 below). It is deleted. Ops code uses `src/worker/core/clock.ts` and converts with `.getTime()` where it needs epoch milliseconds.
- **v3 copies removed from `docs/history/`.** `PLAN-v3.md` and `STORIES-v3.md` duplicated the live `PLAN.md` and `STORIES.md`, which are v3. v1, v2, the council review and the discarded files stay. Git keeps the deleted copies.
- **Dead files removed:** the nine `.gitkeep` placeholders (every folder now holds code; supersedes the S0.1 "empty folders" note) and `src/app/lib/msw/handlers.ts`, which nothing imports (e2e tests mock with `page.route`).
- **Lockfile bot** triggers on `deps/**` branches or by hand, not on merged story branches. It updates the existing lockfile (`--package-lock-only`) instead of deleting and re-resolving it. Re-resolving silently bumped `typescript-eslint` and broke lint on #12.
- **Local Hyperdrive** points at `club_test`, the database docker-compose creates. `club_dev` never existed.
- **Merged branches and story worktrees deleted.** The repo now auto-deletes a branch when its PR merges.

## 2026-11-23: S0.2 core contracts + schema resolutions (ambiguities)

- **Hyperdrive + `pg` (integrator and Ashok approved).** Production connects through Hyperdrive (`HYPERDRIVE` binding). The driver is `pg` ^8.23.1 as a regular dependency, reached through `pg-cloudflare`, which needs `nodejs_compat` (already in `wrangler.jsonc`). Free-plan evidence and the manual `wrangler hyperdrive create` step are in `docs/ops/db.md`.
- **Scope exception (approved by integrator): `vitest.config.ts` gains a `db` project.** The four DB suites (`migration`, `ledger`, `idempotency`, `locking`) run in a plain-Node project with `environment: node` against the local Postgres via `DATABASE_URL`. The workerd `worker` project excludes them and keeps the runtime-semantics suites. Reason: `@cloudflare/vitest-pool-workers` 0.23 cannot load `pg`'s CJS chain (`require('./client')` from `pg/lib/index.js` fails with `Cannot use import statement outside a module` under the `?mf_vitest_no_cjs_esm_shim` suffix). Inlining the package and aliasing `pg-protocol` both failed, so the fix is to move the suites rather than fight the shim. Re-evaluate when the pool package is replaced by `@cloudflare/vitest-plugin`.
- **Scope exception (approved by integrator): `drizzle.config.ts` schema list.** drizzle-kit reads the four area files directly (`identity`, `club`, `money`, `comms`) instead of the `db/schema/index.ts` barrel, so the barrel is not loaded twice. The app and tests still import the barrel.
- **Scope exception (approved by integrator): `src/worker/types/pg.d.ts`, interim typings.** A minimal `declare module "pg"` covering `Pool`, `Client`, `PoolClient`, `QueryResult` and `PoolConfig`. `@types/pg` is not an approved dependency, so this stands in for it. **It must be replaced by `@types/pg` at the next sanctioned dependency change.**
- **Probe route allowlist.** `src/worker/core/route-guard.test.ts` allows exactly `GET /api/v1/probe` without a guard. This is the S0.1 placeholder route. It is removed from the allowlist when the real routes arrive, so every new `/api/v1` route must carry a guard.
- **Schema is one initial migration.** `db/migrations/0000_initial.sql` holds all 26 tables from PLAN §5.1 plus the append-only ledger trigger. The trigger is hand-appended, since drizzle-kit does not emit triggers. The ledger allows exactly one `exported_at` stamp and no other UPDATE, and no DELETE.
- **Idempotency is two layers.** `insertIdempotent` (ledger `ON CONFLICT DO NOTHING` on `idempotency_key`) makes writes safe under concurrency. The HTTP `Idempotency-Key` middleware stores responses in `idempotency_record`, keyed by (key, actor, route). A missing header returns 400.
- **Test DB per test.** Each DB test creates `club_test_<uuid>`, applies the bundled migrations and drops it afterwards. Migrations are bundled with `import.meta.glob` because workerd has no filesystem.
- **Clock is injected.** `Clock` (`src/worker/core/clock.ts`) has `systemClock` and `FixedClock`. Nothing in core or test-support calls `Date.now()`.
- **Postgres 18 parity deferred (no scope exception; done 2026-11-24, see "Postgres 18 everywhere").** Production is Neon, PostgreSQL 18.7, EU-central. An earlier commit bumped only `docker-compose.yml` to 18; it was reverted because `docker-compose.yml` is outside S0.2's Owns and CI (`ci.yml`) and backups (`backup.yml`) stay on 17, so local and CI would test different majors. The move to 18 is a follow-up contract-change PR that bumps local, CI and the backup client together. The dev machine reaches Neon only over its HTTPS endpoint via `@neondatabase/serverless`; the connection string stays in the gitignored `.env.local` and is never committed.

## 2026-11-23: S0.3 PWA service worker (ambiguities)

- **Precache the shell at `/`, not `/index.html`:** the assets binding answers `/index.html` with a 307 (single-page-application handling), and `cache.addAll` rejects redirects, so the install failed silently. `/` returns 200 and is precached instead.
- **No Workbox runtime:** `workbox-*` is only a transitive dependency and `package.json` can't change, so `src/sw/sw.ts` uses plain `caches` and `fetch`.
- **Precached assets are cache-first:** without this, the cached shell's JS could not load offline.
- **Network-first allowlist:** `/api/v1/me` and `/api/v1/config` (PLAN §11.6). Neither exists yet; the list is a constant in `src/sw/routes.ts` for later stories to extend.
- **Page glue and Apple tags are injected by `vite.config.ts`:** `src/app/main.tsx` and `index.html` are outside S0.3's Owns list. The register chunk is a Rollup entry, and the Apple meta tags and manifest link come from the plugin's `transformIndexHtml`.
- **Icons:** generated PNGs (solid PayPal blue, white bar) in `public/icons/`, with a maskable variant whose glyph stays in the safe zone. Replace with brand artwork before launch (S11.3).
- **Test file location:** `tests/e2e/pwa.spec.ts` is outside Owns. Playwright's `testDir` is `tests/e2e`, and the story requires Playwright tests first, so the spec sits there. Integrator approved this location as the spec home.
- **Update prompt test, option 2 fallback (flagged):** the integrator chose option 1 (a real second build on a second port). That is not workable. A service worker's update check only fetches `/sw.js` from the origin that registered it, so a second server on another port cannot deliver a changed worker. Making it work would need a proxy in front of the first server, plus a second `dist` and a sequenced build in CI. The test therefore uses option 2: an init script makes `registration.waiting` report a worker, then reloads the page. The prompt and the reload path are the app's real code. Only the waiting state is faked. The test runs in the desktop project only; iPhone and Android skip it.

## 2026-11-23: S0.5 CI, deploy, backups (ambiguities resolved)

- **Owns-scope exception (additive only):** `docs/DECISIONS.md` is edited outside S0.5's Owns. Only this section is added at the top, as AGENTS.md rule 4 requires. `check-owns.sh` allows this file for every story.
- **Check scripts are bash, not TypeScript.** `npm run lint` type-checks every `.ts`/`.js` file against the three tsconfigs, and `scripts/ci/` is not in any of them. Bash keeps the checks out of the type graph without editing tsconfig or package.json, which are outside S0.5's Owns.
- **Playwright shards:** 4 runners, as in `roster-generator`. Each shard runs its own Postgres service container, so the shards share no state. The `e2e-tests` summary job keeps a branch-protection rule on that name working. The e2e jobs depend on `ci`, so a unit failure does not spend four runners.
- **Browser install:** `chromium webkit`, not roster's `chromium firefox webkit`. `playwright.config.ts` runs the iPhone project on WebKit and does not use Firefox. The step has a 10-minute `timeout-minutes` cap because a stalled CDN download hung the old job for 25+ minutes.
- **Owns check branch convention:** the story ID is read from the head branch `story/<id>-<slug>`. A branch that does not follow the convention skips the check with a notice, rather than failing every PR.
- **Deploy order:** `wrangler deploy`, then `drizzle-kit migrate`, then the smoke test, as the story states. Migrations therefore run after the new Worker is live, so every migration must be expand-only. Rollback is `wrangler rollback`; migrations are not rolled back automatically.
- **Secrets gate:** each scheduled or deploy job runs `require-secrets.sh` first and skips with a notice when a secret is missing. The job stays green until the secrets exist. An unknown job name fails closed. (The workflow wiring was wrong until 2026-11-24; see "Secrets gate writes the verdict".)
- **Backup retention vs artifacts:** PLAN §16 requires 90-day backup retention. GitHub artifacts are not a backup store, so the workflow uploads a 30-day artifact only. The off-site store is an open item, recorded in `docs/ops/backups.md`.
- **Restore drill fetch step:** the drill cannot yet fetch the latest dump, because the off-site store is not chosen. The fetch step fails on purpose so the drill is never reported green without a restore. It is the first thing to replace once the store exists.
- **Neon storage correction:** PLAN §11.3 says "0.5 GB" for Neon free. Neon's current plans page gives 1 GB per project (20 GB account total). `docs/ops/budgets.md` records the verified figure.
- **Cloudflare Cron Triggers:** the Free plan allows 5 per account. We use 2, as in PLAN §11.3. Recorded in `docs/ops/budgets.md`.
- **Unverified:** the GitHub Actions included-minutes figure and the `@lhci/cli@0.15` pin could not be checked from the build machine (the GitHub billing page and the npm registry were unreachable). Both are flagged in `docs/ops/budgets.md` and `docs/ops/backups.md` for confirmation on the first real run.

## 2026-11-23: S0.4 frontend foundation resolutions (ambiguities)

- **Scope exception (approved by the user and sanctioned by the integrator):** `src/app/main.tsx` now mounts `AppRoot` (the shell, flags and toasts), and `tests/e2e/shell.spec.ts` was added. The integrator confirmed both as approved. All other edits stay within the story's Owns paths. The probe-in-shell test lives in `src/app/shell/registry.test.tsx`.
- **Shell owns the chrome, not the pages:** Home, Events, Money, Inbox and the More targets are registry entries. Their pages are owned by later stories, so an unregistered path shows an empty state.
- **Bottom nav:** Home · Events · Money · Inbox · More. More opens a bottom sheet (a button, not a route), so the 5th item is never a dead link. Events, Money and Inbox are hidden unless their flag is on. Flags fail closed: if `/api/v1/config` fails, every flag is off.
- **Back control:** a visible Back button on every non-root screen. It uses `history.back()` only when the previous entry was pushed by the app, and otherwise goes to the parent route, so deep links never leave the user stranded.
- **apiFetch:** `Authorization` is sent only when Clerk supplies a token; S1.1 wires `getToken`. A 401 redirects to `/sign-in?return_to=<current path>` (the sign-in route is S1.1's). A 426 sets a global "outdated" flag, which shows the refresh banner. `X-Client-Version` is `"1"`.
- **Idempotency:** `newIdempotencyKey()` uses `crypto.randomUUID()`. Callers pass the key explicitly per request.
- **Admin index:** the registry lists 10 admin sections under `/admin/*`, admin-only. The pages are owned by later stories.
- **Accessibility:** WCAG 2.1 AA, checked with axe on all three projects (serious and critical violations fail). Targets are at least 48px. Status is text plus colour. Reduced-motion disables animations.
- **Test isolation:** Vitest runs without globals, so Testing Library cleanup is explicit in each file that renders.

## 2026-11-23: S0.7 observability resolutions (ambiguities)

- **`@sentry/browser` is not installed.** STORIES says S0.1 pre-added the browser SDK, but `package.json` and `node_modules` only have `toucan-js` (Worker). The browser reporter (`src/app/ops/sentry.ts`) posts a Sentry v7 envelope with `fetch` and sends nothing without a DSN. Adding the SDK later needs a `package.json` change, so it goes through the integrator.
- **Staleness threshold.** A tick is stale when `now - last_tick_at > 2 × cron interval`. The interval is 10 minutes inside the UTC 05–21 window and 60 minutes outside it. This follows the S0.1 trigger split, so the overnight hourly run is not reported as stale. A missing tick counts as stale. Health returns 503 when the DB is in error or the tick is stale.
- **DB and queue probes are injected.** No database client exists before S0.2. Until then `db.status` is `unknown` and `queue.depth` is null. Neither degrades health. S0.2 supplies the real probes.
- **Launch metrics go to structured logs.** Counters are emitted as `metric` log lines with the request ID. A future Analytics Engine sink can replace them without changing callers.
- **Sentry DSN** comes from the `SENTRY_DSN` binding. Unset means no reporting. The Worker reporter scrubs `authorization` and `cookie` headers and email or long-number strings from messages.
- **No toucan-js in the Worker.** The story names toucan-js, but importing it breaks `npm run typecheck` on `Cloudflare.Env` (`ASSETS` missing). Its types reference `@cloudflare/workers-types`, which shadows the generated `Env`. A clean clone of `main` passes and a clone with only a bare `import "toucan-js"` fails. The Worker reporter posts Sentry envelopes with `fetch` instead, which matches the browser side and adds no dependency. Restoring toucan-js needs an integrator decision on `tsconfig.worker.json` or `worker-configuration.d.ts`.
- **Clock.** Ops code uses its own structural `Clock` (`src/worker/ops/clock.ts`) so it does not depend on S0.2's `src/worker/core/`. `performance.timeOrigin + performance.now()` gives epoch milliseconds without `Date.now()`, which lint forbids in the Worker.
- **Scope exception approved by integrator:** `src/worker/app.ts` (mount `createOpsApp()`), `src/worker/index.ts` (Sentry reporting via `ctx.waitUntil`) and the optional `SENTRY_DSN` entry in `wrangler.jsonc` `vars`.
- **Route placement.** `/healthz` lives in `src/worker/ops/app.ts`, not `routes.ts`, so the `/api/v1` registry glob ignores it. It must be mounted at the Worker root. That wiring is in `src/worker/index.ts` and `src/worker/app.ts`, which this story does not own. The integrator approved this scope exception: the two wiring edits and the optional `SENTRY_DSN` var.

## 2026-11-23: S4.1 allocation resolutions (ambiguities)

- **Instant-mode guest time:** a guest can't be confirmed before their host, so in instant mode a guest sorts by the later of their own and their host's request time. Ties put the member first. Reason: pure first-come must still never confirm a guest ahead of their host.
- **Open seat after close (A5):** a late RSVP takes a seat that is still free, first-come. A5 only forbids bumping someone already confirmed. Changes `waitlistInsert` (`src/domain/allocation/waitlist.ts`).
- **Cutoff boundary (A6):** the cutoff is `startsAt − cutoffMinutes`. At exactly that instant, promotion switches to offers. Before it, free seats fill automatically in mode order.
- **Offer set (A6):** at the cutoff, every candidate who is eligible (a member, or a guest whose host is confirmed) is offered the free seats. The offer list is in mode order for display, but any eligible candidate may claim. The first claim wins (`claimOffer`). When no seat is free, nothing is offered.
- **Guest of an unconfirmed host:** a guest whose host is waitlisted or absent waits. A host who is confirmed later in the same pass unlocks the guest, so the rule is checked during the fill, not against the input.
- **Capacity:** must be a non-negative whole number. A `RangeError` is thrown otherwise. Reason: money and seat rules are integer-only (AGENTS.md rule 5).
- **Time injection:** `promote` takes `now` and `startsAt` as epoch milliseconds from the caller. The domain never reads the clock (AGENTS.md rule 6).

## 2026-11-23: R1 roster import (integrator-confirmed)

- **Owns-scope exception (approved by integrator):** two wiring lines outside R1's owned paths in `roster-generator` — `PlannerRoute.jsx` renders the `ClubImportSheet`/`ClubImportBanner`, and `App.jsx` passes `onCreatePlayer` into `usePlannerState`. Without them the feature cannot be reached.
- **Guests:** unmatched guests get "Add to directory" alongside the Guest label, not just the label.
- **"Draft":** any selected players, fixed pairs, or a generated roster. Importing replaces the selected players and clears fixed pairs (after confirmation).
- **Payload limits:** 8192-character fragment, 200 players, 120-character names.
- **Name matching:** case-insensitive with surrounding whitespace trimmed, short name then full name. No diacritic folding ("Sandström" ≠ "Sandstrom"); unmatched names fall back to "Add to directory".
- **`hashchange`:** a link opened in an already-open planner tab imports too; the fragment is cleared after reading.

## 2026-11-23: S0.1 scaffold resolutions (ambiguities)

- **Worker test pool:** `@cloudflare/vitest-pool-workers` 0.23.0 is pinned because STORIES names it. npm marks it deprecated, renamed to `@cloudflare/vitest-plugin`. Migrating is a follow-up; the codemod is `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`.
- **Version pins:** Vite 8, Vitest 4 (required by pool-workers 0.23), TypeScript 5.9 (typescript-eslint caps below 6.1), ESLint 10, React 19.3. Vitest 5 and TypeScript 7 were not used.
- **`compatibility_date`:** `2026-08-22`. Newer dates fail to start the local workerd binary used by the test pool.
- **Type-check split:** three tsconfigs (`tsconfig.app.json` for the SPA, `tsconfig.worker.json` for Worker and domain, `tsconfig.node.json` for tooling and e2e). `npm run typecheck` runs all three.
- **Route registries:** backend uses `import.meta.glob("./*/routes.ts")` and mounts each sub-app under `/api/v1`. Frontend uses `import.meta.glob("./*/routes.tsx")`. `/healthz` is a Worker-owned route outside the registry.
- **Static assets:** `run_worker_first` sends only `/healthz` and `/api/*` to the Worker. `not_found_handling: single-page-application` serves the SPA for client routes.
- **Cron:** two triggers, `*/10 5-21 * * *` and `0 * * * *`, in UTC. The first matches the Stockholm 07–23 window in summer (UTC+2) only. In winter (UTC+1) the window is one hour later. S6.4 must fix this, either by running the hourly trigger and gating on the Clock or by adding a winter trigger.
- **Money and time guardrails:** `src/domain/money.ts` enforces integer kronor. ESLint forbids `Date.now()` in `src/domain` and `src/worker`.
- **Prettier scope:** Markdown is excluded from Prettier (`*.md`, `docs/`, `.github/`) so the canonical plan and story text are not reflowed.
- **Empty folders:** §11.4 folders that have no code yet hold a `.gitkeep`.

## 2026-11-23: Package manager is npm, not pnpm
- **Why:** pnpm and corepack aren't installed on the dev machine, and the sibling `roster-generator` repo uses npm. One tool across both repos keeps the agents' setup simple.
- **Changes:** PLAN §11.4 and STORIES (definition of done, S0.1) now say npm. Scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

## 2026-11-23: Domain purchase deferred until before launch
- **Why:** Ashok will buy it later. None of the early waves need it.
- **Changes:**
  - Development and preview run on `*.workers.dev` with a **Clerk development instance**. Clerk's production instance needs our own domain, so it waits for the domain.
  - S0.6 (real-device spike) splits into two parts. Part A runs now on `workers.dev`: install, push, WhatsApp preview, CPU measurement. Part B runs after the domain is bought: Clerk production sign-in, including Google in the installed app.
  - The domain blocks only S0.6 part B, S1.1's production configuration, and S11.3. Nothing else waits on it.

## 2026-11-23: Docs live in this repo
- `docs/PLAN.md` and `docs/STORIES.md` are the canonical v3. Earlier versions, the council review and the discarded-content files are in `docs/history/`, kept unchanged.
