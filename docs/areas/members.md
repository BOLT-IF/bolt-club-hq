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

Approval of pending members (S1.3), erasure (S2.5), audit viewer (S2.4), notification preferences. No feature flag: there is no `members` flag in `/config`, and the pages are admin-gated or own-data.
