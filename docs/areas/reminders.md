# Reminders (S6.5a)

Pure rules: `src/domain/reminders/` (validation, templates, `planPaymentDue`, `planEventUnrsvped`, `nextEventWakeUp`). Worker: `src/worker/reminders/` (`service.ts` loads data and sends, `tick.ts` registers the `reminders` tick hook, `routes.ts` is the admin API).

## Rule kinds (`reminder_rule.category`)
| kind | params | notification category | key (send log id = inbox idempotency key) |
|---|---|---|---|
| `payment_due` | `{ thresholdSek }` | `payment_due` | `reminder:<rule>:<member>:<Stockholm date>` |
| `event_unrsvped` | `{ atPublish, hoursBeforeClose \| null }` | `new_events` | `reminder:<rule>:<event>:<member>:publish\|close` |

- Payment: balance (Σ ledger) ≥ threshold, active and inactive members, at most every `minIntervalDays` Stockholm calendar days since this rule's last send to the member.
- Un-RSVPed: eligible active members with no `rsvp` row (any status—including `declined` ("Not going", `#87`) or `cancelled`—counts as responded and suppresses reminders) on a `scheduled` event whose RSVPs are still open. "Publish" fires once when the event comes within 7 days of its start; "close" once from `hoursBeforeClose` before close. Pushes in `new_events` linking to `/events/*` automatically carry `RSVP` / `Not going` quick actions (`#88`).
- Send = `notification_send_log` row + `notify()` in one transaction. Mute etc. are the notify policy chain's job (inbox kept, push dropped).

## API (`/api/v1`, admin only)
- `GET /admin/reminder-rules` → `{ items: Rule[], placeholders: { payment_due: [...], event_unrsvped: [...] } }`
- `POST /admin/reminder-rules` (needs `Idempotency-Key`) body `{ kind, enabled?, minIntervalDays?, template, params }` → 201 Rule. Default interval: 90 (payment), 1.
- `PUT /admin/reminder-rules/:id` same body, full replace → Rule | 404.
- `DELETE /admin/reminder-rules/:id` → 204 | 404 | 409 `rule_has_sends` (disable instead).
- `POST /admin/reminder-rules/:id/preview` → `{ count, recipients: [{memberId, displayName}], sample: {title, body, link} | null }`. Same planner as the real send.
- Validation errors: 400 `{ error: "validation", fields: { template: "unknown placeholder: {x}", "params.thresholdSek": ... } }`.
- Placeholders: payment `{name} {balance} {paymentRef}`; event `{name} {event} {when} {closes}`.

## Admin UI (S6.5b, `#93`)
- Route `/admin/reminders` (`src/app/routes/admin/reminders/`), auto-globbed into the route registry and linked from `adminIndex` in `src/app/shell/navigation.ts`.
- Uses `placeholders` from `GET /admin/reminder-rules` both to render tap-to-insert placeholder chips and to reject unknown placeholders client-side before submit (while also mapping server `400 { error: "validation", fields }` responses onto fields).
- Each rule card uses a `44×44px` `⋯` overflow button opening an `ActionSheet` (`Preview`, `Enable`/`Disable`, `Edit`, divider, soft-red `Delete` → solid-red `ConfirmDialog`).
- Handles `403` cleanly with an "Admins only" state, `POST` with `Idempotency-Key`, preview in a bottom sheet via `POST /admin/reminder-rules/:id/preview`, enable/disable via `PUT`, and `409 rule_has_sends` on `DELETE` by offering a one-tap "Disable instead" action (or explaining it is already disabled).
