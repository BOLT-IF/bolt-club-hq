# Events area

Flag: `FLAG_EVENTS` (`"on"` in production `wrangler.jsonc`, `"off"` in previews). Owners: S3.0 core, S3.1 series, S3.3 one-offs, S8.3 roster deep link, plus `#83` one-off events redesign (`0003_event_audience.sql`).

## Backend (`src/worker/events/`)

| Route (under `/api/v1`) | Guard | Notes |
|---|---|---|
| `GET /events?scope=upcoming\|past` | member | Upcoming: not ended, soonest first (filtered by audience eligibility). Past: ended or completed, newest first. Max 50. Triggers close-on-read (up to 5 due events). |
| `GET /events/by-slug/:slug` | member | `{ event, viewer: { canManage, canSeeAttendees } }`. Returns `403 not_eligible` if restricted audience excludes the viewer. Triggers close-on-read. |
| `GET /events/:id` | member | Same shape and eligibility check. Triggers close-on-read. |
| `GET /series/by-slug/:slug/next` | member | Earliest event that is `scheduled`, RSVP window open, not ended. 404 when none. Triggers close-on-read. |
| `PATCH /events/:id` | member + owner/captain/admin check | Only `title` and `location`. 409 `event_read_only` for past events. (Full detail edits live in `PATCH /events/:id/details`, `rsvp/eventchange.ts`.) |
| `POST /events` (S3.3, `#83`) | member + `Idempotency-Key` | Creates a one-off. Body: `title, startsAt, endsAt, capacity` and optional `location, format, maxGuestsPerMember, rsvpCloseAt, adhocFee, allocationMode, eventScope ("club"\|"member"), audienceKind ("all"\|"series"\|"members"), audienceSeriesId, eligibleMemberIds`. Club one-offs starting within 24h default to `instant` confirm (paid club instant events start `closed` to reuse post-close charging/refills). Member one-offs always confirm immediately and accept an optional `adhocFee` settled outside BOLT HQ. Fires `new_events` notifications to eligible active members (excluding organizer). 201 `{ event: { id, slug } }`. |
| `GET /events/oneoff/options` (S3.3, `#83`) | member | `{ canSetFee, series, members }` for the create form (audience picker + billing options). |
| `GET /events/:id/roster-link` (S8.3) | member + `canManageEvent` | `{ rosterAppUrl, url, textList, players }` for non-cancelled events; `url` is `null` when `rosterAppUrl` is unset. |

- `model.ts` `createEvent(ctx, input)` is the one way to insert an event (random slug, audit row, `publishOg`). S3.1/S3.2/S3.3 call it.
- `rules.ts` is pure: `isReadOnly`, `isOpenForNext`, `canManageEvent`, `canSeeAttendees`, `ogSnapshot`.
- `audience.ts` (`#83`): `canAccessEvent` enforces `event.audience_kind` (`all` | `series` pass holders | explicit `event_eligible_member` list); organizer and admins always have access.
- `oneoff-routes.ts` is mounted inside `routes.ts`. `oneoff-rules.ts` holds `planOneoff` and `rsvpTier(event, isPrepaid)` (one-offs have no tier 1; wired into `src/worker/rsvp/`).
- `deps.ts`: `eventsDeps().publishOg` is wired to `createKvPublishOg` (`src/worker/share/og.ts`, S7.1). Writes `og:event:<slug>` JSON of public fields only (never creator or attendees) after commit. A failed publish is logged and never fails the write.

## Frontend (`src/app/routes/events/`)

- `/events` list (with `New Event` tonal button) and `/events/:slug` detail.
- `/events/new` (S3.3, `#83`): carded create-a-one-off form with audience selector, member vs club billing, and `< 24h` instant-confirm behaviour.
- **Slots** (`slots.tsx`): `RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`. Registrations live in `src/app/routes/events/routes.tsx`.
- `EventDetailPage` renders `OrganizerToolsSlot` whenever `viewer.canManage` (including after `endsAt` so organizers can mark attendance, `#75`) and `AttendeesSlot` whenever `viewer.canSeeAttendees` (active members, A3).

## Slot fillers

| Slot | Components |
|---|---|
| `RsvpSlot` | `RsvpPanel` (S4.2, `#87`, `#88`), `PostCloseRsvpPanel` (S4.4a), `ClaimSpotPanel` (S4.4b) |
| `ShareSlot` | `SharePanel` (S7.1) |
| `OrganizerToolsSlot` | `EventEditPanel` (S4.4c), `CapacityPanel` (S4.4b), `AttendancePanel` (S8.1), `RosterLinkPanel` (S8.3, closed events) |
