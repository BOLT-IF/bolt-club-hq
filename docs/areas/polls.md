# Polls (S9.1, S9.2)

Code: `src/worker/polls/` (API, rules, closing reminder), `src/worker/media/` (R2 upload, `/media/:key` serve, 6-month purge), `src/app/components/ImagePicker*`, and `src/app/routes/polls/` (screens). Flag: `polls` (`FLAG_POLLS`, `"on"` in production `wrangler.jsonc`, `"off"` in previews).

## Data (migration `0001_polls`)
- `poll`: `question`, `closes_at` (null = open until an admin closes it), `multi_choice`, `anonymous`, `results_visibility` (enum `always | after_vote | after_close | admins`), `created_at`.
- `poll_option`: ids are `<pollId>_oNN`, so ordering by id keeps the admin's order.
- `poll_vote`: one row per chosen option, PK `(poll_id, member_id, option_id)`. Re-voting replaces the member's rows.

## Rules (`rules.ts`, pure)
- Single choice: exactly one option. Multi choice: one or more distinct options. Options must belong to the poll.
- Closed from `closes_at` on (`now >= closes_at`). Votes on a closed poll get **409 `poll_closed`**.
- Results visibility. Admins always see results. `after_vote`: after you vote, or once the poll is closed. `after_close`: once the poll is closed. `admins`: never shown to members.
- Editable after creation: question, closing date (`{ close: true }` closes now) and visibility. Anonymity, choice mode and options are fixed.

## Anonymous polls
No endpoint ever returns who voted. `toDtos` only joins `member` for polls that are **not** anonymous and whose results the viewer may see, so anonymous results carry counts and no `voters` field, for admins too. Audit rows snapshot poll settings, never votes. `routes.db.test.ts` sweeps every declared route as admin and member, with the poll open and closed. A new route that is missing from the sweep table fails the test.

## API (`/api/v1`)
| Route | Guard | Notes |
|---|---|---|
| `GET /polls` | member | newest first, `{ polls }` |
| `GET /polls/:id` | member | `{ poll }`, 404 if unknown |
| `POST /polls` | admin | `{ question, options[2..20], optionImages?, multiChoice?, anonymous?, resultsVisibility?, closesAt? }` → 201 (≤ 8 images). Notifies every active member (`polls`), audits `poll.create` |
| `PATCH /polls/:id` | admin | `{ question? , closesAt?, close?, resultsVisibility? }`, audits `poll.update` |
| `DELETE /polls/:id` | admin | removes votes, options, poll, and best-effort R2 images → 204, audits `poll.delete` |
| `PUT /polls/:id/vote` | member | `{ optionIds }`. Replaces the ballot, so no `Idempotency-Key` |
| `POST /media` | admin | multipart or raw image (JPEG/PNG/WebP/GIF magic bytes, ≤ 300 KB) → 201 `{ key, url, contentType, size }` |
| `GET /media/:key` | member | serves R2 object outside `/api/v1` (`Cache-Control: private, max-age=31536000, immutable`, `ETag`) |

Poll DTO: `id, question, multiChoice, anonymous, resultsVisibility, closesAt, closed, createdAt, options[{id,label,imageUrl}], myVote[], resultsVisible, results: { totalVoters, options[{optionId, votes, voters?}] } | null`.

## Media & purge (`src/worker/media/`, S9.2)
- Client (`ImagePicker`) resizes images on canvas to ≤ 300 KB before uploading to `POST /api/v1/media`.
- `media-purge` tick hook (`src/worker/media/purge.ts`) deletes R2 objects and clears `poll_option.image_key` 6 UTC calendar months after `poll.closes_at`.

## Closing reminder (PLAN §10: 24 h before)
Creating a poll, or changing its closing date, calls `markDue(KV, closesAt - 24h)`. The tick hook `poll-closing-reminders` notifies active members who have not voted, for every poll closing within 24 h. It is idempotent per `poll-closing:<pollId>:<memberId>`, so every tick in the window is safe. The scheduler's daily maintenance run catches a lost `markDue`.

## Screens
- `/polls`: active polls above collapsible `Past Polls (N)` disclosure, with Open/Closed chips and "Voted".
- `/polls/:id`: radios (single) or checkboxes (multi), `Submit Vote`/`Update Vote`, then results (bars, plus names on named polls) or a note saying when results appear.
- `/admin/polls`: carded `New Poll` form, `Active Polls` list with tonal `Close Now` and soft-red `Delete` (confirmed via `ConfirmDialog`), plus collapsible `Past Polls (N)`.
