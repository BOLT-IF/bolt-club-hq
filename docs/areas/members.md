# Members area (S2.1)

Code: `src/worker/members/` (API), `src/app/routes/admin/members/` and `src/app/routes/profile/` (UI), shared UI helpers in `src/app/routes/members/`.

## API (`/api/v1`)

| Route | Guard | Notes |
|---|---|---|
| `GET /admin/members` | admin | Every status, with `paymentRef`. Never returns the Clerk id. |
| `GET /members` | member | Active members only: `id`, `displayName`, `rosterName`. |
| `GET /me/profile` | member | Own profile and `paymentRef`. |
| `PATCH /members/:id` | owner-or-admin | `displayName`, `rosterName` (owner or admin); `paymentRef` (admin only). |
| `PATCH /members/:id/role` | admin | `{ role }`. Last active admin can't be demoted (409 `last_admin`). |
| `PATCH /members/:id/status` | admin | `{ status: "active" \| "inactive" }`. Deactivate cancels future RSVPs via the `rsvp.cancel` port. |

Every change writes an `audit_log` row in the same transaction (`member.update`, `member.role_change`, `member.status_change`). A change that alters nothing writes nothing.

## Rules

- **Last admin:** role and status changes lock all active admins (`FOR UPDATE`, id order) and then the target, so two admins demoting each other at once leave exactly one.
- **`payment_ref`:** trimmed and upper-cased, `^[A-Z0-9][A-Z0-9-]{2,39}$`. The DB unique index is the arbiter under concurrency (409 `payment_ref_taken`).
- **Exit (PLAN §6.7):** deactivate sets `status=inactive`, `left_at`. Inactive members are refused by the plain member guard. Routes that must stay open to them (own ledger, own attendance) opt in with `requireGuard("member", { allowInactive: true })`.
- **`rsvp.cancel` port:** `src/worker/members/rsvp-cancel.ts`. Production default is a no-op until the RSVP story calls `configureRsvpCancel(realAdapter)`. The recording fake `rsvp-cancel.fake.ts` is test only.

## Not in this story

Approval of pending members (S1.3), audit viewer (S2.4), notification preferences. No feature flag: there is no `members` flag in `/config`, and the pages are admin-gated or own-data. Erasure, data export, and retention purges are implemented in `src/worker/privacy/` (S2.5, documented below).

## Privacy, export, erasure, retention (S2.5)

Code: `src/worker/privacy/` (API, Clerk user deletion, retention cron hook), `src/app/routes/privacy/` (UI at `/privacy`).

| Route | Guard | Notes |
|---|---|---|
| `GET /me/export` | member, `allowInactive` | Exports the caller's personal data as JSON across every PII table (`member`, `joinRequest`, `seriesCaptain`, `pass`, `rsvp`, `guest`, `ledgerEntry`, `paymentClaim`, `notification`, `pushSubscription`, `notificationPref`, `notificationSendLog`, `pollVote`, `auditLog`). |
| `POST /admin/members/:id/erase` | admin | Requires `balance === 0` (`409 nonzero_balance`) and not last active admin (`409 last_admin`). Strips PII, sets `status: "erased"` and `"Former member #<id>"`, pseudonymizes `guest` names and `audit_log` JSON, deletes Clerk user via `DELETE /v1/users/{clerkUserId}` (rolling back on failure), keeps `ledger_entry` rows untouched, and cancels future open RSVPs via `rsvp.cancel`. Idempotent on already erased members. |

Retention tick hook (`privacy-retention-purge` in `src/worker/privacy/retention.ts`, registered via `registerTickHook`):
- Deletes `notification_send_log` entries older than 365 days (`SEND_LOG_RETENTION_DAYS`).
- Deletes R2 `MEDIA` objects and clears `poll_option.image_key` for polls closed more than 180 days ago (`POLL_IMAGE_RETENTION_DAYS`).


## Invites and join requests (S1.3)

Code: `src/worker/members/invites.ts`, `join.ts` (mounted from `routes.ts`); UI `src/app/routes/join/`, `src/app/routes/admin/approvals/`.

| Route | Guard | Notes |
|---|---|---|
| `GET/POST /invites`, `DELETE /invites/:id` | admin | `{ expiresInDays?, maxUses? }`; state `active\|revoked\|expired\|used_up`. |
| `POST /join-requests` | signed in (pending) | `{ via: "invite", token }` or `{ via: "event_link"\|"series_link", slug }`. 201 new, 200 existing, 410 invite refused, 404 unknown, 409 already a member. Notifies admins (`admin_tasks`) once. |
| `GET /join-requests/mine` | signed in | `{ status, request }` for the waiting screen. |
| `GET /admin/join-requests` | admin | Pending queue with `source` (event title / series name). |
| `POST /join-requests/:id/approve\|reject` | admin | Approve activates; reject deletes the request. |

Frontend: `/join`, `/join/:token`, `/join/event/:slug`, `/join/series/:slug`. The stored RSVP intent is completed client-side after approval (`joinIntent.ts`, DECISIONS 2026-11-24 S1.3).
