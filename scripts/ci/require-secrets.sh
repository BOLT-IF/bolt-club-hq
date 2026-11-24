#!/usr/bin/env bash
# Secrets guard for scheduled and deploy jobs (S0.5: "guard so it doesn't fail CI before
# secrets exist"). Each job lists the secrets it needs. If any are missing, the job skips with a
# notice and exits 0, so CI stays green until Ashok adds the secrets (docs/ops/secrets.md).
#
# Usage: require-secrets.sh <job>
#   job = deploy | backup | restore-drill | lighthouse
#
# Writes a skip/proceed line to stdout and, in GitHub Actions, to the step summary.
# The verdict is `ready=true|false` in $GITHUB_OUTPUT. Workflows must gate on
# `steps.guard.outputs.ready`, never on the exit code: a skip also exits 0 (green).
# Exit codes: 0 proceed or skip, 2 unknown job name (fails closed on a typo).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: require-secrets.sh <deploy|backup|restore-drill|lighthouse>" >&2
  exit 2
fi
JOB="$1"

case "$JOB" in
  deploy)        NEEDED=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID DATABASE_URL) ;;
  backup)        NEEDED=(DATABASE_URL BACKUP_ENCRYPTION_KEY BACKUP_BUCKET_TOKEN) ;;
  restore-drill) NEEDED=(DATABASE_URL RESTORE_TARGET_URL BACKUP_ENCRYPTION_KEY) ;;
  lighthouse)    NEEDED=(LHCI_TARGET_URL) ;;
  *)
    echo "require-secrets: unknown job '$JOB'." >&2
    exit 2
    ;;
esac

missing=()
for name in "${NEEDED[@]}"; do
  # Indirect expansion keeps this check generic. The value itself is never printed.
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

say() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

verdict() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "ready=$1" >> "$GITHUB_OUTPUT"; fi
}

if [ "${#missing[@]}" -gt 0 ]; then
  say "require-secrets: SKIPPING '$JOB'. Missing secret(s): ${missing[*]}."
  say "Add them under repo Settings > Secrets and variables > Actions. See docs/ops/secrets.md."
  verdict false
  exit 0
fi

say "require-secrets: all secrets present for '$JOB'; proceeding."
verdict true
