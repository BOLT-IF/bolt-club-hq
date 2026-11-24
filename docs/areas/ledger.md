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

Admin balances/payments/adjustments are S5.4, claims S5.5, passes S5.3.
