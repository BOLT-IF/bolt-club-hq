# Notifications

Source of truth is the inbox (`notification` table). Push is a best-effort extra.

## Sending (other stories)

```ts
import { createNotifyPort } from "../notifications/notify";

await createNotifyPort({ db: tx, clock }).notify({
  memberId, category: "rsvp_status", title, body,
  idempotencyKey: `rsvp:${eventId}:${memberId}`,
  link: `/events/${slug}`, // optional, in-app path only; default is the category's screen
});
```

- Pass the caller's transaction as `db` so the notification commits or rolls back with the work.
- `notify` is idempotent on `idempotencyKey`: a retry writes nothing and queues no second push.
- Categories are the PLAN §10 list (`links.ts`). An unknown category throws. `admin_tasks` to a non-admin is dropped.
- Tests use `FakeNotify` (`test-support/fakes.ts`). No production file imports it (asserted by `production-wiring.test.ts`).

## Flow

1. Insert `notification` (always).
2. Run the policy chain inside a savepoint. First non-allow decision wins.
3. `suppress` → no push. `defer` → `outbound_push` row, status `deferred`, `not_before = until`. `allow` → `outbound_push` row, status `queued`.
4. A policy that throws counts as `suppress` (fail closed: no push, inbox kept) and calls `onPolicyError`.

## Adding a policy (S6.2 quiet hours, S6.3 mute)

Add `src/worker/notifications/policies/<name>.ts` that default-exports a `NotificationPolicy` (`policy.ts`). It is auto-registered via `import.meta.glob`; nothing else to edit. Order slots: mute 10, quiet hours 20, frequency cap 30. Policies get `db` (the notify transaction's savepoint), `clock` and the stored notification, and must use `clock`, never `Date.now()`.

## Sending the push (S6.2)

S6.2 owns the sender: a cron hook that takes `outbound_push` rows with status `queued`, or `deferred` once `not_before <= now`, and marks them `sent` / `failed`.

## API (`/api/v1`, member guard, own rows only)

- `GET /notifications?limit=` → `{ items, unreadCount }`, newest first (default 50, max 100).
- `POST /notifications/read` body `{ ids: string[] }` or `{ all: true }` → `{ updated }`. Only unread rows of the caller are stamped, so it needs no `Idempotency-Key`.

## Broadcasts (S6.6)

`POST /admin/broadcasts` (admin, `Idempotency-Key`) sends an `announcements` notification to all active members, pass holders, an event's RSVPs or captains (`src/worker/broadcasts/`, screen `/admin/broadcast`). Each recipient goes through `createNotifyPort`, so the inbox row is always written and the policy chain (mute) decides about the push. Every broadcast is audited as `broadcast.send`. See DECISIONS 2026-11-24 (S6.6).

## Screen

`/inbox` (flag `FLAG_INBOX`, still off): list, unread chip, tap opens the deep link and marks read, "Mark all read".
