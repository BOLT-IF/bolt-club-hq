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
- **Close processing (`close.ts`, `close-tick.ts`)**:
  - Triggered by close-on-read (capped at 5 due events; wired into `GET /events`, `GET /events/:id`, `GET /events/by-slug/:slug`, `GET /series/by-slug/:slug/next` in `events/routes.ts` and `GET /events/:id/rsvp` in `rsvp/routes.ts`) and by the `"rsvp-close"` tick hook registered at module load from `rsvp/routes.ts`.
  - Runs in one transaction per event: locks the event row (`SELECT … FOR UPDATE SKIP LOCKED`), re-checks `closed_processed_at` / `status === "scheduled"` / `rsvp_close_at <= now`, runs `allocate`, persists `confirmed` (`confirmedAt` from `Clock`, preserving existing pre-close `confirmedAt`) and `waitlisted`, updates the event to `closed`, writes charges via `createLedgerService({ db: tx, clock })` (`close:<eventId>:<memberId>` `adhoc`, `close:<eventId>:guest:<guestId>` `guest` on the host; 0 for `member_oneoff` or zero-fee events; 0 for tier-1 prepaid series members' own seats, still charging them for confirmed guests; everyone confirmed charged on `admin_oneoff`), notifies participants whose status or guest status resolved via `createNotifyPort({ db: tx, clock })` (`rsvp_status`, key `close-notify:<eventId>:<memberId>`, link `/events/<slug>`), and writes an `event_closed` outbox row.
  - `oneoff-routes.ts` calls `markDue(kv, row.rsvpCloseAt)` on one-off creation; `"rsvp-close"` calls `markDue(ctx.kv, next)` for the earliest remaining unclosed scheduled event.
- **Post-close (`postclose.ts`, S4.4a)**:
  - `GET /events/:id/rsvp/postclose`, `PUT /events/:id/rsvp/late`, `POST /events/:id/rsvp/late-cancel`.
  - Late RSVPs confirm immediately when space is free and waitlist is empty; otherwise join waitlist in tier order (prepaid tier 1 at top without bumping confirmed; guests added after close are tier 3). Guest name edits are free.
  - Late cancel of a confirmed member cascades to their guests (`late_cancelled`), leaves charges standing unless refilled, and runs `promote()` (auto-promotes before `autoPromoteCutoffMin`, or marks `offered` and notifies from cutoff onward).
  - Refills reverse the earliest unrefilled late-cancel's charge (`refill:<chargeId>`) and notify the member.
- **Claim & capacity (`claim.ts`, `capacity.ts`, S4.4b)**:
  - `POST /events/:id/claim` (`Idempotency-Key`, optional `{ guestId }`) serializes on `event FOR UPDATE` so concurrent claims have one winner, charges non-prepaid/guests, runs refills, and clears remaining `offered` rows when full.
  - `PATCH /events/:id/capacity` (`Idempotency-Key`, `canManageEvent`, `{ capacity, override? }`) blocks lowering below confirmed without admin `override: true`, waitlists excess confirmed (latest first in reverse tier order) and notifies them on override, and promotes/offers from the waitlist when raising capacity.
- **Event cancellation & material changes (`eventchange.ts`, S4.4c)**:
  - `POST /events/:id/cancel` cancels the event, cancels all active RSVPs/guests, reverses all unreversed charges (`event-cancel:<chargeId>`), and notifies active/charged participants.
  - `PATCH /events/:id/details` updates `title`, `location`, `startsAt`, `endsAt`, `rsvpCloseAt`, or `adhocFee` (returning `409 event_closed` if `adhocFee` is edited after close). Material changes (`startsAt`, `endsAt`, `location`) after close set `materialChangeAt` and notify active participants; `lateCancelRsvp` reverses charges for free (`free-cancel:<chargeId>`) while `now < materialChangeAt + 24h`.

## Frontend (`src/app/components/rsvp/`)

- `RsvpPanel` fills `RsvpSlot` (`register.tsx`, imported by `src/app/routes/events/routes.tsx`).
- `PostCloseRsvpPanel` (`postclose.tsx`, imported by `src/app/routes/events/routes.tsx`) also fills `RsvpSlot` and renders late RSVP, guest edits, and late cancel controls when the event is closed and editable.
- `ClaimSpotPanel` (`claim.tsx`) fills `RsvpSlot` when the member or a guest is `offered`; `CapacityPanel` (`claim-capacity.tsx`) fills `OrganizerToolsSlot` for managers. Both are imported by `src/app/routes/events/routes.tsx`.
- It shows a status chip (Confirmed, Requested, Waitlisted), a guest stepper capped at `maxGuestsPerMember` with optional names, RSVP/Update and Cancel. Each tap gets a fresh `Idempotency-Key`.
- After close it shows the status only ("RSVPs are closed"). It renders nothing on 401/403, because the page already explains pending access.
