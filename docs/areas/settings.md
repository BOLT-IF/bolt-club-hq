# Area: club settings (S2.3, `#84`, `#86`)

- **Backend:** `src/worker/settings/`. `routes.ts` (endpoints), `validation.ts` (pure validators: bank name/account number, IBAN, bankgiro, roster URL, quiet hours, club fees, defaults, account codes), `model.ts` (types, defaults, `toPublicSettings`).
- **Frontend:** `src/app/routes/admin/settings/` registers `/admin/settings` (linked from `AdminIndex` under `System`).
- **Endpoints (relative to `/api/v1`):**
  - `GET /admin/settings`, `PUT /admin/settings`: admin only, audited, singleton row `club_settings.id = 1`.
  - `GET /settings/public`: `requireGuard("member", { allowInactive: true })` so exited members can see bank details to settle balances; returns `clubName`, `bank` (`accountHolder`, `bankName`, `accountNumber`, `iban`, `bankgiro`), `paymentInstructions`, `quietHours`, `rosterAppUrl` only.
  - `/config` is unchanged and anonymous; it carries feature flags only (DECISIONS 2026-11-24, S2.3).
- **Private fields (admin-only):** `passUnpaidRevokeDays` (default 21), `autoPromoteCutoffMin` (default 180), `clubFeeFallSek` (default 160), `clubFeeSpringSek` (default 85), `defaults`, and `accountCodes` (`accounting_account_codes`) must not be forwarded to members.
- **Storage notes:** `bank_details` holds the bank object as JSON text; `quiet_hours`, `defaults`, `accounting_account_codes` are jsonb; `club_fee_fall_sek` and `club_fee_spring_sek` are integer columns (`0004_club_fees.sql`).
- **Flag:** none; the page is admin only and has no feature flag in `wrangler.jsonc`.
