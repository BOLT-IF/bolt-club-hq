# Council review of PLAN-v1 / STORIES-v1

Date: 2026-11-21. Three independent reviewers, high effort, with fresh context (they saw only the docs and the repo):
- **R1 Requirements & business rules**
- **R2 Architecture, PWA, security, free-tier hosting**
- **R3 Decomposition & dependency graph**

Disposition key: **A** = accepted into v2 · **U** = sent to Ashok, decision recorded · **R** = rejected (reason given; also listed in `DISCARDED-v2.md`).

## Decisions from Ashok during the council (2026-11-21)

| Question | Answer |
|---|---|
| "Pay XXX quarterly" meaning | Settle your balance. No membership fee and no instalments. |
| Unpaid pass priority | Priority starts at purchase. An admin can revoke a pass that is still unpaid after N days. |
| Cancelled series night | No compensation. Pass terms say "up to N sessions". Skip-dates are locked once sales open. |
| Domain | **Buy a domain** (about 100–150 SEK/yr, the only cost). Cloudflare free sits in front of it. |
| Admin paid one-off events | Yes. Pass holders pay too. |
| Member leaves mid-term | The pass seat is **not** resold |
| Series captains (non-admin organizers) | Yes |
| Waitlist promotion must be accepted | **No.** Auto-promotion stands. |
| Members create polls | No (admins only) |
| Free member one-offs | Instant first-come confirmation |
| Repo visibility | Private |
| Bookkeeping duty | **Yes.** The balance sheet and P&L are kept in **manager.io**. |

## R1: Requirements & business rules

| ID | Finding | Disp. | Where in v2 |
|---|---|---|---|
| C1 | No member-side "I've paid" → no *pending* state | A | §9, S5.5 |
| C2 | "Subscriptions / pay quarterly" unmodeled | U → settle balance only | §2 |
| C3 | Unpaid pass grants priority forever | U → immediate, revocable | §6.5, S5.3 |
| H1 | Admins can't run paid one-off events | U → yes, pass holders pay | §6.8, S3.3 |
| H2 | No member exit lifecycle | A + U (seat not resold) | §6.7, S2.1 |
| H3 | Pass value on cancelled nights | U → none, terms upfront, skip-dates locked | §6.5, S3.2 |
| H4 | Event edits after close (time, location, fee) | A | §6.6, S4.4c |
| H5 | WhatsApp link dead-ends for non-members | A ("request to join" from an event link, admin approves) | §7, S1.3 |
| M1 | "Refilled" undefined when the event isn't full | A | §6.4 |
| M2 | Free one-offs: instant confirm | U → yes | §6.8 |
| M3 | Promoted player must accept | U → **no** | R (see DISCARDED) |
| M4 | Admin acting on own ledger | A | §4, S5.4 |
| M5 | Series captains | U → yes | §4, S3.1 |
| M6 | Term rollover / clone | A | S3.1 |
| M7 | pass_cap below passes sold | A | §6.6, S3.2 |
| M8 | Admin tasks in the inbox | A | §10.2, S6.1 |
| L1 | Round half-up | A | §6.5 |
| L2 | Spot transfers | A (cancel + refill semantics, no direct transfer) | §6.4 |
| L3 | Credit balance display | A | §9 |
| L4 | Member polls | U → no | — |
| L5 | Guests added after close | A | §6.4 |
| L6 | Close time stored UTC from absolute offset | A | §11.3 |
| L7 | Traceability gaps | A | STORIES traceability |

## R2: Architecture, PWA, security, free tier

| ID | Finding | Disp. | Where in v2 |
|---|---|---|---|
| C1 | Split hosts + `onrender.com` on the Public Suffix List → cookies break on iOS | A (domain + Cloudflare same-origin) | §11.1, S0.8 |
| C2 | WhatsApp preview crawler times out on a cold Render | A (edge-rendered OG from a Worker + KV cache) | §7, S7.1 |
| C3 | Login email needs a verified sending domain | A (domain) | §11.1 |
| C4 | Neon compute-hours and Render instance-hours budget | A (adaptive tick, `next_due_at` short-circuit, drop Redis) | §11.1, S6.4 |
| C5 | Concurrency/money tests can't run on SQLite | A (Postgres in CI for club tests) | §13, S0.5 |
| H1 | Google sign-in inside iOS standalone unproven | A (spike; email code first in standalone) | §7, S0.8 |
| H2 | Scanners burn magic links; brute-force via many challenges | A (confirm page POST; Postgres rate limits) | S1.1a |
| H3 | No CSRF beyond SameSite | A | §11.3 |
| H4 | SW caching pitfalls (hang, per-user leak, fallback scope, updates) | A | S0.3 |
| H5 | iOS push rules, re-subscribe, VAPID never rotate, coverage | A | S6.2 |
| H6 | Double-submit on payments | A (HTTP Idempotency-Key) | §11.3, S0.5 |
| H7 | GDPR vs append-only ledger | A + bookkeeping duty → 7-year money retention | §16, S2.5 |
| H8 | Alembic baseline vs a lazily migrated prod DB | A (stamp from prod schema; cutover task) | S0.2, S0.4 |
| M1 | Close-on-read inside GET: locking, bounded | A | §6.3 |
| M2 | Silent tick failure | A (healthchecks.io dead-man's switch, Sentry free) | S0.7, S6.4 |
| M3 | Share page leakage, CSP | A | S7.1 |
| M4 | Pending members' visibility; invite revoke | A | S1.3 |
| M5 | Lost sole admin | A (bootstrap admin re-assertable from env) | §4 |
| M6 | timestamptz, UTC server | A | §11.3 |
| L1 | Neon storage vs images | A (cap + purge) | S9.2 |
| L2 | iOS standalone has no back button | A | S0.6 |
| L3 | Scheduled Lighthouse + restore drill | A | S0.4 |

## R3: Decomposition

| Finding | Disp. | Where |
|---|---|---|
| Login sits in front of everything → test-identity override | A | S0.5 |
| Single baseline migration for all v1 tables; one-head CI check | A | S0.5 |
| Auto-discovered routers/routes/menus; per-area api/copy/docs | A | S0.1, S0.6 |
| Pre-add all deps (lock-file conflicts) | A | S0.5, S0.6 |
| New S0.5 contracts, S0.6 FE foundation, S0.7 observability, S2.3 settings, S2.4 audit viewer, S3.0 events core | A | STORIES |
| Splits S1.1a/b, S4.4a/b/c, S6.5a/b; slim S3.3 | A | STORIES |
| Event page slots; notify() policy chain; broadcasts own folder | A | S3.0, S6.1, S6.6 |
| Edge fixes (remove ones that serialize work, add the missing ones) and corrected waves | A | STORIES DAG |
| Repo facts: unittest not pytest; Playwright lives in `frontend/tests/` | A | STORIES DoD |
| Tighten acceptance criteria (worked examples with expected output) | A | S4.1 etc. |
| Merge to main behind flags rather than deep stacks | A (stack only single-parent chains) | STORIES protocol |
| CI check that a PR stays within its Owns paths | A | S0.5 |

## Council-surfaced items that became new scope
- **Accounting export to manager.io** (from the bookkeeping answer): new story S5.6.
- **Payment claims** (R1 C1): new story S5.5.
- **Privacy/GDPR + retention** (R2 H7): new story S2.5.
- **Same-origin edge + real-device auth spike** (R2 C1/H1): new story S0.8. It needs a human with a real iPhone.
