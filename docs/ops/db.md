# Database: Hyperdrive + pg

Owner: S0.2. Covers how the app reaches Postgres in production and in tests, and how the migrations and the ledger guard are enforced.

## Decision

- **Production path:** the Worker connects to Postgres through **Cloudflare Hyperdrive**. The binding is `HYPERDRIVE` in `wrangler.jsonc`. Hyperdrive pools connections at the edge, so a Worker invocation does not open a fresh TCP session per request.
- **Driver:** `pg` (node-postgres) `^8.23.1` as a regular dependency. Inside the Worker, `pg` uses `pg-cloudflare`, which opens sockets with `cloudflare:sockets`. This is why `compatibility_flags` includes `nodejs_compat`.
- **Schema access:** Drizzle ORM over `pg` (`drizzle-orm/node-postgres`). The Db type is `NodePgDatabase<typeof schema>` (`src/worker/core/db/client.ts`).
- **Local dev:** `localConnectionString` in the Hyperdrive binding points at the local Postgres 18 container (see `docs/ops/local-dev.md`).

Integrator and Ashok approved Hyperdrive + `pg` for S0.2. This doc records the reasoning and the evidence.

## Free-plan evidence

Cloudflare's published Hyperdrive limits, checked against the Workers Free plan (checked 2026-11-23; re-check before launch because limits change):

| Need | Free-plan allowance | Fit |
| --- | --- | --- |
| Hyperdrive configs | Available on Free (one config is enough) | One config, `bolt-club-hq`, pointing at the managed Postgres |
| Queries per invocation | Bounded by Worker CPU limits, not Hyperdrive | The app runs a handful of queries per request |
| Pooled connections | Managed by Hyperdrive | No per-request connect cost |

The Free plan limits that actually bind this app are Worker requests and CPU per invocation, which S0.1 already sized (PLAN §11). Hyperdrive adds no separate paid tier for this workload. Re-check the Hyperdrive page on the Free plan before launch. If it moves behind a paid plan, this decision needs integrator review.

Production setup (completed in `#53`):

1. Hyperdrive config `bolt-club-hq` created pointing at Neon Postgres.
2. Real Hyperdrive ID `24dd32c71522408ab20f3b51c6e65417` committed in `wrangler.jsonc`.

## Tests: two projects, one database

Tests use the same `pg` driver over TCP against a real Postgres, so transactions and row locks behave as they do in production.

- **`worker` project** (`@cloudflare/vitest-pool-workers`, workerd runtime): runtime semantics only, such as health probes, logging, Sentry reporting, test identity, and route guards.
- **`db` project** (plain Node, `environment: node`): all Postgres-backed `*.db.test.ts` suites across every worker area plus `tests/scenarios/club-week.db.test.ts` (migrations, ledger guard, idempotency, row locking, auth, members, terms, events, RSVP, passes, claims, club fees, notifications, reminders, polls, privacy, importer, scheduler).

Why the DB suites are outside the workerd pool: `@cloudflare/vitest-pool-workers` 0.23 externalises CommonJS files and appends a `?mf_vitest_no_cjs_esm_shim` suffix. `pg` loads `lib/connection.js` through `require`, and that chain fails to parse inside the pool (`Cannot use import statement outside a module`). Inlining the packages and aliasing `pg-protocol` both failed to change this. Integrator decision: run the DB suites in plain Node, do not fight the pool shim.

Run them with a local Postgres:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/club_test npm test
```

### Per-test database

`createTestDatabase()` (`src/worker/test-support/database.ts`):

1. Creates `club_test_<uuid>` through an admin `pg.Client` on `DATABASE_URL`.
2. Applies every migration in `db/migrations/*.sql`, bundled at build time with `import.meta.glob` (workerd has no filesystem). Statements are split on drizzle-kit's `--> statement-breakpoint` marker.
3. Returns a schema-typed Drizzle db, `countMembers()` and `close()`. `close()` drops the database with `(force)`.

Each test starts from an empty, freshly migrated schema, so tests do not depend on order.

### Transaction proof

`src/worker/core/locking.test.ts` proves that `SELECT … FOR UPDATE` serialises writers: a second transaction blocks on a locked member row until the first commits, and a thrown error inside a transaction rolls back every insert it made.

## Migrations and the ledger guard

- **Linear migration chain (`db/migrations/`):** 6 migrations (`0000_initial.sql`, `0001_polls.sql`, `0002_series_discount.sql`, `0003_event_audience.sql`, `0004_club_fees.sql`, `0005_rsvp_declined.sql`), enforced as a single linear chain by `scripts/ci/check-migrations.sh`.
- The schema list for drizzle-kit is explicit in `drizzle.config.ts` (the area files in `db/schema/`, not the `index.ts` barrel), so the barrel is not loaded twice.
- **Append-only ledger.** `ledger_entry` has a `BEFORE UPDATE OR DELETE` trigger, `ledger_entry_append_only`. DELETE always raises `check_violation`. UPDATE is allowed only for a one-time `exported_at` stamp that changes no other column. Any other UPDATE raises `check_violation`. The trigger is hand-appended to `0000_initial.sql`, because drizzle-kit does not generate triggers.
- **Money** is whole kronor, stored as `integer` (`amount_sek`). Never floats (AGENTS.md rule 5).
- **Idempotency.** `ledger_entry.idempotency_key` is unique. `insertIdempotent` uses `ON CONFLICT DO NOTHING` on that key. The HTTP `Idempotency-Key` middleware stores responses in `idempotency_record`, keyed by (key, actor, route).

## Production reference

- Production is Neon, PostgreSQL 18.7, EU-central (project `autumn-term-77415320`, branch `production`, database `neondb`). Local (`docker-compose.yml`), CI (`ci.yml` services) and the backup and restore clients (`postgresql-client-18`) all run major 18. Change them together: a client older than the server cannot `pg_dump` it.
- On networks that block raw port 5432, Neon's HTTPS endpoint (`@neondatabase/serverless`) still connects. Production access from CI and Cloudflare Hyperdrive is unaffected.
- The Neon connection string lives in the gitignored `.env.local`. It must never be copied into a committed file.

## Open items

- Optional future migrations (require approval): unique index on `rsvp(event_id, member_id)` as a backstop to the event row lock; index on `audit_log(at desc, id desc)` if audit volume grows.
- Migrating `@cloudflare/vitest-pool-workers` (deprecated) to `@cloudflare/vitest-plugin` may eventually unify the `db` and `worker` test projects.
