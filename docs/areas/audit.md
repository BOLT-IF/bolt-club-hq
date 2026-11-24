# Audit area (S2.4)

Code: `src/worker/audit/` (API), `src/app/routes/admin/audit/` (UI). Rows are written by every area through `src/worker/core/audit.ts`, in the same transaction as the change.

## API (`/api/v1`)

| Route | Guard | Notes |
|---|---|---|
| `GET /admin/audit` | admin | Newest first. Query: `actor`, `entity`, `entityId`, `action` (exact match), `from` (inclusive), `to` (exclusive) as ISO instants with offset, `limit` (1-100, default 50), `cursor`. |

Response: `{ entries: [{ id, at, actorId, actorName, action, entity, entityId, before, after }], nextCursor }`. `nextCursor` is null on the last page. Pagination is a keyset on `(at, id)` with microsecond precision, so new rows never disturb later pages.

## UI

`/admin/audit`: filters (actor dropdown, action, entity, entity id, Stockholm date range with inclusive "To"), entry list with time in Stockholm, actor ("System" when null) and a collapsible before/after diff, and "Load more".

## Not here

Audit JSON pseudonymisation on erasure (S2.5). Any index on `audit_log` (needs a migration).
