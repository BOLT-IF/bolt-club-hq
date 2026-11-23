# Decision log

Decisions made after `PLAN.md` (v3) was written. Newest first. Every entry gives the decision, the reason, and what it changes.

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
