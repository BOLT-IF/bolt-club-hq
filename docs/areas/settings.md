# Area: club settings (S2.3)

- **Backend:** `src/worker/settings/`. `routes.ts` (endpoints), `validation.ts` (pure validators: IBAN, bankgiro, roster URL, quiet hours, defaults, account codes), `model.ts` (types, defaults, `toPublicSettings`).
- **Frontend:** `src/app/routes/admin/settings/` registers `/admin/settings` (already in the admin index).
- **Endpoints (relative to `/api/v1`):**
  - `GET /admin/settings`, `PUT /admin/settings`: admin only, audited, singleton row `club_settings.id = 1`.
  - `GET /settings/public`: any active member; `clubName`, `bank`, `paymentInstructions`, `quietHours`, `rosterAppUrl` only.
  - `/config` is unchanged and anonymous; it carries flags only (DECISIONS 2026-11-24, S2.3).
- **Reading settings from other areas:** call `GET /settings/public` from the client. On the Worker, read the `club_settings` row through `c.var.db`; `passUnpaidRevokeDays`, `autoPromoteCutoffMin`, `defaults` and `accountingAccountCodes` are private and must not be forwarded to members.
- **Storage notes:** `bank_details` holds the bank object as JSON text; `quiet_hours`, `defaults`, `accounting_account_codes` are jsonb.
- **Flag:** none; the page is admin only and has no feature flag in `wrangler.jsonc`.
