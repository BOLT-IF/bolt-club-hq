# Bolt Club HQ

An installable PWA (Android Chrome and iOS Safari) that runs Bolt's badminton club: sessions, RSVPs from a single WhatsApp link, term series and passes, member balances, reminders and polls. Rosters are made in the separate [roster-generator](https://github.com/BOLT-IF/roster-generator) app, which this app opens through a deep link.

## Docs
- [`docs/PLAN.md`](docs/PLAN.md): product and technical plan (v3)
- [`docs/STORIES.md`](docs/STORIES.md): epics, stories, dependency waves, definition of done
- [`docs/DECISIONS.md`](docs/DECISIONS.md): decisions made after the plan
- [`docs/history/`](docs/history/): earlier plan versions, the council review, and discarded content

## Stack
Cloudflare Workers (API + static assets + cron) · Hono · Drizzle · Neon Postgres · Clerk · R2 · React 19 + Vite PWA · Vitest · Playwright. The domain is the only cost; everything else runs on free tiers.
