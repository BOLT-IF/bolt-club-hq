import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  BottomSheet,
  Button,
  ConfirmDialog,
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

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Stockholm",
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatEntryAmount(amountSek: number): string {
  return `${amountSek < 0 ? "-" : ""}${String(Math.abs(amountSek))} kr`;
}

const itemLabel = (item: LedgerItem) =>
  `${REASON_LABEL[item.reason] ?? item.reason} · ${formatEntryAmount(item.amountSek)}`;

function cleanEntryNote(item: LedgerItem): string {
  const note = item.note.trim();
  if (!note) return "";
  if (item.reason === "club_fee") {
    return note.replace(/^club\s+fee\s*[—–-]\s*/i, "");
  }
  return note;
}

function isUnpaidEntry(item: LedgerItem): boolean {
  return item.status === "unpaid" || item.status === "partly_paid";
}

function BanknoteIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="12" x="2" y="6" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

function PlusCircleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </svg>
  );
}

function FileMinusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M9 15h6" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  );
}

function CopySmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckSmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** What the open sheet does. Each kind maps to one POST. */
type Action =
  | { readonly kind: "payment" }
  | { readonly kind: "charge" }
  | { readonly kind: "writeoff" }
  | { readonly kind: "waive"; readonly item: LedgerItem }
  | { readonly kind: "reverse"; readonly item: LedgerItem };

interface SheetSpec {
  readonly title: string;
  readonly summary?: string;
  readonly submit: string;
  readonly showCancel?: boolean;
  readonly destructive?: boolean;
  readonly amount: boolean;
  readonly noteLabel: string;
  readonly noteRequired: boolean;
  readonly done: string;
}

function entrySummary(item: LedgerItem): string {
  const details = [item.eventTitle, cleanEntryNote(item)].filter(Boolean).join(" · ");
  return details ? `${itemLabel(item)} — ${details}` : itemLabel(item);
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
        summary: `Waive ${entrySummary(action.item)} for ${name}?`,
        submit: "Confirm waiver",
        showCancel: true,
        amount: false,
        noteLabel: "Reason",
        noteRequired: true,
        done: "Charge waived",
      };
    case "reverse":
      return {
        title: `Reverse ${itemLabel(action.item)}`,
        summary: `Reverse ${entrySummary(action.item)} for ${name}?`,
        submit: "Confirm reversal",
        showCancel: true,
        destructive: true,
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
  const [pendingRevokePass, setPendingRevokePass] = useState<LedgerItem | null>(null);
  const [revokingPass, setRevokingPass] = useState(false);
  const [revokeKey, setRevokeKey] = useState(newIdempotencyKey);
  const [refCopied, setRefCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    [],
  );

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

  const unpaidItems = ledger.items.filter(isUnpaidEntry);
  const historyItems = ledger.items.filter((item) => !isUnpaidEntry(item));

  const copyRef = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    (clipboard
      ? clipboard.writeText(ledger.member.paymentRef)
      : Promise.reject(new Error("no clipboard"))
    ).then(
      () => {
        setRefCopied(true);
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setRefCopied(false);
        }, 2000);
      },
      () => {
        toast.show("Could not copy automatically. Long-press to copy.", "danger");
      },
    );
  };

  const renderEntryCard = (item: LedgerItem) => {
    const status = STATUS_LABEL[item.status] ?? { label: item.status, tone: "neutral" as const };
    const cleanedNote = cleanEntryNote(item);
    const metaParts = [
      dateFmt.format(new Date(item.createdAt)),
      item.outstandingSek > 0 ? `${String(item.outstandingSek)} kr left` : null,
      item.eventTitle,
      item.guestName ? `guest ${item.guestName}` : null,
      cleanedNote || null,
    ].filter((part): part is string => Boolean(part));

    const canWaive = item.waivable;
    const canRevokePass = Boolean(item.passRevocable && item.passId);
    const canReverse = item.reversible;
    const actionCount = [canWaive, canRevokePass, canReverse].filter(Boolean).length;

    return (
      <li key={item.id} className="bcq-member bcq-ledger-card">
        <div className="bcq-ledger-card__top">
          <div className="bcq-ledger-card__main">
            <h3 className="bcq-ledger-card__title bcq-tabular-nums">{itemLabel(item)}</h3>
            <p className="bcq-ledger-card__meta bcq-tabular-nums">{metaParts.join(" · ")}</p>
          </div>
          <div className="bcq-ledger-card__badge">
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
          </div>
        </div>
        {actionCount > 0 ? (
          <div
            className={
              actionCount > 1
                ? "bcq-ledger-card__actions bcq-ledger-card__actions--pair"
                : "bcq-ledger-card__actions"
            }
          >
            {canWaive ? (
              <button
                type="button"
                className="bcq-ledger-entry-btn bcq-ledger-entry-btn--tonal"
                aria-label={`Waive ${itemLabel(item)}`}
                onClick={open({ kind: "waive", item })}
              >
                Waive
              </button>
            ) : null}
            {canRevokePass ? (
              <button
                type="button"
                className="bcq-ledger-entry-btn bcq-ledger-entry-btn--danger"
                aria-label={`Revoke ${itemLabel(item)}`}
                onClick={() => {
                  setRevokeKey(newIdempotencyKey());
                  setPendingRevokePass(item);
                }}
              >
                Revoke Pass
              </button>
            ) : null}
            {canReverse ? (
              <button
                type="button"
                className="bcq-ledger-entry-btn bcq-ledger-entry-btn--danger"
                aria-label={`Reverse ${itemLabel(item)}`}
                onClick={open({ kind: "reverse", item })}
              >
                Reverse
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className="bcq-page bcq-money-page" aria-labelledby="admin-ledger-title">
      <div>
        <h1 id="admin-ledger-title" className="bcq-page__title">
          {name}
        </h1>
        <div className="bcq-ledger-identity">
          <StatusChip tone={balanceTone(ledger.balanceSek)}>
            {describeBalance(ledger.balanceSek)}
          </StatusChip>
          <button
            type="button"
            className={
              refCopied ? "bcq-ledger-ref-btn bcq-ledger-ref-btn--copied" : "bcq-ledger-ref-btn"
            }
            aria-label={`Copy payment reference ${ledger.member.paymentRef}`}
            onClick={copyRef}
          >
            {refCopied ? (
              <>
                <CheckSmIcon />
                <span>Copied</span>
              </>
            ) : (
              <>
                <span>
                  Ref <span className="bcq-mono-code">{ledger.member.paymentRef}</span>
                </span>
                <CopySmIcon />
              </>
            )}
          </button>
        </div>
      </div>

      <div className="bcq-ledger-actions-grid">
        <button
          type="button"
          className="bcq-ledger-action-btn bcq-ledger-action-btn--primary"
          onClick={open({ kind: "payment" })}
        >
          <BanknoteIcon />
          <span>Record Payment</span>
        </button>
        <button
          type="button"
          className="bcq-ledger-action-btn bcq-ledger-action-btn--elevated"
          onClick={open({ kind: "charge" })}
        >
          <PlusCircleIcon />
          <span>Add Charge</span>
        </button>
        <button
          type="button"
          className="bcq-ledger-action-btn bcq-ledger-action-btn--elevated"
          onClick={open({ kind: "writeoff" })}
        >
          <FileMinusIcon />
          <span>Write Off</span>
        </button>
        <button
          type="button"
          className="bcq-ledger-action-btn bcq-ledger-action-btn--elevated"
          onClick={() => {
            setAssignOpen(true);
          }}
        >
          <TicketIcon />
          <span>Assign Pass</span>
        </button>
      </div>

      {ledger.items.length === 0 ? (
        <div className="bcq-money-section">
          <h2 className="bcq-ledger-subheader">Entries (0)</h2>
          <EmptyState title="No Entries Yet">Charges and payments appear here.</EmptyState>
        </div>
      ) : unpaidItems.length > 0 ? (
        <>
          <div className="bcq-money-section">
            <h2 className="bcq-ledger-subheader">Unpaid ({unpaidItems.length})</h2>
            <ul className="bcq-members" aria-label="Unpaid ledger entries">
              {unpaidItems.map(renderEntryCard)}
            </ul>
          </div>
          {historyItems.length > 0 ? (
            <div className="bcq-money-section">
              <h2 className="bcq-ledger-subheader">Ledger History ({historyItems.length})</h2>
              <ul className="bcq-members" aria-label="Ledger history">
                {historyItems.map(renderEntryCard)}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div className="bcq-money-section">
          <h2 className="bcq-ledger-subheader">Entries ({historyItems.length})</h2>
          <ul className="bcq-members" aria-label="Ledger entries">
            {historyItems.map(renderEntryCard)}
          </ul>
        </div>
      )}

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

      <ConfirmDialog
        open={pendingRevokePass !== null}
        title="Revoke Pass?"
        description={
          pendingRevokePass
            ? `Revoke ${name}'s ${pendingRevokePass.note || "season pass"}? This reverses the ${String(pendingRevokePass.amountSek)} kr charge, frees the seat, and downgrades open RSVPs to requested.`
            : ""
        }
        confirmLabel={revokingPass ? "Revoking…" : "Confirm Revocation"}
        destructive
        onCancel={() => {
          if (!revokingPass) setPendingRevokePass(null);
        }}
        onConfirm={() => {
          const passId = pendingRevokePass?.passId;
          if (!passId || revokingPass) return;
          setRevokingPass(true);
          void apiFetch(`/admin/passes/${encodeURIComponent(passId)}/revoke`, {
            method: "POST",
            body: {},
            idempotencyKey: revokeKey,
          })
            .then(async () => {
              toast.show(`Revoked ${name}'s pass.`, "success");
              setPendingRevokePass(null);
              setRevokeKey(newIdempotencyKey());
              await load();
            })
            .catch((error: unknown) => {
              const code =
                error instanceof ApiError
                  ? (error.body as { error?: unknown } | null)?.error
                  : undefined;
              if (code !== "idempotency_key_in_progress") {
                setRevokeKey(newIdempotencyKey());
              }
              toast.show(describeError(error), "danger");
            })
            .finally(() => {
              setRevokingPass(false);
            });
        }}
      />
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
        {spec.summary ? <p className="bcq-confirm__text bcq-tabular-nums">{spec.summary}</p> : null}
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
        {spec.showCancel ? (
          <div className="bcq-confirm__actions">
            <Button type="button" variant="tonal" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={spec.destructive ? "destructive-solid" : "primary"}
              disabled={busy}
            >
              {spec.submit}
            </Button>
          </div>
        ) : (
          <Button type="submit" disabled={busy}>
            {spec.submit}
          </Button>
        )}
      </form>
    </BottomSheet>
  );
}
