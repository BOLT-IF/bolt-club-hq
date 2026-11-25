# Area: Share links & edge OG (`S7.1`)

## Edge OG & HTML (`src/worker/share/`)

- **Routes:** `GET /e/:slug` and `GET /s/:slug`, mounted outside `/api/v1` in `src/worker/app.ts` and routed ahead of static assets in `wrangler.jsonc` (`assets.run_worker_first`) and `src/worker/index.ts`.
- **Fallback chain:**
  1. **KV:** reads `og:event:<slug>` (or `og:series:<slug>`) without touching Neon.
  2. **Neon:** on KV miss, queries `event` (for `/e/:slug`) or `series` + `nextOpenEvent` (for `/s/:slug`) via `src/worker/share/deps.ts`. Unknown slugs return `404` with a friendly message. Found events backfill KV best-effort.
  3. **Generic:** if Neon is unreachable/throws, returns `200` with a generic BOLT IF preview and boots the SPA.
- **Security & privacy:** all OG/HTML attributes are escaped with `escapeHtml`; snapshots contain public event fields only (never attendee or creator names); responses carry `X-Robots-Tag: noindex, nofollow`, `<meta name="robots" content="noindex, nofollow" />`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy` (`SHARE_CSP`).
- **`publishOg`:** `createKvPublishOg` in `src/worker/share/og.ts` is the default `eventsDeps().publishOg` in `src/worker/events/deps.ts`.

## Frontend (`src/app/components/share/`, `src/app/routes/share/`)

- **`ShareSlot` (`src/app/components/share/SharePanel.tsx`):** Registered in `src/app/routes/events/routes.tsx`. Uses `navigator.share` when available and falls back to `navigator.clipboard.writeText` with a `"Link copied"` toast.
- **Landing pages (`src/app/routes/share/SharePage.tsx`):** Mounted at `/e/:slug` and `/s/:slug`.
  - `401` (logged out): saves `SignInIntent` (`returnTo` + `rsvp` for `/e/:slug`) and navigates to `/sign-in?return_to=...`.
  - `403` (non-member / pending): shows "Request to join" linking to `/join/event/:slug` or `/join/series/:slug`.
  - `200` (active member): consumes any matching `SignInIntent` and sends `PUT /events/:id/rsvp` automatically, then renders the event and all slots (`RsvpSlot`, `ShareSlot`, `OrganizerToolsSlot`, `AttendeesSlot`).
