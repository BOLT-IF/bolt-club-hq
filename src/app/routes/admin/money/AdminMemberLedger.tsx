import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { useRouteParams } from "../../registry";
import { AssignPassSheet } from "./AssignPassSheet";
import {
  REASON_LABEL,
  STATUS_LABEL,
  balanceTone,
  describeBalance,
  describeError,
  isFinalRefusal,
  parseKronor,
  type LedgerItem,
  type MemberLedger,
} from "./moneyApi";
import "../../members/members.css";
import "./money.css";

const dateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const itemLabel = (item: LedgerItem) =>
  `${REASON_LABEL[item.reason] ?? item.reason} ${String(Math.abs(item.amountSek))} kr`;

/** What the open sheet does. Each kind maps to one POST. */
type Action =
  | { readonly kind: "payment" }
  | { readonly kind: "charge" }
  | { readonly kind: "writeoff" }
  | { readonly kind: "waive"; readonly item: LedgerItem }
  | { readonly kind: "reverse"; readonly item: LedgerItem };

interface SheetSpec {
  readonly title: string;
  readonly submit: string;
  readonly amount: boolean;
  readonly noteLabel: string;
  readonly noteRequired: boolean;
  readonly done: string;
}

function specOf(action: Action, name: string): SheetSpec {
  switch (action.kind) {
    case "payment":
      return {
        title: `Record payment for ${name}`,
        submit: "Save payment",
        amount: true,
        noteLabel: "Note (optional)",
        noteRequired: false,
        done: "Payment recorded",
      };
    case "charge":
      return {
        title: `Add a charge for ${name}`,
        submit: "Save charge",
        amount: true,
        noteLabel: "Reason",
        noteRequired: true,
        done: "Charge added",
      };
    case "writeoff":
      return {
        title: `Write off an amount for ${name}`,
        submit: "Confirm write-off",
        amount: true,
        noteLabel: "Reason",
        noteRequired: true,
        done: "Amount written off",
      };
    case "waive":
      return {
        title: `Waive ${itemLabel(action.item)}`,
        submit: "Confirm waiver",
        amount: false,
        noteLabel: "Reason",
        noteRequired: true,
        done: "Charge waived",
      };
    case "reverse":
      return {
        title: `Reverse ${itemLabel(action.item)}`,
        submit: "Confirm reversal",
        amount: false,
        noteLabel: "Reason",
        noteRequired: true,
        done: "Entry reversed",
      };
  }
}

function requestOf(
  action: Action,
  memberId: string,
  amountSek: number | null,
  note: string,
): { path: string; body: Record<string, unknown> } {
  switch (action.kind) {
    case "payment":
      return {
        path: "/admin/payments",
        body: { memberId, amountSek, ...(note ? { note } : {}) },
      };
    case "charge":
      return { path: "/admin/adjustments", body: { type: "charge", memberId, amountSek, note } };
    case "writeoff":
      return { path: "/admin/adjustments", body: { type: "waiver", memberId, amountSek, note } };
    case "waive":
      return {
        path: "/admin/adjustments",
        body: { type: "waiver", entryId: action.item.id, note },
      };
    case "reverse":
      return {
        path: "/admin/adjustments",
        body: { type: "reversal", entryId: action.item.id, note },
      };
  }
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly ledger: MemberLedger };

/** One member's ledger with FIFO status, plus payment, charge, waiver and reversal actions. */
export function AdminMemberLedger() {
  const moneyOn = useFeatureFlag("money");
  const memberId = useRouteParams().id ?? "";
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [action, setAction] = useState<Action | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      apiFetch<MemberLedger>(`/admin/balances/${encodeURIComponent(memberId)}`)
        .then((ledger) => {
          if (!isCancelled()) setState({ kind: "ready", ledger });
        })
        .catch(() => {
          if (!isCancelled()) setState({ kind: "error" });
        }),
    [memberId],
  );

  useEffect(() => {
    if (!moneyOn) return;
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [moneyOn, load]);

  if (!moneyOn) {
    return <EmptyState title="Money">Money is not switched on yet.</EmptyState>;
  }
  if (state.kind === "loading") return <Skeleton label="Loading ledger" />;
  if (state.kind === "error") {
    return (
      <ErrorState title="Couldn't load this ledger" onRetry={() => void load()}>
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  const { ledger } = state;
  const name = ledger.member.displayName;
  const open = (next: Action) => () => {
    setAction(next);
  };

  return (
    <section className="bcq-page bcq-money-page" aria-labelledby="admin-ledger-title">
      <div>
        <h1 id="admin-ledger-title" className="bcq-page__title">
          {name}
        </h1>
        <div className="bcq-member__head">
          <StatusChip tone={balanceTone(ledger.balanceSek)}>
            {describeBalance(ledger.balanceSek)}
          </StatusChip>
          <span className="bcq-member__meta">Payment reference {ledger.member.paymentRef}</span>
        </div>
      </div>

      <div className="bcq-member__actions">
        <Button onClick={open({ kind: "payment" })}>Record Payment</Button>
        <Button variant="tonal" onClick={open({ kind: "charge" })}>
          Add Charge
        </Button>
        <Button variant="tonal" onClick={open({ kind: "writeoff" })}>
          Write Off
        </Button>
        <Button
          variant="tonal"
          onClick={() => {
            setAssignOpen(true);
          }}
        >
          Assign Pass
        </Button>
      </div>

      <div className="bcq-money-section">
        <h2 className="bcq-member__name">Entries</h2>
        {ledger.items.length === 0 ? (
          <EmptyState title="No Entries Yet">Charges and payments appear here.</EmptyState>
        ) : (
          <ul className="bcq-members" aria-label="Ledger entries">
            {ledger.items.map((item) => {
              const status = STATUS_LABEL[item.status] ?? { label: item.status, tone: "neutral" };
              return (
                <li key={item.id} className="bcq-member">
                  <div className="bcq-member__head">
                    <span className="bcq-member__name">
                      {REASON_LABEL[item.reason] ?? item.reason}
                    </span>
                    <span className="bcq-money-amount">
                      {item.amountSek > 0 ? "" : "−"}
                      {Math.abs(item.amountSek)} kr
                    </span>
                    <StatusChip tone={status.tone}>{status.label}</StatusChip>
                  </div>
                  <p className="bcq-member__meta">
                    {dateFmt.format(new Date(item.createdAt))}
                    {item.eventTitle ? ` · ${item.eventTitle}` : ""}
                    {item.guestName ? ` · guest ${item.guestName}` : ""}
                    {item.outstandingSek > 0 ? ` · ${String(item.outstandingSek)} kr left` : ""}
                    {item.note ? ` · ${item.note}` : ""}
                  </p>
                  {item.waivable || item.reversible ? (
                    <div className="bcq-member__actions">
                      {item.waivable ? (
                        <Button
                          variant="tonal"
                          aria-label={`Waive ${itemLabel(item)}`}
                          onClick={open({ kind: "waive", item })}
                        >
                          Waive
                        </Button>
                      ) : null}
                      {item.reversible ? (
                        <Button
                          variant="destructive-tonal"
                          aria-label={`Reverse ${itemLabel(item)}`}
                          onClick={open({ kind: "reverse", item })}
                        >
                          Reverse
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {action ? (
        <EntrySheet
          spec={specOf(action, name)}
          onClose={() => {
            setAction(null);
          }}
          onSubmit={async (amountSek, note, idempotencyKey) => {
            const { path, body } = requestOf(action, ledger.member.id, amountSek, note);
            await apiFetch(path, { method: "POST", body, idempotencyKey });
            toast.show(specOf(action, name).done, "success");
            setAction(null);
            await load();
          }}
        />
      ) : null}

      {assignOpen ? (
        <AssignPassSheet
          member={{ id: ledger.member.id, displayName: name }}
          onClose={() => {
            setAssignOpen(false);
          }}
          onAssigned={async () => {
            toast.show(`Assigned pass to ${name}.`, "success");
            setAssignOpen(false);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Amount and note form. The Idempotency-Key is made once per opened sheet, so a retry
 * after a timeout or a 409 "in progress" can never record the money twice. After a
 * definite refusal (4xx) the server has stored that answer under the key, so the key is
 * replaced; otherwise the corrected retry would replay the old refusal.
 */
function EntrySheet({
  spec,
  onClose,
  onSubmit,
}: {
  readonly spec: SheetSpec;
  readonly onClose: () => void;
  readonly onSubmit: (amountSek: number | null, note: string, key: string) => Promise<void>;
}) {
  const [key, setKey] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    const amountSek = spec.amount ? parseKronor(amount) : null;
    if (spec.amount && amountSek === null) {
      setError("Enter whole kronor above 0.");
      return;
    }
    if (spec.noteRequired && note.trim() === "") {
      setError("A reason is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(amountSek, note.trim(), key);
    } catch (failure) {
      setError(describeError(failure));
      if (isFinalRefusal(failure)) setKey(newIdempotencyKey());
      setBusy(false);
    }
  }

  return (
    <BottomSheet open title={spec.title} onClose={onClose}>
      <form className="bcq-form" noValidate onSubmit={(e) => void submit(e)}>
        {spec.amount ? (
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="money-amount">
              Amount (kr)
            </label>
            <input
              id="money-amount"
              className="bcq-input"
              inputMode="numeric"
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
              }}
            />
          </div>
        ) : null}
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="money-note">
            {spec.noteLabel}
          </label>
          <textarea
            id="money-note"
            className="bcq-input bcq-textarea"
            maxLength={500}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </div>
        {error ? (
          <p className="bcq-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {spec.submit}
        </Button>
      </form>
    </BottomSheet>
  );
}
