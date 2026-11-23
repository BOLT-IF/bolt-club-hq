# Discarded / superseded content (v1 → v2)

Preserved so nothing important is silently lost. Each entry: what, where it came from, why it's out.

## Rejected council proposals

| Proposal | Source | Why dropped |
|---|---|---|
| Club membership fee charged by the tick (S5.5 in R1's numbering) | R1 C2 | Ashok: "pay quarterly" means settle the balance. No separate fee. |
| Pass instalments (2 × quarterly) | R1 C2 | Same |
| Pass "reserved until admin confirms payment" | R1 C3 option a | Ashok chose immediate priority with revocation |
| Auto credit of pass_price/N per cancelled night | R1 H3 option b | Ashok: no compensation, terms stated upfront |
| Makeup sessions as a compensation mechanism | R1 H3 option c | Same. Admins can still create extra events manually. |
| Promoted player must accept within X h / free decline within 2h | R1 M3 | Ashok: no. Auto-promotion is final. Mitigation kept: promotion stops at the cutoff (A6), then claim-a-spot. |
| Members create polls | R1 L4 | Ashok: admins only |
| Resell a leaving member's pass seat | R1 H2 | Ashok: seat not resold |
| FastAPI serving the SPA on onrender.com (0 SEK option) | R2 C1 option a | Ashok bought a domain. The Cloudflare edge is strictly better (previews, email, cookies). |
| Direct spot transfer member → member | R1 L2 | Modeled instead as cancel + refill (no fee if refilled). Avoids a second code path. |
| Tiered allocation as the default for free one-offs | v1 S3.3/S4.2 | Ashok: free member one-offs confirm instantly, first-come |

## v1 content superseded

| v1 text | Replaced by |
|---|---|
| §5.2 invariant 7 "One-off events always have adhoc_fee = 0" | Narrowed: only *member* one-offs are free. Admin one-offs can be paid (§6.8). |
| §7 "Google sign-in uses the redirect flow, which works in standalone mode" (stated as fact) | Unproven. Spike S0.8. In standalone, email code is offered first. |
| §7 step 2 "/e/{slug} served by the backend" | Served by a Cloudflare Worker with a KV cache, falling back to the backend (cold-start safe) |
| §11.1 Hosting "stays on Render free", tick every 10 min 24/7 | Domain + Cloudflare in front of Render. Adaptive tick (10 min daytime, hourly at night) with `next_due_at` short-circuit. Redis dropped. |
| §13 "backend pytest" / STORIES DoD | Repo uses `unittest`. v2 adds pytest+Hypothesis *alongside*, and `discover` still runs. Playwright path is `frontend/tests/`. |
| S0.2 "Alembic baseline matching current schema" (implied `upgrade`) | Baseline from the **production** schema dump, `alembic stamp` on prod, then remove `_ensure_table_columns` |
| S1.1 "Google ID token verification" | Split S1.1a (email) / S1.1b (Google redirect, with standalone fallback) |
| S3.3 owning the events list | Moved to S3.0 Events core |
| S4.4 single L story | Split S4.4a/b/c |
| S6.5 single story | Split S6.5a engine / S6.5b admin UI |
| S6.6 owning `club/reminders/broadcast*` | Own folder `club/broadcasts/` |
| S11.1 owns `frontend/e2e/club/` | `frontend/tests/club/` |
| Critical path "12 steps" | It was actually 15 in v1. v2 is 10. |
| v1 wave table | Inconsistent with the per-story dependencies. Rebuilt in STORIES-v2. |
| A6 auto-promote then claim window (unchanged), but v1 implied people could decline freely | Clarified: a promoted person who cancels is a late cancel (charge stands unless refilled) |
| §16 backlog "Bank CSV import" | Still backlog. A manager.io *export* is now in scope (S5.6). |
