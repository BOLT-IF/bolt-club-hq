# Decision log

Decisions made after `PLAN.md` (v3) was written. Newest first. Every entry gives the decision, the reason, and what it changes.

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
