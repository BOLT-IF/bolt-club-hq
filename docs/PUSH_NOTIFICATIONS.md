# Push Notifications: Triggers, Policies, and Delivery

Every user-facing alert in BOLT HQ goes through [`createNotifyPort`](../src/worker/notifications/notify.ts). This document lists every trigger, how policies filter or defer it, and when Web Push actually delivers it.

## 1. How Delivery Works

1. **Inbox is always written first.** `notify()` inserts a row into `notification` inside the caller's database transaction (idempotent on `idempotency_key`). Even if push is muted, unsubscribed, or VAPID is not configured, the message always appears in **Inbox** (`/inbox`).
2. **Policy chain runs in order** ([`policy.ts`](../src/worker/notifications/policy.ts)):
   - **Mute (`order: 10`, [`mute.ts`](../src/worker/notifications/policies/mute.ts)):** If `member.global_mute = true` or the recipient muted that category in **Notifications settings** (`/settings/notifications`), the push is **suppressed** (no `outbound_push` row is created).
   - **Quiet hours (`order: 20`, [`quiet-hours.ts`](../src/worker/notifications/policies/quiet-hours.ts)):** Evaluated in `Europe/Stockholm` time. Default is **22:00–08:00** (configurable in **Admin → Settings**). If triggered inside quiet hours, the push is **deferred** (`outbound_push.status = 'deferred'`, `not_before` = end of quiet hours).
3. **Scheduler & Cron cadence** ([`wrangler.jsonc`](../wrangler.jsonc), [`schedule.ts`](../src/worker/scheduler/schedule.ts), [`push-cron.ts`](../src/worker/notifications/push-cron.ts)):
   - Cloudflare Cron Triggers run **every 10 minutes** during `05:00–22:59 UTC` (`07:00–23:59` Stockholm) and **hourly** during `23:00–04:59 UTC`.
   - `notify()` writes `scheduler:next_due_at` in KV so the next cron tick wakes up and calls `sendPushBatch()`.
   - Because delivery is cron-driven, pushes arrive on the **next cron tick** (up to ~10 minutes during daytime, or at the end of quiet hours / next hourly tick overnight) — **not** instantaneously on the HTTP request.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` must all be configured as Worker secrets; if any are missing, `outbound_push` rows stay queued without sending.
   - Failed deliveries retry with backoff; expired endpoints (`404`/`410`) or repeated failures are deactivated.

## 2. All Notification Triggers

| Category | Event / Trigger | Who Receives It | When It Fires | Source |
|---|---|---|---|---|
| `rsvp_status` | **RSVP close results** (`You're in` / `Waitlisted` / guest confirmed or waitlisted) | Members with an active RSVP on the event | When an event passes `rsvp_close_at` (on cron tick or close-on-read) | [`rsvp/close.ts`](../src/worker/rsvp/close.ts) |
| `rsvp_status` | **Auto-promotion from waitlist** (`You're in`, `Guest confirmed`) | Next waitlisted member / host | When a confirmed spot opens before the auto-promote cutoff (`auto_promote_cutoff_min`, default 180 min before start) | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **First-come spot offer** (`Spot available`, `Spot available for guest`) | Waitlisted members | When a spot opens after the auto-promote cutoff (post-close claim window) | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **Late-cancel spot refilled** (`Spot refilled`) | Member who late-cancelled | When someone claims or is promoted into their late-cancelled spot (reversing any ad-hoc charge) | [`rsvp/claim.ts`](../src/worker/rsvp/claim.ts), [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **Capacity reduced → waitlisted** (`Moved to waitlist`, `Guest moved to waitlist`) | Bumped member / host | When an organizer lowers event capacity after close | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts) |
| `rsvp_status` | **Event cancelled** (`Event cancelled`) | Members with an RSVP on the event | When an admin/organizer cancels the event | [`rsvp/eventchange.ts`](../src/worker/rsvp/eventchange.ts) |
| `rsvp_status` | **Event date/time/location changed** (`Event updated`) | Members with an RSVP on the event | When an admin/organizer edits `starts_at`, `ends_at`, or `location` | [`rsvp/eventchange.ts`](../src/worker/rsvp/eventchange.ts) |
| `rsvp_status` | **RSVP deadline reminder** | Eligible members who haven't RSVP'd yet | Scheduled reminder rule (`rsvp_deadline`) fires before `rsvp_close_at` | [`reminders/service.ts`](../src/worker/reminders/service.ts) |
| `event_changes` | **Event day reminder** | Confirmed attendees | Scheduled reminder rule (`event_day`) fires before event start | [`reminders/service.ts`](../src/worker/reminders/service.ts) |
| `new_events` | **New one-off event created** (`New event`) | Eligible active members (everyone, chosen series pass holders, or picked members), excluding the organizer | Immediately when an event is created via `POST /api/v1/events` | [`events/oneoff-routes.ts`](../src/worker/events/oneoff-routes.ts) |
| `payment_status` | **Payment claim confirmed** (`Payment confirmed`) | Claiming member | When another admin confirms their payment claim | [`ledger/claims.ts`](../src/worker/ledger/claims.ts) |
| `payment_status` | **Payment claim rejected** (`Payment claim rejected`) | Claiming member | When another admin rejects their payment claim (includes reason) | [`ledger/claims.ts`](../src/worker/ledger/claims.ts) |
| `payment_status` | **Unpaid pass revoked** (`Pass revoked`) | Pass holder | When an unpaid pass passes `pass_unpaid_revoke_days` (default 21 days) and is revoked | [`passes/model.ts`](../src/worker/passes/model.ts) |
| `payment_due` | **Balance / payment reminder** | Members with an outstanding balance (`balance_sek > 0`) | Scheduled reminder rule (`payment_due`) fires | [`reminders/service.ts`](../src/worker/reminders/service.ts) |
| `polls` | **New poll published** (`New poll`) | Targeted audience (active members or series) | Immediately when an admin creates a poll | [`polls/routes.ts`](../src/worker/polls/routes.ts) |
| `polls` | **Poll closing soon** (`Poll closing soon`) | Targeted audience who haven't voted yet | Cron reminder before `closes_at` | [`polls/reminders.ts`](../src/worker/polls/reminders.ts) |
| `announcements` | **Admin broadcast** | Targeted audience (club, series, or event) | Immediately when an admin sends a broadcast | [`broadcasts/send.ts`](../src/worker/broadcasts/send.ts) |
| `admin_tasks` | **New join request** (`New join request`) | All active admins | When a pending user submits an invite/event/series join request | [`members/join.ts`](../src/worker/members/join.ts) |
| `admin_tasks` | **Attendance unmarked** (`Attendance unmarked`) | All active admins | Cron check when an event is >24h past end with unmarked attendance | [`attendance/alert-tick.ts`](../src/worker/attendance/alert-tick.ts) |
| `admin_tasks` | **Scheduler stale alert** (`Scheduled tasks have stopped`) | All active admins | When `scheduler:last_run_at` is older than 2x the expected cron interval | [`scheduler/alert.ts`](../src/worker/scheduler/alert.ts) |
