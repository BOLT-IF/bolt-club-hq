# Events area

Flag: `FLAG_EVENTS` (off until the integrator flips it). Owners: S3.0 core, S3.1 series, S3.3 one-offs.

## Backend (`src/worker/events/`)

| Route (under `/api/v1`) | Guard | Notes |
|---|---|---|
| `GET /events?scope=upcoming\|past` | member | Upcoming: not ended, soonest first. Past: ended or completed, newest first. Max 50. |
| `GET /events/by-slug/:slug` | member | `{ event, viewer: { canManage, canSeeAttendees } }` |
| `GET /events/:id` | member | Same shape. |
| `GET /series/by-slug/:slug/next` | member | Earliest event that is `scheduled`, RSVP window open, not ended. 404 when none. |
| `PATCH /events/:id` | member + owner/captain/admin check in handler | Only `title` and `location`. 409 `event_read_only` for past events. |
| `POST /events` (S3.3) | member + `Idempotency-Key` | Creates a one-off. Body: `title, startsAt, endsAt, capacity` and optional `location, format, maxGuestsPerMember, rsvpCloseAt, adhocFee, allocationMode`. Member: free + instant only (fee/tiered = 403 `admin_only`). Admin: `admin_oneoff`, tiered by default. 201 `{ event: { id, slug } }`. |
| `GET /events/oneoff/options` (S3.3) | member | `{ canSetFee }` for the create form. |

- `model.ts` `createEvent(ctx, input)` is the one way to insert an event (random slug, audit row, `publishOg`). S3.1/S3.2/S3.3 call it.
- `rules.ts` is pure: `isReadOnly`, `isOpenForNext`, `canManageEvent`, `canSeeAttendees`, `ogSnapshot`.
- `oneoff-routes.ts` is a sub-app mounted inside `routes.ts` after its context middleware. `oneoff-rules.ts` holds `planOneoff` (validation + kind) and `rsvpTier(event, isPrepaid)`: one-offs have no tier 1, so S4.2 must use it.
- `deps.ts` `configureEventsDeps({ publishOg })`. Production default is a **no-op** until S7.1 (the real KV `publishOg`) calls it.
- OG snapshot key `og:event:<slug>`, value JSON of public fields only (never creator or attendees).
- `PATCH` and `createEvent` publish OG after commit. A failed publish is logged and never fails the write.

## Frontend (`src/app/routes/events/`)

- `/events` list and `/events/:slug` detail.
- `/events/new` (S3.3, `new/routes.tsx`): create-a-one-off form. Admins also see fee and tiered. Opens the new event on success. No link to it yet (follow-up: a "New event" button on the list).
- **Slots** (`slots.tsx`): `RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`. A later story calls
  `registerSlot("RsvpSlot", Component)` at module load in its own `routes.tsx` (`Component` gets `{ event, viewer }`).
  Several registrations render in order. An empty slot renders nothing.
- The page, not the slot, enforces visibility: `OrganizerToolsSlot` only when `viewer.canManage` and the event is not read-only; `AttendeesSlot` only when `viewer.canSeeAttendees` (active members, A3).
- Slot fillers must import `registerSlot` from `src/app/routes/events/slots`. Their `routes.tsx` is globbed eagerly, so the registration runs at app start.

## Who fills what

| Slot | Story |
|---|---|
| `RsvpSlot` | S4.2 |
| `ShareSlot` | S7.1 |
| `OrganizerToolsSlot`, `AttendeesSlot` | S8.1 / S8.3 |
