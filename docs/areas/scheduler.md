# Scheduler (S6.4)

Code: `src/worker/scheduler/`. Entry: `scheduled()` in `src/worker/index.ts` calls `runScheduled`.

## Triggers (wrangler.jsonc, UTC)
- `*/10 5-22 * * *` covers Stockholm 07-23 in summer and winter.
- `0 0-4,23 * * *` covers the remaining hours hourly.
- Keep `CRON_FREQUENT` / `CRON_HOURLY` in `schedule.ts` in step; a test compares them.

## A tick
1. KV lock `scheduler:lock`; held means no-op.
2. Record tick (`ops:last_tick_at`); raise `admin_tasks` alert if the previous tick was stale.
3. `scheduler:next_due_at` in KV. Not due and last good run under 24 h ago: ping and return, no DB.
4. Else run cron hooks and tick hooks within 30 s each; record in `scheduler_state`; ping healthchecks.io.

## Adding work
- Schedule: `markDue(env.KV, date)` when you create something time-bound.
- Run: `registerTickHook("name", ({ db, clock, now, cron, kv }) => ...)` at module load. Must be idempotent (a failed run is retried next tick).
- Registered hooks in production:
  - `idempotency-claim-cleanup` (empty claims older than 10 min)
  - `rsvp-close` (`src/worker/rsvp/close-tick.ts`)
  - `push-sender` (`src/worker/notifications/push-cron.ts`)
  - `reminders` (`src/worker/reminders/tick.ts`)
  - `poll-closing-reminders` (`src/worker/polls/reminders.ts`)
  - `attendance-unmarked-alert` (`src/worker/attendance/alert-tick.ts`)
  - `privacy-retention-purge` (`src/worker/privacy/retention.ts`)
  - `media-purge` (`src/worker/media/purge.ts`)

## Config
- `HEALTHCHECK_PING_URL` (optional secret): healthchecks.io ping URL.
