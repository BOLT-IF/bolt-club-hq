# Decision log

Decisions made after `PLAN.md` (v3) was written. Newest first. Every entry gives the decision, the reason, and what it changes.

## 2026-11-23: S0.3 PWA service worker (ambiguities)

- **Precache the shell at `/`, not `/index.html`:** the assets binding answers `/index.html` with a 307 (single-page-application handling), and `cache.addAll` rejects redirects, so the install failed silently. `/` returns 200 and is precached instead.
- **No Workbox runtime:** `workbox-*` is only a transitive dependency and `package.json` can't change, so `src/sw/sw.ts` uses plain `caches` and `fetch`.
- **Precached assets are cache-first:** without this, the cached shell's JS could not load offline.
- **Network-first allowlist:** `/api/v1/me` and `/api/v1/config` (PLAN §11.6). Neither exists yet; the list is a constant in `src/sw/routes.ts` for later stories to extend.
- **Page glue and Apple tags are injected by `vite.config.ts`:** `src/app/main.tsx` and `index.html` are outside S0.3's Owns list. The register chunk is a Rollup entry, and the Apple meta tags and manifest link come from the plugin's `transformIndexHtml`.
- **Icons:** generated PNGs (solid PayPal blue, white bar) in `public/icons/`, with a maskable variant whose glyph stays in the safe zone. Replace with brand artwork before launch (S11.3).
- **Test file location:** `tests/e2e/pwa.spec.ts` is outside Owns. Playwright's `testDir` is `tests/e2e`, and the story requires Playwright tests first, so the spec sits there. Integrator approved this location as the spec home.
- **Update prompt test, option 2 fallback (flagged):** the integrator chose option 1 (a real second build on a second port). That is not workable. A service worker's update check only fetches `/sw.js` from the origin that registered it, so a second server on another port cannot deliver a changed worker. Making it work would need a proxy in front of the first server, plus a second `dist` and a sequenced build in CI. The test therefore uses option 2: an init script makes `registration.waiting` report a worker, then reloads the page. The prompt and the reload path are the app's real code. Only the waiting state is faked. The test runs in the desktop project only; iPhone and Android skip it.

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
