# Ledger

Append-only money record (PLAN §5.2, §9). Amounts are whole kronor, signed: **positive = the member owes, negative = credit**. Balance = Σ `amount_sek`.

## Using it from other stories

```ts
import { createLedgerService } from "../ledger/service";
import { createChargePort, createReversePort } from "../ledger/ports";

// Pass your transaction as `db` so the money commits or rolls back with your work.
const ledger = createLedgerService({ db: tx, clock });
await ledger.charge({ memberId, amountSek: 120, reason: "adhoc", eventId, idempotencyKey: `close:${eventId}:${memberId}` });
await ledger.reverse({ entryId, idempotencyKey: `reverse:${entryId}` });
await ledger.recordPayment({ memberId, amountSek: 500, actor, idempotencyKey });   // admin only
await ledger.adjust({ memberId, amountSek: -100, reason: "waiver", note, actor, idempotencyKey }); // admin only
await ledger.balance(memberId);   // Σ amount
await ledger.itemize(memberId);   // FIFO allocation: owedSek, creditSek, per-entry status
```

`createChargePort` / `createReversePort` are the production `ChargePort` / `ReversePort` (the fakes in `test-support/fakes.ts` stay test-only; `production-wiring.test.ts` asserts no production file imports them).

## Rules

- Every write takes an `idempotencyKey`; the row id is `led_<key>` (`ledgerEntryIdFor`). A repeated key writes nothing and returns `{ created: false }`. The same key with different content throws `idempotency_conflict`.
- `charge`: reasons `pass | adhoc | guest | manual`. Without `actor` it is a system write (close, passes) attributed to the member. With `actor` it is an admin write.
- `recordPayment`, `adjust`, and any `reverse` with an `actor` are admin writes: active admin only, self-ledger guard (A11), audit row in the same transaction. `adjust` always needs a note; a waiver is negative.
- `reverse` appends the negated amount, linked by `reverses_entry_id`. It locks the original (`FOR UPDATE`), refuses a reversal of a reversal (`cannot_reverse_reversal`) and a second reversal of one entry (`already_reversed`), even under different keys.
- Self-ledger guard: an admin writing on their own ledger is blocked (`self_ledger_blocked`) while another **active** admin exists. The only admin is allowed, and the audit row carries `selfLedgerFlagged: true`.
- Amounts must be non-zero safe integers within Postgres `integer` (`invalid_amount` otherwise). `LedgerError.code` is stable.
- `createdAt` comes from the injected `Clock`, not the database default.

## FIFO itemization (`src/domain/ledger/itemize.ts`)

Money in (payments, waivers, reversals of charges) is matched against money owed (charges, positive adjustments) oldest first by `(createdAt, id)`. A partial payment covers the oldest charge and spills into the next; leftover credit is consumed by later charges. A fully reversed entry and its reversal drop out of the allocation. `owedSek = max(balance, 0)`, `creditSek = max(-balance, 0)`.

## Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /api/v1/me/ledger` | member, `allowInactive` | Own entries only, with FIFO status, event title/date and guest name. `?memberId=` other than your own is 403, admins included. |
| `GET /api/v1/admin/balances` | admin | Every member: `id`, `displayName`, `paymentRef`, `status`, `balanceSek`, `owedSek`, `creditSek`. |
| `GET /api/v1/admin/balances/:memberId` | admin | One member's FIFO itemization, plus `waivable` / `reversible` per entry. |
| `POST /api/v1/admin/payments` | admin, `Idempotency-Key` | `{ memberId, amountSek, note? }`, whole kronor > 0. Returns `{ entryId, balanceSek }` (201). |
| `POST /api/v1/admin/adjustments` | admin, `Idempotency-Key` | `{ type, note, … }`, note required. `waiver`+`entryId` (reversal), `waiver`+`memberId`+`amountSek` (write-off), `charge`+`memberId`+`amountSek` (manual), `reversal`+`entryId`. |
| `GET /api/v1/me/payment-claims` | member, `allowInactive` | Caller's own claims (`pending \| confirmed \| rejected`), newest `paidOn` first. |
| `POST /api/v1/me/payment-claims` | member, `allowInactive`, `Idempotency-Key` | `{ amountSek (> 0 integer), paidOn ("YYYY-MM-DD" <= today Stockholm), note? }`. Never touches the ledger. |
| `GET /api/v1/admin/payment-claims` | admin | Pending claims only, oldest `paidOn` first, with `displayName`, `paymentRef`, `balanceSek`, and `isOwn`. |
| `POST /api/v1/admin/payment-claims/:id/confirm` | admin, `Idempotency-Key` | Records one payment keyed `claim:<id>`, confirms claim, audits, notifies (`payment_status`). Refuses `own_claim` (403). |
| `POST /api/v1/admin/payment-claims/:id/reject` | admin, `Idempotency-Key` | `{ reason }` (non-blank, ≤ 500). Rejects claim, audits, notifies with reason and link `/money/claims`. Refuses `own_claim` (403). |

Admin routes live in `src/worker/ledger/admin-routes.ts` (S5.4), mounted by `routes.ts` with `.route("/", adminRoutes)`. Claims routes live in `src/worker/ledger/claims.ts` (S5.5), mounted by `routes.ts` with `.route("/", claimsRoutes)`. UI: `src/app/routes/admin/money/` (`/admin/money`, `/admin/money/members/:id`, `/admin/money/claims`), behind the `money` flag. Passes and revocation are S5.3, export S5.6.

## Member screen (S5.2)

- `/money` (`src/app/routes/money/`), behind `FLAG_MONEY`. Client calls live in `src/app/api/ledger.ts` (`fetchMyLedger`, `fetchPaymentSettings`, `fetchMyPaymentRef`); there is no member-id parameter.
- Shows the balance ("You owe 90 kr", "Credit 100 kr", "You're all paid up"), "How to pay" (bank details and instructions from `GET /settings/public`, payment reference from `GET /me/profile`, with a copy button) and every entry newest first with its FIFO status, event title and date, and guest name.
- The ledger is required; settings and profile are best effort. If either fails, the screen says "Ask the treasurer for the club's bank details" instead of failing.
- S5.5 adds the "I've paid" claim flow at `/money/claims` (`src/app/routes/money/claims/`), S5.3 adds passes as `src/app/routes/money/passes*` and revocable-pass filtering + revocation on `AdminBalances.tsx`.

## Payment claims (S5.5)

- **Member UI (`/money/claims`):** `src/app/routes/money/claims/routes.tsx` (`MemberClaimsPage`), gated on `useFeatureFlag("money")`. Shows the "I've paid" form (`amountSek` whole kronor > 0, `paidOn` date in Stockholm not after today, optional `note`) and the member's claim history (`GET /me/payment-claims`) with status chips and rejection reasons. Holds one `Idempotency-Key` per submission attempt (reused on timeout / 409 `idempotency_key_in_progress`, rotated on final 4xx or success).
- **Admin UI (`/admin/money/claims`):** `src/app/routes/admin/money/claims/routes.tsx` (`AdminClaimsPage`), gated on `useFeatureFlag("money")`. Shows the pending queue (`GET /admin/payment-claims`), one-tap **Confirm** (`POST /admin/payment-claims/:id/confirm` with `Idempotency-Key` per claim attempt), and **Reject** via a bottom sheet requiring a non-blank reason (`POST /admin/payment-claims/:id/reject` with `Idempotency-Key`). Rows with `isOwn` disable Confirm/Reject and explain that another admin must decide; a server `403 own_claim` is also mapped and explained.

## Passes (S5.3, `src/worker/passes/`)

- `GET /api/v1/passes/offers` (member): active/open-for-passes series with `remainingEvents > 0`, prorated via `round_half_up(pass_price * remaining / total)`, plus the member's own passes.
- `POST /api/v1/passes` (member, `Idempotency-Key`): enforces `pass_cap` under a `series` row lock, charges via `createLedgerService` (`pass:<passId>`), upgrades open series RSVPs to tier 1 `confirmed`. No refund path.
- `GET /api/v1/admin/passes` (admin) & `POST /api/v1/admin/passes/:id/revoke` (admin, `Idempotency-Key`): revocable only once `passUnpaidRevokeDays` has elapsed and the charge is still `unpaid`. Reverses the charge (`reason: "revocation"`), frees the seat, downgrades open RSVPs to tier 2, and notifies the member.
- `src/worker/passes/prepaid.ts` (`createPrepaidPort`) is the production `PrepaidPort` wired in `src/worker/rsvp/deps.ts`.
