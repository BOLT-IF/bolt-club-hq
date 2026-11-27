# Free-tier budgets (S0.5)

Limits verified against each vendor's official documentation on **2026-11-23**. The vendors
change these numbers, so re-check this page before each term launch and when a budget alert
fires. Where a number is a plan default rather than a hard cap, that is noted.

Our design keeps every product well below its free cap. The table gives the cap and our
expected load, so a reviewer can see the headroom.

## Cloudflare Workers (Free plan)

| Resource | Free limit | Our expected load | Source |
|---|---|---|---|
| Requests | 100,000 per day (resets 00:00 UTC) | Well under 1,000 per day | Workers limits |
| CPU time per HTTP request | 10 ms | Allocation <1 ms, JWT verify ~1 ms (PLAN §11.3) | Workers limits |
| CPU time per Cron Trigger | 10 ms | Push encryption capped at `PUSH_BATCH_CAP = 20` per run (`push-sender.ts`, provisional vs PLAN's 10; profile in `S0.6`) | Workers limits |
| Wall-clock duration, HTTP | No limit | n/a | Workers limits |
| Wall-clock duration, Cron Trigger | 15 minutes | n/a | Workers limits |
| Subrequests per invocation | 50 | Keep fan-out small | Workers limits |
| Worker size (uncompressed) | 64 MiB | Single Worker | Workers limits |
| Workers per account | 100 | 1 | Workers limits |
| Static asset files per Worker version | 20,000 | SPA build, far fewer | Workers limits |
| Static asset file size | 25 MiB | n/a | Workers limits |

**Cron Triggers (Free plan): 5 per account.** We use 2 (`*/10 5-22 * * *` and `0 0-4,23 * * *` UTC, covering Stockholm 07–23 year-round across DST; see `wrangler.jsonc` and `src/worker/scheduler/schedule.ts`). The Free plan allows 5, so there is room for 3 more.

## Workers KV

| Resource | Free limit | Our expected load |
|---|---|---|
| Reads | 100,000 per day | OG cache and `next_due_at` (idle cron reads should be near zero) |
| Writes to different keys | 1,000 per day | A few per event change |
| Writes to the same key | 1 per second | Not expected |
| Storage per account | 1 GB | Small: OG HTML and scheduler state |
| Value size | 25 MiB | n/a |

KV is also subject to the Workers free plan's daily reset at 00:00 UTC. The 1,000-writes cap is
the tightest KV limit for us: a burst of event edits could exhaust it within a day. Watch KV write
metrics in the Cloudflare dashboard (and `/healthz/ready` for scheduler liveness).

## R2 (free tier, bucket allowance is shared with paid tiers)

| Resource | Free limit (per month) |
|---|---|
| Storage | 10 GB-month |
| Class A operations (writes, list) | 1 million requests |
| Class B operations (reads) | 10 million requests |
| Egress | No charge for any storage class |

R2 requires a card on file, even though the free tier covers us. PLAN §11.2 already records this.

## Hyperdrive

Hyperdrive is included on both the Free and Paid Workers plans. The Free plan has these
limits, which reset daily at 00:00 UTC:

| Resource | Free limit |
|---|---|
| Configured databases per account | 10 |
| Origin database connections per configuration | 2 |
| Initial connection timeout | 15 seconds |
| Idle connection timeout | 10 minutes |
| Database queries per day | 100,000 |

Two origin connections per configuration is a tight limit. It is the main reason to keep
transactions short and to avoid long-held `FOR UPDATE` locks (S0.2 proves the driver choice). If
Hyperdrive proves too limited, PLAN §15 falls back to the Neon WebSocket driver.

## Neon (Postgres)

| Resource | Free plan | Source |
|---|---|---|
| Compute | 100 CU-hours per project per month | Neon plans |
| Storage | 1 GB per project, 20 GB across the account | Neon plans |
| Egress | 5 GB per project | Neon plans |
| Projects | 100 | Neon plans |
| Branches | 10 per project | Neon plans |
| Manual snapshots | 1 | Neon plans |
| Object storage | 5 GB per project | Neon plans |

**Correction to PLAN §11.3:** the plan says "0.5 GB storage". The current free plan gives
**1 GB per project**. We use less than either number. The corrected figure is recorded here, and
`docs/DECISIONS.md` logs it.

Neon's free plan has no monthly fee. Compute auto-suspends when idle. The `next_due_at` check in
KV keeps idle cron runs from waking Neon.

## Clerk (Hobby / free)

| Resource | Free limit | Source |
|---|---|---|
| Monthly retained users | 50,000 | Clerk pricing |
| Dashboard seats | 3 | Clerk pricing |
| Development instance | Included (used until the domain exists) | Clerk pricing |

Clerk counts a **monthly retained user** (MRU), not a plain monthly active user: someone who
signs up and never returns in a later month does not count. The club has about 45 members, so
the cap is far away. Production sign-in needs our own domain (see `docs/DECISIONS.md`, domain
deferred).

## GitHub Actions (public repository)

`BOLT-IF/bolt-club-hq` is a **public repository**, so standard GitHub-hosted Ubuntu runners are
free (unlimited minutes for CI, the 4-shard Playwright matrix, and scheduled workflows). If the
repository is ever made private again, check GitHub Actions included-minutes billing before keeping
the 4-shard Playwright matrix enabled.

## Budget alerts and what to do

| Signal | Action |
|---|---|
| Workers daily requests above 50% of 100,000 | Check for a loop or a bot. Cloudflare error 1027 means the cap was hit. |
| KV writes above 500 in a day | Check the event-edit rate; batch writes if needed. |
| Neon compute above 70 CU-hours in a month | Check that `next_due_at` short-circuits idle runs. |
| Hyperdrive queries near 100,000 per day | Review query fan-out. |
| Clerk MRU above 40,000 | Still free; plan the Pro upgrade before the cap. |

## Sources

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing (free plan limits): https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Hyperdrive limits: https://developers.cloudflare.com/hyperdrive/platform/limits/
- Neon plans: https://neon.com/docs/introduction/plans
- Clerk pricing: https://clerk.com/pricing
