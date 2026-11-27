# Instructions for AI agents

Before creating or modifying any UI screen or component, read and follow `docs/PWA_UI_Rules.md`.

Read `docs/CHECKPOINT.md`, `docs/STATUS.md`, `docs/DECISIONS.md` (newest first), `docs/PLAN.md`, and `docs/STORIES.md` before starting work.

## Rules
1. **One story per PR.** For story branches (`story/<id>-<slug>`), edit only the paths listed under the story's **Owns** in `docs/STORIES.md` (enforced by CI). If you need to change a file outside them, stop and ask the integrator (root agent) for a contract-change PR.
2. **Tests first.** The first commit adds failing tests for the story's "Tests first" list. Then write the code that turns them green.
3. **Definition of done:** `docs/STORIES.md`, "Definition of done". At minimum, `npm run typecheck && npm run lint && npm test` pass locally.
4. **Don't guess.** If the plan is ambiguous, ask instead of inventing behavior. Record every resolved ambiguity at the top of `docs/DECISIONS.md`.
5. **Money:** whole kronor as integers, never floats. The ledger is append-only. Every write uses an idempotency key.
6. **Time:** inject `Clock` and never call `Date.now()` directly in domain or worker code. Store UTC; do Stockholm-time maths only through `Clock`.
7. **Branches:** `story/<id>-<slug>` for stories (e.g. `story/s5.6-manager-export`), or `feat/<slug>` / `fix/<slug>` for post-story enhancements and bug fixes. Stack on a parent story's branch only if it has exactly one parent.
