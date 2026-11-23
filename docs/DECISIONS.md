# Decision log

Decisions made after `PLAN.md` (v3) was written. Newest first. Every entry gives the decision, the reason, and what it changes.

## 2026-11-23: S0.5 CI, deploy, backups (ambiguities resolved)

- **Owns-scope exception (additive only):** `docs/DECISIONS.md` is edited outside S0.5's Owns. Only this section is added at the top, as AGENTS.md rule 4 requires. `check-owns.sh` allows this file for every story.
- **Check scripts are bash, not TypeScript.** `npm run lint` type-checks every `.ts`/`.js` file against the three tsconfigs, and `scripts/ci/` is not in any of them. Bash keeps the checks out of the type graph without editing tsconfig or package.json, which are outside S0.5's Owns.
- **Playwright shards:** 4 runners, as in `roster-generator`. Each shard runs its own Postgres service container, so the shards share no state. The `e2e-tests` summary job keeps a branch-protection rule on that name working. The e2e jobs depend on `ci`, so a unit failure does not spend four runners.
- **Browser install:** `chromium webkit`, not roster's `chromium firefox webkit`. `playwright.config.ts` runs the iPhone project on WebKit and does not use Firefox. The step has a 10-minute `timeout-minutes` cap because a stalled CDN download hung the old job for 25+ minutes.
- **Owns check branch convention:** the story ID is read from the head branch `story/<id>-<slug>`. A branch that does not follow the convention skips the check with a notice, rather than failing every PR.
- **Deploy order:** `wrangler deploy`, then `drizzle-kit migrate`, then the smoke test, as the story states. Migrations therefore run after the new Worker is live, so every migration must be expand-only. Rollback is `wrangler rollback`; migrations are not rolled back automatically.
- **Secrets gate:** each scheduled or deploy job runs `require-secrets.sh` first and skips with a notice when a secret is missing. The job stays green until the secrets exist. An unknown job name fails closed.
- **Backup retention vs artifacts:** PLAN §16 requires 90-day backup retention. GitHub artifacts are not a backup store, so the workflow uploads a 30-day artifact only. The off-site store is an open item, recorded in `docs/ops/backups.md`.
- **Restore drill fetch step:** the drill cannot yet fetch the latest dump, because the off-site store is not chosen. The fetch step fails on purpose so the drill is never reported green without a restore. It is the first thing to replace once the store exists.
- **Neon storage correction:** PLAN §11.3 says "0.5 GB" for Neon free. Neon's current plans page gives 1 GB per project (20 GB account total). `docs/ops/budgets.md` records the verified figure.
- **Cloudflare Cron Triggers:** the Free plan allows 5 per account. We use 2, as in PLAN §11.3. Recorded in `docs/ops/budgets.md`.
- **Unverified:** the GitHub Actions included-minutes figure and the `@lhci/cli@0.15` pin could not be checked from the build machine (the GitHub billing page and the npm registry were unreachable). Both are flagged in `docs/ops/budgets.md` and `docs/ops/backups.md` for confirmation on the first real run.

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
