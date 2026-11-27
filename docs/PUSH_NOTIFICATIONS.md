# Push Notifications: Triggers, Policies, Quick Actions, and Delivery

Every user-facing alert in BOLT HQ goes through [`createNotifyPort`](../src/worker/notifications/notify.ts). This document lists every trigger, how policies filter or defer it, how RSVP quick actions work, and when Web Push delivers it.

## 1. How Delivery Works

1. **Inbox is always written first.** `notify()` inserts a row into `notification` inside the caller's database transaction (idempotent on `idempotency_key`). Even if push is muted, unsubscribed, or VAPID is not configured, the message always appears in **Inbox** (`/inbox`).
2. **Policy chain runs in order** ([`policy.ts`](../src/worker/notifications/policy.ts)):
   - **Mute (`order: 10`, [`mute.ts`](../src/worker/notifications/policies/mute.ts)):** If `member.global_mute = true` or the recipient muted that category in **Notifications** (`/settings/notifications`), the push is **suppressed** (no `outbound_push` row is created).
   - **Quiet hours (`order: 20`, [`quiet-hours.ts`](../src/worker/notifications/policies/quiet-hours.ts)):** Evaluated in `Europe/Stockholm` time. Default is **22:00–08:00** (configurable in **Admin → Settings**). If triggered inside quiet hours, the push is **deferred** (`outbound_push.status = 'deferred'`, `not_before` = end of quiet hours).
3. **Scheduler & Cron cadence** ([`wrangler.jsonc`](../wrangler.jsonc), [`schedule.ts`](../src/worker/scheduler/schedule.ts), [`push-cron.ts`](../src/worker/notifications/push-cron.ts)):
   - Cloudflare Cron Triggers run **every 10 minutes** during `05:00–22:59 UTC` (covers `07:00–23:59` Stockholm year-round) and **hourly** during `23:00–04:59 UTC`.
   - `notify()` writes `scheduler:next_due_at` in KV so the next cron tick wakes up and calls `sendPushBatch()` (capped at `PUSH_BATCH_CAP = 20` device sends per tick in [`push-sender.ts`](../src/worker/notifications/push-sender.ts); provisional until `S0.6` real-device CPU profiling).
   - Because delivery is cron-driven, pushes arrive on the **next cron tick** (up to ~10 minutes during daytime, or at the end of quiet hours / next hourly tick overnight) — **not** instantaneously on the HTTP request.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` must all be configured as Worker secrets; if any are missing, `outbound_push` rows stay queued without sending.
   - Failed deliveries retry with exponential backoff (10 / 20 / 40 / 80 min, respecting quiet hours, max 5 attempts); expired endpoints (`404`/`410`) are deleted.
4. **RSVP Quick Actions** ([`push-sender.ts`](../src/worker/notifications/push-sender.ts), [`src/sw/push.ts`](../src/sw/push.ts)):
   - Any push in category `new_events` whose link starts with `/events/` automatically attaches two notification action buttons (`actions: [{ action: "going", title: "RSVP" }, { action: "decline", title: "Not going" }]`) on platforms that support `Notification.actions` (e.g. Android Chrome / desktop; platforms without action buttons ignore them and open the event normally).
   - Tapping a quick action appends `?quickRsvp=going` or `?quickRsvp=decline` to the event URL, focusing or opening the app to execute the RSVP or decline immediately. Members can also tap **RSVP** or **Not Going** directly in **Home** (`Unanswered Events`) and **Inbox**.

## 2. All Notification Triggers

| Category | Event / Trigger | Who Receives It | When It Fires | Source |
|---|---|---|---|---|
| `rsvp_status` | **RSVP close results** (`You're in` / `Waitlisted` / guest confirmed or waitlisted) | Members whose RSVP or guest status resolved at close | When an event passes `rsvp_close_at` (on cron tick or close-on-read) | [`rsvp/close.ts`](../src/worker/rsvp/close.ts) |
| `rsvp_status` | **Auto-promotion from waitlist** (`You're in`, `Guest confirmed`) | Next waitlisted member / host | When a confirmed spot opens before the auto-promote cutoff (`auto_promote_cutoff_min`, default 180 min before start) | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **First-come spot offer** (`Spot available`, `Spot available for guest`) | Waitlisted members | When a spot opens after the auto-promote cutoff (post-close claim window) | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **Late-cancel spot refilled** (`Spot refilled`) | Member who late-cancelled | When someone claims or is promoted into their late-cancelled spot (reversing any ad-hoc charge) | [`rsvp/claim.ts`](../src/worker/rsvp/claim.ts), [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts), [`rsvp/postclose.ts`](../src/worker/rsvp/postclose.ts) |
| `rsvp_status` | **Capacity reduced → waitlisted** (`Moved to waitlist`, `Guest moved to waitlist`) | Bumped member / host | When an admin lowers event capacity below confirmed with `override: true` | [`rsvp/capacity.ts`](../src/worker/rsvp/capacity.ts) |
| `rsvp_status` | **Event cancelled** (`Event cancelled`) | Members with an active/charged RSVP on the event | When an organizer/admin cancels the event | [`rsvp/eventchange.ts`](../src/worker/rsvp/eventchange.ts) |
| `rsvp_status` | **Event date/time/location changed** (`Event updated`) | Members with an active RSVP on the closed event | When an organizer/admin edits `starts_at`, `ends_at`, or `location` after close (starts 24h free-cancel window) | [`rsvp/eventchange.ts`](../src/worker/rsvp/eventchange.ts) |
| `new_events` | **New one-off event created** (`New event`) *(includes RSVP / Not going quick actions)* | Eligible active members (everyone, chosen series pass holders, or picked members), excluding the organizer | Immediately when an event is created via `POST /api/v1/events` | [`events/oneoff-routes.ts`](../src/worker/events/oneoff-routes.ts) |
| `new_events` | **Un-RSVPed event reminder** *(includes RSVP / Not going quick actions)* | Eligible active members with **no** `rsvp` row (any response—including `declined` or `cancelled`—suppresses it) | Scheduled `event_unrsvped` reminder rule fires at publish (within 7 days of start) and/or `hoursBeforeClose` before `rsvp_close_at` | [`reminders/service.ts`](../src/worker/reminders/service.ts) |
| `payment_status` | **Payment claim confirmed** (`Payment confirmed`) | Claiming member | When another admin confirms their payment claim | [`ledger/claims.ts`](../src/worker/ledger/claims.ts) |
| `payment_status` | **Payment claim rejected** (`Payment claim rejected`) | Claiming member | When another admin rejects their payment claim (includes reason) | [`ledger/claims.ts`](../src/worker/ledger/claims.ts) |
| `payment_status` | **Unpaid pass revoked** (`Pass revoked`) | Pass holder | When an unpaid pass passes `pass_unpaid_revoke_days` (default 21 days) and is revoked by an admin | [`passes/model.ts`](../src/worker/passes/model.ts) |
| `payment_due` | **Balance / payment reminder** | Active and inactive (exited) members whose balance ≥ rule `thresholdSek` | Scheduled `payment_due` reminder rule fires (at most once per `minIntervalDays` Stockholm calendar days) | [`reminders/service.ts`](../src/worker/reminders/service.ts) |
| `polls` | **New poll published** (`New poll`) | Active members | Immediately when an admin creates a poll | [`polls/routes.ts`](../src/worker/polls/routes.ts) |
| `polls` | **Poll closing soon** (`Poll closing soon`) | Active members who have not voted yet | Cron reminder within 24 hours of `closes_at` | [`polls/reminders.ts`](../src/worker/polls/reminders.ts) |
| `announcements` | **Admin broadcast** | Targeted audience (all active members, pass holders, an event's active RSVPs, or captains) | Immediately when an admin sends a broadcast | [`broadcasts/send.ts`](../src/worker/broadcasts/send.ts) |
| `admin_tasks` | **New join request** (`New join request`) | All active admins | When a pending user submits an invite/event/series join request | [`members/join.ts`](../src/worker/members/join.ts) |
| `admin_tasks` | **Attendance unmarked** (`Attendance unmarked`) | All active admins | Cron check when a non-cancelled event is > 24h past `ends_at` with any confirmed attendee still `unknown` | [`attendance/alert-tick.ts`](../src/worker/attendance/alert-tick.ts) |
| `admin_tasks` | **Scheduler stale alert** (`Scheduled tasks have stopped`) | All active admins | When `ops:last_tick_at` is older than 2× the expected cron interval | [`scheduler/alert.ts`](../src/worker/scheduler/alert.ts) |
