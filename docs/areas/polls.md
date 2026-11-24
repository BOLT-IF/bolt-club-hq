# Polls (S9.1)

Code: `src/worker/polls/` (API, rules, closing reminder) and `src/app/routes/polls/` (screens). Flag: `polls` (`FLAG_POLLS`, not yet in `wrangler.jsonc`, so off).

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
| `POST /polls` | admin | `{ question, options[2..20], multiChoice?, anonymous?, resultsVisibility?, closesAt? }` → 201. Notifies every active member (`polls`), audits `poll.create` |
| `PATCH /polls/:id` | admin | `{ question? , closesAt?, close?, resultsVisibility? }`, audits `poll.update` |
| `DELETE /polls/:id` | admin | removes votes, options, poll → 204, audits `poll.delete` |
| `PUT /polls/:id/vote` | member | `{ optionIds }`. Replaces the ballot, so no `Idempotency-Key` |

Poll DTO: `id, question, multiChoice, anonymous, resultsVisibility, closesAt, closed, createdAt, options[{id,label}], myVote[], resultsVisible, results: { totalVoters, options[{optionId, votes, voters?}] } | null`.

## Closing reminder (PLAN §10: 24 h before)
Creating a poll, or changing its closing date, calls `markDue(KV, closesAt - 24h)`. The tick hook `poll-closing-reminders` notifies active members who have not voted, for every poll closing within 24 h. It is idempotent per `poll-closing:<pollId>:<memberId>`, so every tick in the window is safe. The scheduler's daily maintenance run catches a lost `markDue`.

## Screens
- `/polls`: list with an Open/Closed chip and "You voted".
- `/polls/:id`: radios (single) or checkboxes (multi), Vote/Update vote, then results (bars, plus names on named polls) or a note saying when results appear.
- `/admin/polls`: create form, list with Close now / Delete (confirmed).
