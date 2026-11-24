# Secrets inventory (S0.5)

Every secret the deploy, backup, restore and Lighthouse workflows need. Set them under **repo
Settings → Secrets and variables → Actions**. Workflows skip with a notice until the secrets they
need exist (`scripts/ci/require-secrets.sh`), so a missing secret never turns CI red. The script
writes `ready=true|false` to `$GITHUB_OUTPUT`; jobs gate on `steps.guard.outputs.ready`, never on
its exit code (a skip also exits 0).

**Never commit a secret value, and never paste one into an issue, PR or chat.** The repo is
private, but a leak still means rotating the key.

## Status

Nothing is set yet. Ashok supplies every value below. Until the Cloudflare and Neon accounts
exist, the deploy, backup, restore-drill and Lighthouse jobs all skip.

## GitHub Actions secrets

| Name | Used by | What it is | Where it comes from | Rotation |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy | API token for `wrangler deploy`. Scope it to Workers Scripts edit, plus the account's KV, R2 and Hyperdrive edit. | Cloudflare dashboard → My Profile → API Tokens | Rotate on suspicion of a leak, or yearly. |
| `CLOUDFLARE_ACCOUNT_ID` | deploy | The account ID shown on the Workers overview page. Not sensitive, but kept as a secret for simplicity. | Cloudflare dashboard | Does not change. |
| `DATABASE_URL` | deploy, backup, restore-drill | Neon connection string for **production**. Used by `drizzle-kit migrate` and `pg_dump`. Use the pooled or direct URL with `sslmode=require`. | Neon console → project → connection details | On password reset. Update both the Neon role and this secret. |
| `RESTORE_TARGET_URL` | restore-drill | Connection string for an **empty, throwaway** database. Must **not** equal `DATABASE_URL`; the script refuses. | Create a second Neon branch (or database) just for drills | On password reset. |
| `BACKUP_ENCRYPTION_KEY` | backup, restore-drill | Passphrase for AES-256 encryption of dumps (PBKDF2, 600k iterations). **Losing it makes every backup unreadable.** | Generate once, e.g. `openssl rand -base64 48`. Store a second copy in the owner's password manager. | **Never rotate casually.** Rotating means old dumps need the old key. Keep the old key until the 90-day window passes. |
| `BACKUP_BUCKET_TOKEN` | backup | Credential for the off-site backup store, once one is chosen (see `backups.md`). | Store provider | Yearly. |
| `LHCI_TARGET_URL` | lighthouse | The public origin to audit, e.g. `https://bolt-club-hq.<account>.workers.dev`. | Cloudflare | Changes only if the domain changes. |

## GitHub repository variables (not secret)

| Name | Used by | Value |
|---|---|---|
| `PUBLIC_BASE_URL` | deploy (smoke test) | The public origin, e.g. `https://bolt-club-hq.<account>.workers.dev`. Same value as `LHCI_TARGET_URL`. |

## Worker runtime secrets (set with `wrangler secret put`, not GitHub)

These live in Cloudflare, not in GitHub. Set them with `npx wrangler secret put <NAME>` after the
account exists. They are read by the Worker at runtime.

| Name | What it is | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | Clerk backend secret key (`sk_test_…` in dev, `sk_live_…` in production) | Used to verify JWTs via cached JWKS. The publishable key (`pk_…`) is not secret and goes in the build. |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key (`pk_test_…` / `pk_live_…`) | Not secret, but kept with the others for clarity. |
| `VAPID_PUBLIC_KEY` | Web Push public key | Shared with the browser at subscribe time. |
| `VAPID_PRIVATE_KEY` | Web Push private key | **Back this up and never rotate casually.** Rotating it invalidates every existing push subscription, so every member must re-enable notifications on every device. |
| `VAPID_SUBJECT` | `mailto:` or `https:` contact used in the push header | Use the club's contact address. |
| `HEALTHCHECKS_URL` | healthchecks.io ping URL for the cron dead-man switch (PLAN §15) | The URL itself is the secret; anyone with it can ping the check. |
| `SENTRY_DSN` | Sentry DSN for the Worker and browser reporters (S0.7; both post envelopes with `fetch`, no SDK) | A DSN is not a credential for reading data, but treat it as internal. |
| `BOOTSTRAP_ADMIN_EMAIL` | The one email that becomes admin on first sign-in (S1.1) | Not a secret, but kept out of the repo so the club's admin address is not public. |

## Notes on the high-stakes ones

- **`BACKUP_ENCRYPTION_KEY`:** keep two copies, in separate places, both held by the owner. A
  dump encrypted with a lost key is lost data. Test the key during the restore drill: a wrong
  key fails the drill on purpose.
- **`VAPID_PRIVATE_KEY`:** back it up in the owner's password manager at the moment it is
  generated. Rotating it forces every member to re-subscribe on every device, so do not rotate
  it to fix an unrelated problem.
- **`CLERK_SECRET_KEY`:** use the `test` key until the domain exists (see `DECISIONS.md`,
  domain deferred). Production keys go live only with S0.6 part B.

## Adding a new secret

1. Add it to this table, with its purpose and rotation rule.
2. Add it to `scripts/ci/require-secrets.sh` only if a workflow job needs it to run.
3. Add it to the matching job's `env:` block using `${{ secrets.NAME }}`. Never echo it.
4. A new guarded job calls `bash scripts/ci/require-secrets.sh <job>` bare (`id: guard`) and gates
   its steps on `steps.guard.outputs.ready == 'true'`. The CI-script tests fail if a workflow
   wraps the guard in `if`.
