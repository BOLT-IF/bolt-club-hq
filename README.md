# BOLT HQ (`BOLT-IF/bolt-club-hq`)

An installable mobile-first PWA (Android Chrome and iOS Safari) that runs **BOLT IF**'s badminton club: sessions, one-link WhatsApp RSVPs with "Not going" and quick actions, term series and passes (including returning-member discounts), annual Fall/Spring club fees, append-only member ledger and payment claims, automated reminders, broadcasts, and polls with R2 images. Rosters are made in the separate [roster-generator](https://github.com/BOLT-IF/roster-generator) app, opened through a versioned `#import=` deep link.

## Docs

- [`docs/CHECKPOINT.md`](docs/CHECKPOINT.md): **project checkpoint** — full current state, what is missing, operational blockers, product decisions to revisit, and future roadmap
- [`docs/STATUS.md`](docs/STATUS.md): live delivery status, production setup, and agent workflow notes
- [`docs/PWA_UI_Rules.md`](docs/PWA_UI_Rules.md): mobile PWA UI/UX design system and copy rules (source of truth for all screens)
- [`docs/PLAN.md`](docs/PLAN.md): original product and technical plan (v3 baseline)
- [`docs/STORIES.md`](docs/STORIES.md): epics, stories, dependency waves, and definition of done
- [`docs/DECISIONS.md`](docs/DECISIONS.md): post-plan architectural and product decisions (newest first)
- [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md): follow-ups register across engineering, product, and operations
- [`docs/PUSH_NOTIFICATIONS.md`](docs/PUSH_NOTIFICATIONS.md): complete reference for push triggers, policies, quick actions, and delivery
- [`docs/LAUNCH.md`](docs/LAUNCH.md): real-device QA matrix, operational readiness, and staged rollout checklist
- [`docs/areas/`](docs/areas/): per-area API, data, and UI documentation
- [`docs/ops/`](docs/ops/): local dev, database, secrets, backups, and free-tier budgets
- [`docs/history/`](docs/history/): archived earlier plan versions, council review, and discarded v1/v2 content

## Stack

Cloudflare Workers (API + static assets + Cron Triggers) · Hono · Drizzle ORM · Neon Postgres (via Hyperdrive) · Workers KV · Cloudflare R2 · Clerk · React 19 + Vite PWA · Vitest · Playwright. Everything runs on free tiers; the club domain is the only recurring cost.
