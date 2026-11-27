# BOLT HQ: Device QA & Launch Checklist (S11.3)

Pre-launch verification, real-device QA matrix, operational readiness checks, and staged rollout runbook for **BOLT HQ** (`BOLT IF`).

- **Related docs:** [`docs/CHECKPOINT.md`](./CHECKPOINT.md), [`docs/PLAN.md` §14](./PLAN.md#14-rollout), [`docs/STORIES.md`](./STORIES.md) (`S0.6`, `S11.3`), [`docs/STATUS.md`](./STATUS.md), [`docs/ops/secrets.md`](./ops/secrets.md), [`docs/ops/backups.md`](./ops/backups.md), [`docs/ops/budgets.md`](./ops/budgets.md).
- **Provisional S0.6 constants:** Until the S0.6 real-device spike runs with a Clerk production instance on real iPhone and Android devices, two constants in the codebase should be verified on hardware:
  - `PUSH_BATCH_CAP = 20` in `src/worker/notifications/push-sender.ts` (`PLAN §11` budgets 10 sends per cron run for the 10 ms Worker CPU limit).
  - `GOOGLE_HIDDEN_IN_INSTALLED_IOS = false` in `src/app/auth/google.ts` (flipped from `true` in `#80` so Google SSO appears in installed iOS PWAs; verify OAuth completion in standalone WebView during S0.6 and flip back to `true` only if it strands sessions in Safari).

---

## 1. Real-device QA matrix

Run every row below on real hardware against the deployed production origin before Beta/Club-wide launch. Record **Pass / Fail / Notes** for each cell.

| Area | Check & expected behaviour | iPhone Safari | iPhone Installed PWA | Android Chrome | Android Installed PWA |
|---|---|---|---|---|---|
| **Install & standalone** | Manifest (`vite.config.ts`) uses `display: "standalone"` (and `display_override` if configured), `start_url: "/"`, `scope: "/"`, BOLT HQ icons (`192`, `512`, `maskable-512`). | `InstallGuide` (`/install`) / `InstallPrompt` shows Add to Home Screen steps. | Launches in `standalone` mode (`navigator.standalone === true`), no Safari URL bar; app shell loads cleanly. | `beforeinstallprompt` shows one-tap Install (or menu steps fallback). | Launches in `standalone` mode (`display-mode: standalone`), no Chrome URL bar; app shell loads cleanly. |
| **Clerk: email code** | Sign in with email verification code; kill and relaunch app/tab. | Session persists across reload. | Session persists across app kill & relaunch (`standalone` storage isolated from Safari). | Session persists across reload. | Session persists across app kill & relaunch. |
| **Clerk: Google SSO** | Verify Google button visibility and OAuth completion. | Google button shown below email form; OAuth completes. | **Currently enabled (`GOOGLE_HIDDEN_IN_INSTALLED_IOS = false`, `#80`):** Google button is shown. During S0.6, verify Google OAuth completes inside standalone WebView without stranding the session in Safari; flip back to `true` only if unreliable. | Google button shown below email form; OAuth completes. | Google button shown below email form; OAuth completes. |
| **Pre-provisioned link & privacy** | First sign-in for an `S11.2`-imported member links by verified email (no duplicate pending member). `/privacy` readable signed out. | [ ] Pass | [ ] Pass | [ ] Pass | [ ] Pass |
| **Web Push: opt-in** | Push card appears only after first RSVP (`noteRsvpSaved()`) or explicitly on `/install`. Declining sets `bcq.push.declined` and stops prompting. | Push card **never** shown in Safari tab. | Prompt appears after first RSVP / on `/install`; permission `granted` succeeds. | Prompt appears after first RSVP / on `/install`; permission `granted` succeeds. | Prompt appears after first RSVP / on `/install`; permission `granted` succeeds. |
| **Web Push: delivery & CPU** | Trigger RSVP status change or broadcast; confirm notification arrives on lock screen/tray and deep-links into app. Check Worker CPU stays `< 10 ms` per batch (`PUSH_BATCH_CAP = 20`, provisional pending S0.6). | N/A (use `/inbox`). | Arrives when app is backgrounded/closed; tap opens target route. | Arrives when tab/browser is closed; tap opens target route. | Arrives when app is backgrounded/closed; tap opens target route. |
| **Web Push: mute & sign-out** | Enable mute or quiet hours (`S6.3`) → push suppressed while `/inbox` still shows item. Sign out → `unsubscribePush()` runs so device stops receiving pushes for that account. | `/inbox` & sign-out verified. | Mute suppresses push; sign-out stops pushes. | Mute suppresses push; sign-out stops pushes. | Mute suppresses push; sign-out stops pushes. |
| **OG previews (`/e/:slug`, `/s/:slug`)** | Share event and series links in **WhatsApp** and **Slack**. Verify KV-backed OG card shows title, time, location, and spots with **no** attendee/creator PII and `X-Robots-Tag: noindex, nofollow`. | Preview renders; tap opens Safari; signed-out RSVP saves `bcq.signin-intent` and auto-RSVPs after sign-in. | N/A (external links open in Safari on iOS). | Preview renders; tap opens Chrome/PWA; signed-out RSVP auto-completes after sign-in. | Signed-in pending/non-member sees "Request to join" → `/join/event/:slug`. |
| **Roster deep link** | On a `closed` event with `roster_app_url` set in `/admin/settings`, tap **Open in roster generator** in Organizer Tools. | Opens `{roster_app_url}/planner#import=<base64url>` in `BOLT-IF/roster-generator` with confirmed players ordered by tier then confirmation time, `short` names, and `guest: true` flags. | Opens external roster app cleanly; "Copy list" fallback copies one player per line. | Opens `{roster_app_url}/planner#import=<base64url>` cleanly. | "Copy list" works; unsetting `roster_app_url` hides deep-link button. |

---

## 2. Pre-launch operational checks

### 2.1 Lighthouse CI (`.github/workflows/lighthouse.yml`)
- [ ] Set the `LHCI_TARGET_URL` GitHub Actions secret to the live origin (same value as `PUBLIC_BASE_URL`, e.g. `https://bolt-club-hq.<account>.workers.dev` or custom domain).
- [ ] Trigger **Monthly Lighthouse** (`workflow_dispatch`) in GitHub Actions.
- [ ] Confirm `npx --yes @lhci/cli@0.15 collect --url="$LHCI_TARGET_URL" --numberOfRuns=3` completes (verifies the `@lhci/cli@0.15` pin noted in `docs/ops/backups.md`).
- [ ] Inspect scores in the job log and download the `lighthouse-reports` artifact (90-day retention). Verify Performance, Accessibility, Best Practices, and PWA baselines have no regressions.

### 2.2 Postgres backup & restore drill (`.github/workflows/restore-drill.yml`)
- [ ] Choose and provision the off-site backup store with **90-day retention** (`PLAN §16`; GitHub artifacts retain 30 days max).
- [ ] Replace the placeholder `Fetch latest encrypted dump` step in `.github/workflows/restore-drill.yml` so it downloads the newest `bolt-club-hq-*.sql.enc` into `$RUNNER_TEMP/dumps`.
- [ ] Confirm GitHub Actions secrets are set (`docs/ops/secrets.md`): `DATABASE_URL`, `RESTORE_TARGET_URL` (an **empty, throwaway** Neon branch/DB — `scripts/ci/restore-drill.sh` refuses if it equals `DATABASE_URL`), `BACKUP_ENCRYPTION_KEY` (two copies stored in the owner's password manager), and `BACKUP_BUCKET_TOKEN`.
- [ ] Trigger **Weekly encrypted backup** (`backup.yml`) via `workflow_dispatch` and confirm an encrypted dump is uploaded.
- [ ] Trigger **Monthly restore drill** (`restore-drill.yml`) via `workflow_dispatch` and confirm `scripts/ci/restore-drill.sh` prints `restore-drill: OK. Restored bolt-club-hq-...sql.enc; public tables=<N>.`
- [ ] Confirm `scripts/ci/test/test-backup-restore.sh` passes in CI (verifies wrong `BACKUP_ENCRYPTION_KEY` fails loudly).

### 2.3 Free-tier budget check (`docs/ops/budgets.md`)
Re-verify vendor limits before launch:

- [ ] **Cloudflare Workers (Free):** 100,000 req/day, 10 ms CPU per HTTP request & Cron Trigger, 5 Cron Triggers/account (we use 2: `*/10 5-22 * * *` and `0 0-4,23 * * *` UTC).
- [ ] **Workers KV:** 100,000 reads/day, **1,000 writes/day** (tightest KV cap — check event-edit / OG-write volume), 1 GB storage.
- [ ] **Cloudflare R2 (`bolt-club-hq-media`):** card on file required; 10 GB-month storage, 1M Class A ops/month, 10M Class B ops/month, zero egress.
- [ ] **Cloudflare Hyperdrive:** **2 origin connections** per configuration, 100,000 queries/day.
- [ ] **Neon (Postgres Free):** 100 CU-hours/month, 1 GB storage/project, 5 GB egress, 10 branches. Confirm `next_due_at` in KV short-circuits idle cron runs so Neon compute auto-suspends.
- [ ] **Clerk (Hobby/Free):** 50,000 monthly retained users, 3 dashboard seats.
- [ ] **GitHub Actions:** confirm billing/minutes allowance covers CI + 4-shard Playwright matrix.

---

## 3. Staged rollout checklist (`PLAN §14`)

### Stage 0: Infrastructure, secrets & migrations
1. **Rotate & set Neon URL:** If the Neon password was ever shared in chat, rotate it in Neon first. Set `DATABASE_URL` in GitHub Actions secrets.
2. **GitHub environment & variables:** Create the `production` GitHub environment with a required reviewer (`docs/ops/backups.md`). Set repo variable `PUBLIC_BASE_URL` and remaining GitHub Actions secrets (`RESTORE_TARGET_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_BUCKET_TOKEN`, `LHCI_TARGET_URL`).
3. **Cloudflare Worker runtime secrets (`npx wrangler secret put <NAME>`):**
   - `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `BOOTSTRAP_ADMIN_EMAIL`
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (back up in password manager — never rotate casually), `VAPID_SUBJECT`
   - `HEALTHCHECK_PING_URL` (healthchecks.io dead-man switch with ~1 h period; read by `src/worker/scheduler/run.ts`)
   - `SENTRY_DSN` (optional)
4. **Cloudflare Workers Builds variable:** Set `VITE_CLERK_PUBLISHABLE_KEY` in Cloudflare build settings and trigger a rebuild.
5. **Clerk dashboard & domain:** Set the Clerk app name to **BOLT HQ**. Configure the custom domain and Clerk production instance (`S0.6`).
6. **Deploy & migrate (`.github/workflows/deploy.yml`):** Push/merge to `main` (Cloudflare Workers Builds deploys the Worker + SPA; `deploy.yml` runs `npx drizzle-kit migrate` to apply all 6 migrations `0000_initial` through `0005_rsvp_declined`, then runs `scripts/ci/smoke.sh "$PUBLIC_BASE_URL"`).
7. **Verify liveness, readiness & cron ping:**
   - `GET /healthz` returns `200 { "status": "ok" }`.
   - After the first cron tick runs, `GET /healthz/ready` returns `200` (no longer `503 degraded`) and `healthchecks.io` records a successful ping.

### Stage 1: Bootstrap & S0.6 device spike
1. Sign in with `BOOTSTRAP_ADMIN_EMAIL` and confirm admin access.
2. Run the **S0.6 real-device spike** on real iPhone and Android hardware with the Clerk production instance.
3. Update `PUSH_BATCH_CAP` (`src/worker/notifications/push-sender.ts`) and `GOOGLE_HIDDEN_IN_INSTALLED_IOS` (`src/app/auth/google.ts`) if S0.6 measurements/tests call for a change.

### Stage 2: Feature flag verification & Alpha (admins + treasurer)
All four flags (`FLAG_EVENTS`, `FLAG_MONEY`, `FLAG_INBOX`, `FLAG_POLLS`) are `"on"` in `wrangler.jsonc` for production (and `"off"` for PR preview builds). Verify each area in order during Alpha:

1. **`FLAG_EVENTS`**
   - Configure club settings (`/admin/settings`), including bank details, club fees (Fall 160 kr / Spring 85 kr), and `roster_app_url` (`BOLT-IF/roster-generator`).
   - Create term (with `season` & `clubYear`), series (with optional returning-member discount), captains, and a test one-off event; verify OG link previews (`/e/:slug`, `/s/:slug`), RSVP, "Not Going" decline, and quick actions.
2. **`FLAG_MONEY`**
   - Import initial members and opening balances via `POST /api/v1/admin/members/import` (`S11.2`); verify idempotency and first sign-in linking.
   - Verify passes, admin pass assignment, annual club fees (`/admin/money/club-fees`), payment claims (`/money/claims`, `/admin/money/claims`), and test the `manager.io` export format with the treasurer (`S5.6`, once format is confirmed).
3. **`FLAG_INBOX`**
   - Configure reminder rules (`/admin/reminders`), send a test broadcast, and verify `/inbox`, RSVP quick actions (`?quickRsvp=going|decline`), Web Push delivery, mute, and sign-out unsubscribe on real devices.
4. **`FLAG_POLLS`**
   - Create a poll with R2-backed option images (`/media/:key`) and verify member voting and image rendering.

### Stage 3: Beta (Thursday XD series)
1. Run the **Thursday XD** series live with a small group of members.
2. Reconcile ledger charges, payment claims, and balances against `manager.io` in parallel.
3. Use the **Open in roster generator** deep link (`/planner#import=...`) at real club sessions and confirm court/roster import works end to end.
4. Complete the full **Real-device QA matrix** (Section 1) with beta testers on iPhone and Android.

### Stage 4: Club-wide launch
1. Open registration/invites to all club members at the start of the term.
2. Monitor launch metrics (`PLAN §14`, `S0.7`):
   - RSVP-via-link rate
   - Push opt-in / coverage
   - Claim-to-confirm time
   - Admin time spent and money disputes
3. Keep watching `healthchecks.io` alerts, `/healthz/ready`, Sentry, and free-tier budgets (`docs/ops/budgets.md`).
