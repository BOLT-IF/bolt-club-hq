# Area: terms, series, captains, clone (S3.1)

Flag: `FLAG_EVENTS` (off until the integrator flips it). Backend `src/worker/terms/`, frontend `src/app/routes/admin/terms/`.

## API (`/api/v1`)

| Route | Who | Notes |
|---|---|---|
| `GET /terms`, `POST /terms` | admin | list has `seriesCount`; create is a draft |
| `GET /terms/:id` | admin | term plus its series with captains |
| `PATCH /terms/:id` | admin | `name` any time; `startsOn`/`endsOn` while draft; `status` one step forward |
| `DELETE /terms/:id` | admin | empty draft only |
| `POST /terms/:id/clone` | admin | `Idempotency-Key` required; body `{ name?, startsOn, endsOn }` |
| `GET /series` | member | admin: all; captain: own; others: empty |
| `GET /series/captain-candidates` | admin | active members |
| `POST /series` | admin | not into a closed term |
| `GET /series/:id` | admin or captain of it | |
| `PATCH /series/:id` | admin; captain of it (`location`, `maxGuestsDefault`, `rsvpCloseOffsetMin` only) | cap-below-sold needs `overrideCapBelowSold` (admin) |
| `DELETE /series/:id` | admin | no events or passes |
| `PUT /series/:id/captains` | admin | `{ memberIds }` replaces the set; active members only |

Every mutation writes an `audit_log` row in the same transaction.

## Rules

- **Status machine:** `draft → open_for_passes → active → closed`, forward one step at a time (`rules.ts`). Anything else is 409 `invalid_transition`.
- **Skip-dates lock** (PLAN §6.5): moving a term to `open_for_passes` sets `skip_dates_locked` on all its series; a series created later in a non-draft term starts locked. Editing skip-dates themselves is S3.2.
- **`pass_cap`** (A8): minimum capacity of the series' non-cancelled events, else the series capacity. Recomputed on every series edit. Lowering capacity so the cap falls below active passes sold is 409 `cap_below_passes_sold` unless an admin sends `overrideCapBelowSold: true` (recorded in the audit row).
- **Clone:** new draft term with `cloned_from_term_id`; copies series fields only. No events, passes, captains or skip-dates; new share slugs; `pass_cap = capacity`.
- **Series slugs:** 10 characters from a 32-symbol alphabet, from `crypto.getRandomValues`.

## Not here

Event generation, skip-date editing, occurrence edits: S3.2. The series share page and `/series/by-slug/:slug/next`: S3.0.
