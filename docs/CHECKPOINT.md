# BOLT HQ — Project Checkpoint & Future Roadmap

**Date:** 2026-11-27
**Baseline commit:** `6545eb7` (`main`, through PR `#93`)
**Scope:** Single source of truth for where **BOLT HQ** (`BOLT-IF/bolt-club-hq`) stands today, what is still missing or human-blocked, which product decisions need confirmation, and what technical hardening to tackle next.

---

## 1. Current State Snapshot

### Delivery progress
- **46 of 48 planned stories** from [`docs/STORIES.md`](./STORIES.md) are merged on `main` (including `R1` in `BOLT-IF/roster-generator`).
- **18 post-story PRs (`#76`–`#93`)** added real-world club workflows and a complete mobile PWA UI/UX upgrade:
  - Returning-member discounted pass rates (`#82`, `0002_series_discount.sql`)
  - One-off events redesign: `< 24h` instant confirm, member vs club billing, audience groups (`all`/`series`/`members`), `new_events` notifications (`#83`, `0003_event_audience.sql`)
  - Bank name & account number in club settings and pay info (`#84`)
  - Admin season-pass assignment UI (`#85`)
  - Annual Fall/Spring club fee system + external Fall payment tracking (`#86`, `0004_club_fees.sql`)
  - "Not going" (`declined`) RSVP status suppressing event reminders (`#87`, `0005_rsvp_declined.sql`)
  - RSVP quick actions (`RSVP` / `Not going`) in Web Push, Home, and Inbox (`#88`)
  - iOS PWA auth fixes: Google SSO shown (`#80`), sign-in redirect loop broken and `/me` excluded from SW cache (`#89`)
  - Direct sign-in member approval (`#78`), `/admin` grouped hub (`#79`, `#91`), decided payment claims history (`#81`), member overflow Action Sheet (`#90`), Invites & Join Requests redesign (`#92`), and full 35-route mobile PWA UI/UX audit & upgrade (`#93`)

### Architecture & runtime facts
- **Production URL:** `https://bolt-club-hq.bashok001.workers.dev` (auto-deployed from `main` via Cloudflare `Workers Builds`; `.github/workflows/deploy.yml` runs `drizzle-kit migrate` + smoke test).
- **Database:** Neon PostgreSQL 18.7 via Cloudflare Hyperdrive (`24dd32c71522408ab20f3b51c6e65417`), 6 linear Drizzle migrations (`0000_initial`–`0005_rsvp_declined`), append-only `ledger_entry` trigger.
- **Storage & state:** Workers KV (`KV` for OG cache + `scheduler:next_due_at` + `ops:last_tick_at`), R2 (`bolt-club-hq-media` for member-only `/media/:key` poll images).
- **Feature flags:** `FLAG_EVENTS`, `FLAG_MONEY`, `FLAG_INBOX`, `FLAG_POLLS` are all `"on"` in production `wrangler.jsonc` and `"off"` in PR previews.
- **Automated quality gates:**
  - `npm run typecheck` (app, worker, node)
  - `npm run lint` (ESLint + Prettier)
  - Vitest (`domain`: 16 files / 114 tests; `ui`: 50 files / 325 tests; `worker` + `db` Postgres 18 suites in CI)
  - Playwright E2E (12 specs sharded across 4 CI runners covering Desktop, iPhone/WebKit, Android/Chromium, plus axe WCAG 2.1 AA checks)

---

## 2. Missing Features & Unfinished Stories

| Priority | Item | Status / Blocker | What Needs to Happen |
|---|---|---|---|
| **P1** | **`S5.6` manager.io accounting export** (`src/worker/accounting/`, `/admin/money/export`) | **Blocked on treasurer** | 1. Treasurer confirms exact `manager.io` CSV columns and account-code keys (`pass`, `adhoc`, `guest`, `payment`, plus whether `club_fee` gets its own account code).<br>2. Implement `GET /api/v1/admin/accounting-export.csv` stamping `ledger_entry.exported_at` (already allowed by the append-only trigger), flagging re-exports, with golden-file CSV tests.<br>3. Add export screen/action under `/admin/money`. |
| **P1** | **`S0.6` Real-device QA & sign-off** (`docs/ops/spike-devices.md`, [`docs/LAUNCH.md`](./LAUNCH.md)) | **Blocked on human hardware + Clerk prod domain** | Run the full matrix on a real iPhone (Safari + installed PWA) and Android (Chrome + installed PWA) against the production custom domain & Clerk production instance. Verify Google SSO in installed iOS PWA (`GOOGLE_HIDDEN_IN_INSTALLED_IOS = false`), Web Push lock-screen delivery & quick actions, WhatsApp/Slack OG previews, Roster deep link, and measure Worker CPU at `PUSH_BATCH_CAP = 20`. |
| **P2** | **Admin UI trigger for GDPR member erasure (`S2.5`)** | Backend done, UI omitted | `POST /api/v1/admin/members/:id/erase` is fully implemented and tested (zero-balance gate, Clerk deletion, PII pseudonymisation, 7-year ledger preservation), but `AdminMembers.tsx` has no UI button yet. Add an `Erase Member` action (only for `inactive` members with `0 kr` balance, gated behind strong confirmation) if admins want to run erasures from the app instead of via API. |
| **P3** | **Optional `/admin/health` UI screen** | Removed dead link (`#79`) | `GET /healthz`, `GET /healthz/ready`, and `GET /api/v1/admin/push-coverage` exist on the backend, while no `/admin/health` UI route was built. Build a lightweight System Health card under Admin only if admins want in-app visibility into push coverage, DB status, and last cron tick without checking Cloudflare/healthchecks.io. |
| **P3** | **Playwright Clerk testing-token sign-in spec (`s1.1-sign-in.spec.ts`)** | Not built | Add `@clerk/testing` + Clerk test keys in CI to exercise real login end to end in Playwright (currently covered by Vitest unit/DB suites and mocked E2E flows). |

---

## 3. Operational & Launch Checklist (Human-Owned)

These are the remaining non-code items required for rock-solid club production operations (details in [`docs/LAUNCH.md`](./LAUNCH.md), [`docs/ops/backups.md`](./ops/backups.md), and [`docs/ops/secrets.md`](./ops/secrets.md)):

1. **Custom domain & Clerk production instance**
   - Point the club domain to Cloudflare Workers and switch Clerk from `dev` (`pk_test_` / `sk_test_`) to a production Clerk instance (`pk_live_` / `sk_live_`).
   - Confirm Clerk dashboard app name is **BOLT HQ** and update `VITE_CLERK_PUBLISHABLE_KEY` in Cloudflare Workers Builds settings (then trigger a rebuild) + `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` via `wrangler secret put`.
2. **Off-site 90-day encrypted backups & first real restore drill**
   - `.github/workflows/backup.yml` currently uploads `.sql.enc` dumps only as 30-day GitHub Actions artifacts (PLAN §16 requires **90-day** off-site retention).
   - Provision a dedicated private backup bucket (e.g., private Cloudflare R2 bucket or external S3 bucket) with a 90-day lifecycle rule, add `BACKUP_BUCKET_TOKEN` + `BACKUP_ENCRYPTION_KEY` (2 copies in password manager) + `RESTORE_TARGET_URL` (throwaway Neon branch), and replace the placeholder `Fetch latest encrypted dump` step in `.github/workflows/restore-drill.yml`.
   - Run both `backup.yml` and `restore-drill.yml` via `workflow_dispatch` and confirm `restore-drill: OK`.
3. **Monitoring & scheduled audits**
   - Verify `HEALTHCHECK_PING_URL` (healthchecks.io ~1h period) is receiving live pings from `scheduled()` and alerts on missed ticks.
   - Verify `SENTRY_DSN` (optional) captures Worker + browser errors.
   - Set `LHCI_TARGET_URL` in GitHub secrets and trigger the first **Monthly Lighthouse** run (`lighthouse.yml`) to confirm `@lhci/cli@0.15` works and capture baseline scores.
4. **Repository & environment governance**
   - Confirm the Neon production password was rotated if it ever passed through chat.
   - Optionally configure a required reviewer on the GitHub `production` environment (so `deploy.yml` migrations wait for approval) and branch protection rules on `main`.
5. **Brand assets**
   - Replace PNG-derived PWA icons in `public/icons/` with crisp SVG-exported icons when a master vector logo is available.

---

## 4. Product Decisions to Confirm or Revisit

Everything below has a sensible working default in production today, recorded in [`docs/DECISIONS.md`](./DECISIONS.md) and [`docs/FOLLOWUPS.md`](./FOLLOWUPS.md), but should be confirmed with club organizers / treasurer:

1. **Captains editing series capacity (`S3.1`):** Currently **admin-only** because changing series capacity moves `pass_cap` (PLAN §4 listed it under captains). Confirm admin-only is preferred.
2. **Single-admin own payment claim (`S5.5`):** Currently blocked (`403 own_claim`) even if there is only one active admin (stricter than A11). A sole admin can still record their own payment via `POST /admin/payments` (flagged in audit). Confirm intended.
3. **"At publish" reminder trigger (`S6.5a`):** Currently means "first tick when an open scheduled event starts within **7 days**" (so creating a whole term of events doesn't spam everyone on day 1). Confirm 7-day window feels right.
4. **Anonymous polls permanence (`S9.1`):** Anonymous polls hide voter identities even from admins and cannot be switched to named later. Confirm intended.
5. **Push batch cap (`S6.2`):** Currently `PUSH_BATCH_CAP = 20` per cron run (PLAN §11 budgeted 10 for the 10 ms Worker CPU limit). Confirm or tune after `S0.6` CPU measurements.
6. **Google SSO in installed iOS PWA (`#80`):** Currently enabled (`GOOGLE_HIDDEN_IN_INSTALLED_IOS = false`). Confirm OAuth completes cleanly inside iOS standalone mode with Clerk production; flip back to `true` only if Safari/WebView session stranding occurs.
7. **`GET /series` visibility (`S3.1`):** Currently allows any active member and returns `[]` for non-captains. Tighten to admin/captain guard only if desired.
8. **Club fee account code (`#86` / `S5.6`):** Decide whether `club_fee` ledger entries need a dedicated account code in `/admin/settings` alongside `pass`, `adhoc`, `guest`, and `payment`.

---

## 5. Technical Debt & Future Hardening

| Priority | Item | Notes |
|---|---|---|
| **P2** | **Client JS code-splitting** | `dist/client/assets/index-*.js` is ~614 KB minified (~167 KB gzipped), triggering Vite's 500 KB chunk warning. Lazy-loading `/admin/*` routes with `React.lazy` / dynamic `import()` will shrink initial mobile load for regular members. |
| **P2** | **Optional DB indexes (requires new migration)** | 1. Unique index on `rsvp(event_id, member_id)` as a DB-level backstop to the `event FOR UPDATE` row lock.<br>2. Composite index on `audit_log(at DESC, id DESC)` if audit rows grow large. |
| **P2** | **Migrate `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin`** | Vitest currently prints a deprecation warning for `@cloudflare/vitest-pool-workers` 0.23. Migrating via `@cloudflare/codemods` keeps testing up to date and may allow unifying the `db` and `worker` test projects. |
| **P3** | **Expand Playwright E2E specs** | 12 specs cover core journeys, shell, PWA, privacy, money, passes, claims, reminders, share links, and poll images. Adding focused E2E specs for `AdminMembers` (ActionSheet), `AdminApprovals`, `AdminTerms`, `AdminClubFees`, `AdminAudit`, and `NewEvent` one-off flows will harden admin regressions. |
| **P3** | **`wrangler types` refresh (`worker-configuration.d.ts`)** | `worker-configuration.d.ts` was hand-edited for `FLAG_*`; run `npm run cf-typegen` in a dedicated chore PR so future diffs stay clean. |
| **P3** | **Track `docs/PWA_UI_Rules.md` & `AGENTS.md` in git** | Ensure `docs/PWA_UI_Rules.md` and the updated `AGENTS.md` are committed to `main` (currently untracked/local alongside `.agents/` and `skills-lock.json`; commit `docs/PWA_UI_Rules.md` + `AGENTS.md` while keeping local `.agents/` or deciding whether to track/ignore it). |

---

## 6. Quick Reference: Where Truth Lives

| Topic | Source-of-Truth File |
|---|---|
| UI tokens, typography, button tiers, mobile PWA ergonomics | [`docs/PWA_UI_Rules.md`](./PWA_UI_Rules.md) & [`src/app/components/ui/ui.css`](../src/app/components/ui/ui.css) |
| Post-plan architecture & product decisions | [`docs/DECISIONS.md`](./DECISIONS.md) (newest first) |
| Per-area routes, rules & data ownership | [`docs/areas/*.md`](./areas/) |
| Push notification triggers, policies & quick actions | [`docs/PUSH_NOTIFICATIONS.md`](./PUSH_NOTIFICATIONS.md) |
| Real-device QA matrix & launch steps | [`docs/LAUNCH.md`](./LAUNCH.md) |
| Secrets, backups, Postgres & free-tier budgets | [`docs/ops/`](./ops/) |
| Roster deep-link cross-repo contract | [`contracts/roster-import-v1/README.md`](../contracts/roster-import-v1/README.md) |
