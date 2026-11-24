# RSVP area

Flag: none of its own. It is reached only through the event page, which sits behind `FLAG_EVENTS`. Owners: S4.2 pre-close, S4.3 close (`src/worker/rsvp/close*`), S4.4a/b late changes and claims.

## Backend (`src/worker/rsvp/`)

| Route (under `/api/v1`) | Guard | Notes |
|---|---|---|
| `GET /events/:id/rsvp` | member | `{ rsvp: RsvpView \| null }`, the caller's own RSVP. |
| `PUT /events/:id/rsvp` | member + `Idempotency-Key` | Body `{ guests?: string[] }`: names in order, and the count is the length. Creates or updates the one RSVP. |
| `DELETE /events/:id/rsvp` | member + `Idempotency-Key` | Pre-close cancel: `cancelled`, guests cancelled, no ledger. |

`RsvpView` = `{ id, status, tier, guests: [{ id, name, status }] }`. A cancelled RSVP shows no guests.

Errors: 400 `invalid_body` / `guest_limit` (`max`), 404 `not_found` (unknown event, or DELETE with no RSVP), 409 `rsvp_closed` (status not `scheduled`, `rsvp_close_at` passed, or ended). Pending, inactive and erased members get 403 from the guard.

- **Tiered** (`allocation_mode=tiered`): tier 1 (`isPrepaid`, series events only) is `confirmed`, otherwise tier 2 and `requested`. Guests are tier 3 and `requested`. No seat counting before close: S4.3 allocates.
- **Instant**: after every change, `fillFromWaitlist("instant", …)` from `src/domain/allocation` places waitlisted members and guests first-come. A new or reopened RSVP starts `waitlisted` and is confirmed if a seat is free. Confirmed people are never moved. A cancel frees seats and promotes the earliest (`rsvp_changed` with `reason: "promoted"`).
- **Concurrency**: every write locks the event row (`SELECT … FOR UPDATE`), so "one RSVP per member" and capacity hold without a unique index.
- **`rsvp_changed`** outbox event, in the same transaction: `{ eventId, memberId, rsvpId, status, previousStatus, tier, guests, reason: rsvp|cancel|promoted|member_exit }`. Written only when something visible changed.
- **Ports**: `deps.ts` `configureRsvpDeps({ prepaid })`. The production default is `nobodyPrepaid` (always false) until S5.3.
- **Member exit**: `cancel.ts` `cancelMemberRsvps(db, clock, { memberId, at, idempotencyKey })` and `rsvpCancelAdapter(db, clock)` match S2.1's `RsvpCancelPort`. Only pre-close RSVPs are cancelled; closed events are left for S4.4a's late-cancel rules.

## Frontend (`src/app/components/rsvp/`)

- `RsvpPanel` fills `RsvpSlot` (`register.tsx`, imported by `src/app/routes/events/routes.tsx`).
- It shows a status chip (Confirmed, Requested, Waitlisted), a guest stepper capped at `maxGuestsPerMember` with optional names, RSVP/Update and Cancel. Each tap gets a fresh `Idempotency-Key`.
- After close it shows the status only ("RSVPs are closed"). It renders nothing on 401/403, because the page already explains pending access.
