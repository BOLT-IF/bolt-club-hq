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

Add `src/worker/notifications/policies/<name>.ts` that default-exports a `NotificationPolicy` (`policy.ts`). It is auto-registered via `import.meta.glob`; nothing else to edit. Order slots: mute 10, quiet hours 20 (shipped by S6.2), frequency cap 30. Policies get `db` (the notify transaction's savepoint), `clock` and the stored notification, and must use `clock`, never `Date.now()`.

## Sending the push (S6.2)

- **Sender:** tick hook `push-sender` (`push-cron.ts` → `push-sender.ts`). Each scheduler run takes due `outbound_push` rows (`queued`, or `deferred` with `not_before <= now`), oldest first, up to `PUSH_BATCH_CAP` (20, provisional until S0.6) sends, and sends to every device of the member.
- **Outcomes:** any device reached → `sent`. 404/410 delete the subscription. 5xx/429/network → `deferred` with backoff 10/20/40/80 min (never into quiet hours), `failed` after 5 attempts. No device → `failed`.
- **Wake-up:** `notify()` and the sender call `markPushDue(at)` → scheduler `markDue`, so pushes go out on the next tick.
- **Quiet hours:** policy `policies/quiet-hours.ts` (order 20) defers to the end of `club_settings.quiet_hours` (default 22:00-08:00 Stockholm, `null` = off).
- **Secrets:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Unset → nothing is sent, rows stay queued.
- **Service worker:** `src/sw/push.ts` always shows a notification; tap focuses or opens the app at the in-app `url` (else `/inbox`).
- **Client:** `resubscribePush()` (`src/sw/push-client.ts`) on every app open (not wired yet); `unsubscribePush()` on sign-out. Neither prompts for permission.

## Push API (`/api/v1`)

- `GET /push/vapid-public-key` (member) → `{ publicKey }`, 503 if unconfigured.
- `POST /push/subscriptions` (member) body = `PushSubscription.toJSON()` + optional `userAgent` → `{ ok }`. Upsert on endpoint.
- `DELETE /push/subscriptions` (member) body `{ endpoint }` → `{ deleted }`, own rows only.
- `GET /admin/push-coverage` (admin) → `{ activeMembers, membersWithPush, coveragePercent, subscriptions }`.

## API (`/api/v1`, member guard, own rows only)

- `GET /notifications?limit=` → `{ items, unreadCount }`, newest first (default 50, max 100).
- `POST /notifications/read` body `{ ids: string[] }` or `{ all: true }` → `{ updated }`. Only unread rows of the caller are stamped, so it needs no `Idempotency-Key`.

## Broadcasts (S6.6)

`POST /admin/broadcasts` (admin, `Idempotency-Key`) sends an `announcements` notification to all active members, pass holders, an event's RSVPs or captains (`src/worker/broadcasts/`, screen `/admin/broadcast`). Each recipient goes through `createNotifyPort`, so the inbox row is always written and the policy chain (mute) decides about the push. Every broadcast is audited as `broadcast.send`. See DECISIONS 2026-11-24 (S6.6).

## Screen

`/inbox` (flag `FLAG_INBOX`, still off): list, unread chip, tap opens the deep link and marks read, "Mark all read".

## Mute and preferences (S6.3)

- Policy `policies/mute.ts` (order 10): `member.global_mute` suppresses every push; otherwise a `notification_pref` row with `muted = true` for the category suppresses it. No row means on. The inbox row is always written.
- `GET /notifications/prefs` → `{ globalMute, categories: [{ category, muted }] }` (all categories, `admin_tasks` for admins only).
- `PUT /notifications/prefs` body `{ globalMute?: boolean, categories?: { [category]: boolean } }` (`true` = muted). Partial updates; unknown or not-allowed category, or non-boolean → 400. Sets absolute values, so no `Idempotency-Key`.
- Screen `/settings/notifications`: one switch per category (on = pushed) plus "Mute all notifications". The More menu still points at `/profile/notifications`, which nothing registers yet (integrator: repoint `navigation.ts`).
