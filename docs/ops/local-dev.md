# Local development and verification (S0.1)

## Setup
1. `npm ci`
2. `docker compose up -d postgres` (local Postgres 17 for Worker tests; CI uses a service container)
3. `export DATABASE_URL=postgres://postgres:postgres@localhost:5432/club_test`

## Verify /healthz and the SPA on one origin
1. `npm run build` (produces `dist/client`, the assets directory)
2. `npx wrangler dev --local` and open the printed URL (default `http://localhost:8787`)
3. Check `GET /healthz` returns `{"status":"ok"}`.
4. Open `/probe`. It should render the probe route (`data-testid="probe-route"`), served by the SPA from the same origin.

The automated equivalents are `tests/e2e/smoke.spec.ts` (Playwright, all three projects) and `src/worker/probe/probe.test.ts` (Worker pool).

## Commands
| Command | What it runs |
|---|---|
| `npm run dev` | Vite dev server with the Cloudflare plugin |
| `npm run typecheck` | Three tsconfigs: app, worker and domain, and tooling |
| `npm run lint` | ESLint (type-aware) and Prettier check |
| `npm test` | Vitest projects: `domain`, `worker`, `ui` |
| `npm run test:e2e` | Playwright: `desktop`, `iPhone`, `Android` |

## Notes
- Scheduled (cron) handlers are not triggered automatically by `wrangler dev`. Use `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.
- Bindings in `wrangler.jsonc` with `REPLACE_WITH_*` ids are placeholders until the real KV, R2 and Hyperdrive resources exist (see S0.5). Local dev does not need them for the S0.1 probes.
