# Local development and verification

## Setup
1. `npm ci` (or `npm install` if working behind a mirror that blocks a transitive check)
2. `docker compose up -d postgres` (local Postgres 18, matching production Neon and CI's service container)
3. `export DATABASE_URL=postgres://postgres:postgres@localhost:5432/club_test`

## Verify `/healthz` and the SPA on one origin
1. `npm run build` (produces `dist/client`, the static assets directory, plus `dist/client/sw.js`)
2. `npx wrangler dev --local` and open the printed URL (default `http://localhost:8787`)
3. Check `GET /healthz` returns `{"status":"ok"}` (liveness). `GET /healthz/ready` is the strict readiness check: it returns `503 degraded` until Postgres is reachable and a cron tick has been recorded (see Notes).
4. Open `/`. It serves the React PWA shell (`data-testid="app-shell"`) from the same origin.

The automated equivalents are `tests/e2e/smoke.spec.ts` and `tests/e2e/shell.spec.ts` (Playwright across `desktop`, `iPhone`, `Android`).

## Commands
| Command | What it runs |
|---|---|
| `npm run dev` | Vite dev server with the Cloudflare plugin |
| `npm run build` | Production build of Worker, client SPA, and service worker |
| `npm run typecheck` | Three tsconfigs: app, worker/domain, and node tooling |
| `npm run lint` | ESLint (type-aware) and Prettier check |
| `npm test` | All Vitest projects: `domain`, `worker`, `db` (needs `DATABASE_URL`), `ui` |
| `npx vitest run --project ui --project domain` | Fast local test run without Postgres |
| `npm run test:e2e` | Playwright across `desktop`, `iPhone` (WebKit), and `Android` (Chromium) |

## Notes
- **Scheduled (cron) handlers** are not triggered automatically by `wrangler dev`. Trigger a local tick with `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.
- **Auth in local dev:** Without `VITE_CLERK_PUBLISHABLE_KEY`, `AuthProvider` boots without Clerk (used by Playwright E2E specs that mock `/api/v1/*`). To test live sign-in locally, add `VITE_CLERK_PUBLISHABLE_KEY` to `.env.local` (gitignored).
- **Bindings in `wrangler.jsonc`:** Real Cloudflare IDs are configured for production (`KV`, `MEDIA`, `HYPERDRIVE`); local `wrangler dev --local` uses Miniflare emulation for KV/R2 and `localConnectionString` for Postgres.
