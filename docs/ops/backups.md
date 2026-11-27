# Backups, restore drill and deploy runbook (S0.5)

This page covers the three scheduled jobs and the deploy path. Secrets are listed in
`docs/ops/secrets.md`. Budgets are in `docs/ops/budgets.md`.

## Current status (updated 2026-11-27)

Cloudflare (`KV`, `R2`, `Hyperdrive`, `Workers Builds`) and Neon Postgres are provisioned and connected (`wrangler.jsonc` carries real resource IDs). Scheduled backup/restore/Lighthouse jobs still print a skip notice until their required GitHub secrets exist (`docs/ops/secrets.md`). A green run that only printed a skip notice is **not** evidence of a working backup. The off-site 90-day backup store, first real backup, and first passing restore drill remain open items below.

## Weekly encrypted backup (`.github/workflows/backup.yml`)

- **When:** Sunday 03:00 UTC, plus on demand.
- **What:** `pg_dump` of the production database, piped straight into `openssl` (AES-256-CBC,
  PBKDF2, 600k iterations). The plain SQL never touches disk. Output:
  `bolt-club-hq-<UTC timestamp>.sql.enc`.
- **Key:** `BACKUP_ENCRYPTION_KEY`. The script refuses to run without it, so it never writes a
  plain-text dump.

### Retention: open item

PLAN §16 sets backup retention at **90 days**. The workflow uploads each dump as a run
artifact, but GitHub artifacts expire after at most 90 days and we set `retention-days: 30`.
That is **not** the same as a backup store. The off-site copy is an open item:

- Choose a store (for example a private Cloudflare R2 bucket, which is already in the stack,
  or a separate cloud bucket).
- Add an upload step that writes the `.sql.enc` file there and deletes objects older than
  90 days.
- The restore drill's "Fetch latest encrypted dump" step is a placeholder that fails on purpose
  until this exists (see `restore-drill.yml`).

Until then, the run artifacts are the only copies. Do not treat them as the 90-day backup.

## Monthly restore drill (`.github/workflows/restore-drill.yml`)

- **When:** 1st of the month, 05:00 UTC, plus on demand.
- **What:** `scripts/ci/restore-drill.sh` restores the **latest** dump into `RESTORE_TARGET_URL`
  and runs a smoke query (`SELECT count(*)` over `public` tables). The drill fails when no dump
  exists, when the key is wrong, when the restore errors, or when the smoke query returns no
  number.
- **Safety:** the script refuses to run when `RESTORE_TARGET_URL` equals `DATABASE_URL`. A restore
  over live data cannot be undone.
- **Proof it works:** `scripts/ci/test/test-backup-restore.sh` runs the same logic against stub
  `psql`/`pg_dump` binaries, including "latest dump wins" and "wrong key fails".

## Monthly Lighthouse (`.github/workflows/lighthouse.yml`)

- **When:** 2nd of the month, 06:00 UTC, plus on demand.
- **What:** `@lhci/cli collect` against `LHCI_TARGET_URL`, 3 runs. Reports are kept as a
  90-day artifact. The job prints scores and does not gate on them yet.
- **Unverified:** the pinned `@lhci/cli@0.15` could not be checked against the npm registry from
  the build machine. Confirm the version on the first real run.

## Deploy (`.github/workflows/deploy.yml`)

Cloudflare `Workers Builds` deploys the Worker and static assets on every push to `main`.
This workflow runs the post-deploy database migration and smoke test on every push to `main`:

1. **Preflight:** `require-secrets.sh deploy` (`DATABASE_URL`). Missing `DATABASE_URL` means
   the job is skipped and a notice is printed. The workflow stays green.
2. **`drizzle-kit migrate`** against `DATABASE_URL`. Migrations run **after** the new Worker is
   live, so each migration must be expand-only: the previous Worker version must still work
   against the new schema during the gap.
3. **Smoke test** (`scripts/ci/smoke.sh`) against `PUBLIC_BASE_URL`: `/healthz` must report
   `status: ok`, and `/` must serve the SPA shell.

### Deployment prerequisites & open ops items

- **Provisioned:** Cloudflare KV (`KV` + preview), Hyperdrive (`bolt-club-hq`), R2 bucket (`bolt-club-hq-media`), and Neon Postgres (`neondb`) are created with real IDs in `wrangler.jsonc`.
- **Open:** Create/confirm the `production` GitHub environment (repo Settings → Environments) with a required reviewer if manual approval is desired before migrations run.
- **Required for `deploy.yml`:** `DATABASE_URL` secret and `PUBLIC_BASE_URL` repository variable.
- **Required for runtime:** Worker secrets (Clerk, VAPID, Sentry, `HEALTHCHECK_PING_URL`, `BOOTSTRAP_ADMIN_EMAIL`) set via `npx wrangler secret put`, plus `VITE_CLERK_PUBLISHABLE_KEY` in Cloudflare Workers Builds settings.

### Rollback

`wrangler rollback` restores the previous Worker version. Migrations are not rolled back
automatically: that is why every migration must be expand-only. A destructive change needs a
planned two-step release.

## Remaining manual steps Ashok owns

1. Provision a throwaway restore database/branch in Neon (`RESTORE_TARGET_URL`).
2. Generate `BACKUP_ENCRYPTION_KEY` and store two copies in a password manager.
3. Add the remaining backup/restore/Lighthouse secrets in `docs/ops/secrets.md` under repo settings.
4. Choose the off-site 90-day backup store, provide `BACKUP_BUCKET_TOKEN`, and replace the placeholder fetch step in `.github/workflows/restore-drill.yml`.
5. Run the first real `backup.yml`, `restore-drill.yml`, and `lighthouse.yml` workflows via `workflow_dispatch`.
