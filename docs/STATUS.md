# BOLT HQ: current status & handoff

Last updated **2026-11-27** (head `main` at `#93`). **46 of 48 planned stories are merged on `main` (2 human-blocked: `S0.6` real-device spike, `S5.6` manager.io export), plus 18 post-story feature, bug-fix, and mobile PWA UI/UX upgrade PRs (`#76`–`#93`).**

For the complete forward-looking tracker of what is missing, operational blockers, and future work, see **[`docs/CHECKPOINT.md`](./CHECKPOINT.md)**. Update this file and `docs/DECISIONS.md` after major milestones.

## What is built (all on `main`)

### Planned stories (46/48 merged)

| Area | Stories | State |
|---|---|---|
| Foundations | R1 roster import (`roster-generator`), S0.1–S0.5, S0.7 | merged: repo, CI (4-shard Playwright + Postgres), deploy workflow, PWA, UI kit, observability, schema, core contracts |
| Identity | S1.1 Clerk sign-in, S1.3 invites and approval | merged |
| Members | S2.1 members and roles, S2.3 club settings, S2.4 audit viewer, S2.5 privacy (#61) | merged |
| Events | S3.0 events core, S3.1 terms and series, S3.2 recurrence, S3.3 one-off events | merged |
| RSVP | S4.1 allocation engine, S4.2 RSVP before close, S4.3 close processing (#59), S4.4a post-close RSVP/cancel/refill (#63), S4.4b claim-a-spot & capacity (#67), S4.4c event cancel & material changes (#66) | merged |
| Money | S5.1 ledger, S5.2 member money screen, S5.3 passes (#60), S5.4 admin money, S5.5 payment claims & screens (#57) | merged |
| Notifications | S6.1 inbox and policies, S6.2 web push, S6.3 preferences and mute, S6.4 scheduler, S6.5a reminder engine, S6.5b reminder UI (#56), S6.6 broadcasts | merged |
| Attendance | S8.1 attendance marking (#65), S8.2 member attendance history (#68), S8.3 roster deep link (#69) | merged |
| Polls and install | S9.1 polls, S9.2 poll images on R2 (#62), S10.1 home dashboard (#70), S10.2 install and push onboarding | merged |
| Sharing | S7.1 share links, edge OG, request-to-join (#71) | merged |
| Brand and deploy | BOLT HQ theme, logo icons, KV/Hyperdrive/R2 config (#53), deploy.yml migrate-and-smoke (#72) | merged |
| Integration & QA | Chore follow-up wiring (#55, #75), S11.2 member import (#58), S11.1 club-week scenarios (#74), S11.3 launch checklist (#73) | merged |

### Post-story enhancements & polish (`#76`–`#93`, all on `main`)

| PR | Summary |
|---|---|
| `#76` | UI polish, deduplication, post-close exit cancel wiring, axe contrast re-enabled on `InstallPrompt` |
| `#77`, `#80`, `#89` | iOS PWA fixes: mobile overflow, standalone menu, show Google SSO buttons (`GOOGLE_HIDDEN_IN_INSTALLED_IOS = false`), break sign-in redirect loop, stop service worker from caching `/me` |
| `#78`, `#79` | Direct sign-in member approval (`POST /members/:id/approve`), render `AdminIndex` at `/admin`, remove dead `/admin/health` link |
| `#81` | Decided payment claims history (`GET /admin/payment-claims` returns `{ claims, history }`) + `docs/PUSH_NOTIFICATIONS.md` |
| `#82` | Returning-member discounted pass rate per series (`0002_series_discount.sql`, `PUT /series/:id/discount-eligible`) |
| `#83` | One-off events redesign: `< 24h` instant confirm, member vs club billing, audience groups (`all` / `series` / `members`), `new_events` notifications (`0003_event_audience.sql`) |
| `#84`, `#85` | Bank name & account number in club settings and pay info; admin UI to assign season passes (`GET /admin/passes/offers`, `POST /admin/passes`) |
| `#86` | Annual Fall/Spring club fee system (`0004_club_fees.sql`, `/admin/money/club-fees`, `club_fee` ledger reason, external Fall tracking) |
| `#87`, `#88` | "Not going" (`declined`) RSVP option (`0005_rsvp_declined.sql`, suppresses un-RSVPed reminders) + RSVP quick actions (`RSVP` / `Not going`) in Web Push, Home, and Inbox |
| `#90`–`#93` | Full mobile PWA UI/UX redesign & audit across all 35 routes (`docs/PWA_UI_Rules.md`): 4-tier Apple HIG button hierarchy, `GroupedList`, `ActionSheet`, `CopyButton`, `DisclosureSection`, compact `EmptyState`, 44px touch targets, 16px inputs, WCAG AA contrast (`--bcq-muted: #526075`) |

Six migrations exist in a single linear chain: `0000_initial`, `0001_polls`, `0002_series_discount`, `0003_event_audience`, `0004_club_fees`, `0005_rsvp_declined`.

## Remaining planned stories (2 human-blocked)

| Story | Size | Blocker | Owns (summary) |
|---|---|---|---|
| **S5.6 manager.io export** | S | Waiting on treasurer to confirm exact CSV import format and account-code keys (`pass`, `adhoc`, `guest`, `payment`) | `src/worker/accounting/`, `src/app/routes/admin/money/export*` |
| **S0.6 Real-device spike** | M | Human QA on real iPhone & Android against Clerk production instance + custom domain (verifies Google OAuth in installed iOS PWA and Worker CPU per push batch at `PUSH_BATCH_CAP = 20`) | `docs/ops/spike-devices.md` |

## Production state

- **Site:** `https://bolt-club-hq.bashok001.workers.dev` (Cloudflare Worker `bolt-club-hq`, account `440a16d9fbe436e7133d5985ebd2a492`). Cloudflare `Workers Builds` deploys automatically on every push to `main`.
- **Deploy workflow (`.github/workflows/deploy.yml`):** Runs `npx drizzle-kit migrate` against `DATABASE_URL` and `scripts/ci/smoke.sh` against `PUBLIC_BASE_URL` on pushes to `main`.
- **Cloudflare resources (real IDs in `wrangler.jsonc`):** KV namespace `KV` (`68031a5b401347098df663b521a10ddf`, preview `5ee394e1f7344bb2a60af20b848ba2a8`), Hyperdrive `bolt-club-hq` (`24dd32c71522408ab20f3b51c6e65417`), R2 bucket `bolt-club-hq-media`.
- **Feature flags (`wrangler.jsonc`):** `FLAG_EVENTS`, `FLAG_MONEY`, `FLAG_INBOX`, `FLAG_POLLS` are all `"on"` for production and `"off"` for preview deployments.
- **Neon:** PostgreSQL 18.7 (`autumn-term-77415320`, branch `production`, database `neondb`). Local `.env.local` is gitignored and never committed.
- **Brand & UI system:** App name **BOLT HQ**, club name **BOLT IF**. Source of truth is `docs/PWA_UI_Rules.md` and `src/app/components/ui/ui.css`: `#1e293b` navy header, `#faf8f5` warm canvas, `#ffffff` cards (`16px` radius), `#f97316` primary CTA with `#0f172a` ink, `#b45309` deep amber links, `#526075` WCAG AA muted ink.
- **CI & repo:** Public repository on GitHub (`BOLT-IF/bolt-club-hq`), squash merge only, auto-delete branches on merge. GitHub Actions runs `ci` (typecheck, lint, full Vitest suite with Postgres 18) + `e2e-tests` (4-shard Playwright matrix across Desktop, iPhone/WebKit, Android/Chromium) on every PR.

## Operational & human items remaining

See **[`docs/CHECKPOINT.md`](./CHECKPOINT.md)** for the full prioritized checklist. Short version:
1. **Custom domain & Clerk production instance** (for `S0.6` real-device sign-off and club-wide launch).
2. **S0.6 real-device QA matrix** (`docs/LAUNCH.md` §1) on real iPhone & Android — confirm Google SSO in installed iOS PWA and measure Worker push batch CPU (`PUSH_BATCH_CAP = 20`).
3. **Off-site 90-day backup store + restore drill** (`backup.yml` uploads 30-day GitHub artifacts only; `restore-drill.yml` still has a placeholder fetch step).
4. **Treasurer confirmation for `S5.6`** (manager.io CSV format + account codes).
5. **First Monthly Lighthouse run** (`LHCI_TARGET_URL`) and optional GitHub `production` environment required reviewer / branch protection.

## Engineering conventions (keep following them)

- **Area routing:** mount `contextMiddleware()` on the area's own paths only, never `use("*")`. Exited members on own-data routes use `requireGuard("member", { allowInactive: true })`.
- **Money & time:** whole kronor as integers, append-only `ledger_entry`, `Idempotency-Key` on money/RSVP writes, injected `Clock` everywhere in domain/worker code.
- **UI:** follow `docs/PWA_UI_Rules.md` (4-tier buttons, Title Case headings/buttons/chips, sentence case body/hints, `>= 44px` tap targets, `>= 16px` inputs, `GroupedList` / `ActionSheet` / `DisclosureSection`).
- **Migrations:** always a single linear Drizzle chain (`scripts/ci/check-migrations.sh`); expand-only because `deploy.yml` runs migrations after `Workers Builds` deploys.
- **Commits & tests:** `npm run typecheck && npm run lint && npm test` (DB tests require Postgres 18 on `DATABASE_URL`). `docs/DECISIONS.md` uses `merge=union` in `.gitattributes`.
