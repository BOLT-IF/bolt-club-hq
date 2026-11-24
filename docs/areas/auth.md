# Auth (Clerk)

Clerk proves who someone is. **Our database decides what they may do** (roles and status live in `member`, never in Clerk metadata).

## Request path (`src/worker/auth/`)

1. `routes.ts` runs `configureRequestDeps(clerkRequestDeps())` when the registry imports it, so production uses Clerk. Tests override with their own `configureRequestDeps`.
2. `authenticate` (`clerk.ts`) reads `Authorization: Bearer <session JWT>`, verifies it with `@clerk/backend/jwt` against a **cached JWKS**, and checks the issuer (`https://<frontend api>`, decoded from `CLERK_PUBLISHABLE_KEY`). No Clerk call per request. The JWKS is fetched once per isolate, refreshed on an unknown `kid` (at most once a minute) or after an hour. Bad, expired, wrong-issuer or unverifiable tokens give `null`, so 401.
3. `currentMember` (`wiring.ts`):
   - unknown Clerk user: load name and verified primary email from the Clerk Backend API (`CLERK_SECRET_KEY`, once), insert a **pending** member plus a `member.created` audit row in one transaction. `ON CONFLICT (clerk_user_id) DO NOTHING` makes concurrent first requests produce exactly one member.
   - **bootstrap admin:** if the member's verified email equals `BOOTSTRAP_ADMIN_EMAIL` (case-insensitive) they are made `admin` + `active` on every request until it holds (audited as `member.bootstrap_admin`). Erased members are never touched.
4. `originGuard` returns 403 for a state-changing request (POST/PUT/PATCH/DELETE) whose `Origin` is present and not this site's. No `Origin` (bearer-only clients) passes.
5. `GET /api/v1/me` returns the actor (also for pending members, who need it for the waiting screen). Guard: `requireSignedIn()`.

## Frontend (`src/app/auth/`, `src/app/routes/auth/`)

- `AuthProvider` (wrapped around the app in `src/app/main.tsx`) mounts `<ClerkProvider>` and sets `apiFetch`'s `getToken`. **Without a valid `VITE_CLERK_PUBLISHABLE_KEY` nothing Clerk runs** and the app boots signed out (dev, CI, e2e). `/sign-in` then says sign-in is not set up.
- `/sign-in` (`?return_to=` same-site path): Clerk `<SignIn>`, email code first, Google below. **Google is hidden in the installed iOS app** (`google.ts`, one constant, provisional until S0.6).
- `intent.ts`: `saveIntent({ returnTo, rsvp })` before sending someone to `/sign-in`; `takeIntent()` after. 30-minute expiry, consumed once, same-site paths only. The RSVP screen (S4.x) and join flow (S1.3) own saving and completing the `rsvp` part.
- `/sign-out`: Clerk sign-out, then `clearAppCaches()` (service-worker caches), then home.

## Config

| Name | Where | Notes |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | **build time** (GitHub Actions variable / `.env.local`) | `pk_test_…` or `pk_live_…`. Not secret. |
| `CLERK_PUBLISHABLE_KEY` | Worker secret/var | Same key. Worker derives the issuer and JWKS URL from it. |
| `CLERK_SECRET_KEY` | Worker secret | Used only to read a user's name and email on first sign-in. Unset means empty profile. |
| `BOOTSTRAP_ADMIN_EMAIL` | Worker secret/var | Unset or empty promotes nobody. |

## Testing

- JWT fixtures: `src/worker/auth/test-jwt.ts` (throwaway RSA key, fake JWKS fetch). `auth.db.test.ts` covers first sign-in, the concurrent race and bootstrap admin against real Postgres (CI only locally).
- Other stories keep using `X-Test-Identity` (ENV=test); that header still wins over the bearer token.
- Playwright "sign in via Clerk testing tokens" is **not** shipped here: it needs Clerk keys in CI (Ashok's queue). Add `tests/e2e/s1.1-sign-in.spec.ts` with `@clerk/testing` once the keys exist.
