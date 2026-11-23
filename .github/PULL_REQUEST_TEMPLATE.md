## Story

<!-- Which story in docs/STORIES.md does this PR implement? e.g. s4.1 -->

Story ID: 
Story title: 

## What changed

<!-- One paragraph. Reference only paths this story Owns per docs/STORIES.md. -->

## Tests

- [ ] First commit adds the failing tests from the story's "Tests first" list
- [ ] `npm run typecheck && npm run lint && npm test` pass locally
- [ ] Regression proof included (red → green) for bug fixes

## Scope check

- [ ] No files changed outside the story's **Owns** list (or a contract-change PR is linked)
- [ ] Money: whole kronor as integers, append-only ledger, idempotency keys on writes
- [ ] Time: `Clock` injected, no direct `Date.now()` in domain or worker code; UTC stored

## Ambiguities resolved

<!-- Any plan ambiguities resolved in this PR, recorded in docs/DECISIONS.md. "None" if none. -->
