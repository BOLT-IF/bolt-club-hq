# Instructions for AI agents

Read `docs/PLAN.md`, `docs/STORIES.md` and `docs/DECISIONS.md` before starting a story.

## Rules
1. **One story per PR.** Edit only the paths listed under the story's **Owns**. If you need to change a file outside them, stop and ask the integrator (root agent) for a contract-change PR.
2. **Tests first.** The first commit adds failing tests for the story's "Tests first" list. Then write the code that turns them green.
3. **Definition of done:** STORIES.md, "Definition of done". At minimum, `npm run typecheck && npm run lint && npm test` pass locally.
4. **Don't guess.** If the plan is ambiguous, ask instead of inventing behavior. Record every resolved ambiguity in `docs/DECISIONS.md`.
5. **Money:** whole kronor as integers, never floats. The ledger is append-only. Every write uses an idempotency key.
6. **Time:** inject `Clock` and never call `Date.now()` directly in domain or worker code. Store UTC; do Stockholm-time maths only through `Clock`.
7. **Branches:** `story/<id>-<slug>`, for example `story/s4.1-allocation`. Stack on the parent story's branch only if it has exactly one parent.
