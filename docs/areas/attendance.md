# Attendance area (S8.1, S8.2)

Code: `src/worker/attendance/` (API + tick hook + me-history), `src/app/components/organizer/attendance*` (organizer UI, registered into `OrganizerToolsSlot` from `src/app/routes/events/routes.tsx`), `src/app/routes/me/attendance/` (member `/history` screen).

## API (`/api/v1`)

| Route | Guard | Notes |
|---|---|---|
| `GET /events/:id/attendance` | member + `canManageEvent` | Returns `{ eventId, lockedForOrganizer, canEdit, hasUnmarked, attendees }`. Confirmed `rsvp`s and `guest`s only; `effectiveAttendance` defaults `"unknown"` to `"attended"`. |
| `PUT /events/:id/attendance` | member + `canManageEvent` + `Idempotency-Key` | Body `{ rsvps?: [{ id, attendance }], guests?: [{ id, attendance }] }` (`"attended" \| "no_show"`). Audits `attendance.mark`. `409 event_cancelled` if cancelled. `403 attendance_locked` after `endsAt + 7 days` for non-admins. Never modifies `ledger_entry`. |
| `GET /me/attendance` | member (`allowInactive: true`) | Own data only (`?memberId=<other>` → `403`). Returns `{ items }` newest event first with RSVP/guest attendance, linked `ledgerEntries`, `netChargedSek`, and human-readable `why`. |

## Tick hook (`attendance-unmarked-alert`)

- Registered in `src/worker/attendance/alert-tick.ts` (imported from `routes.ts`).
- Fires an `admin_tasks` notification to every active admin when a non-cancelled event is at least 24h past `endsAt` and still has any confirmed `rsvp` or `guest` with `attendance = 'unknown'`.
- Idempotent per `(eventId, adminId)` (`attendance-unmarked:<eventId>:<adminId>`). Calls `markDue` for the next unmarked event.
