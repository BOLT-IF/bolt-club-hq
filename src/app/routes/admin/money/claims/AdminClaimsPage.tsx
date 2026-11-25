import "../../../members/members.css";
import "../money.css";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../../api/client";
import {
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../../components/ui";
import { useFeatureFlag } from "../../../../lib/flags";
import { balanceTone, describeBalance } from "../moneyApi";

export interface AdminPaymentClaim {
  readonly id: string;
  readonly memberId: string;
  readonly amountSek: number;
  readonly paidOn: string;
  readonly note: string | null;
  readonly status: "pending" | "confirmed" | "rejected";
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
  readonly displayName: string;
  readonly paymentRef: string;
  readonly balanceSek: number;
  readonly isOwn: boolean;
}

const claimDayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? day : claimDayFmt.format(parsed);
}

function isFinalRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return false;
  return (error.body as { error?: unknown } | null)?.error !== "idempotency_key_in_progress";
}

const ADMIN_CLAIM_ERROR_MESSAGES: Record<string, string> = {
  own_claim: "You can't confirm or reject your own payment claim. Another admin must review it.",
  reason_required: "A reason is required.",
  claim_not_found: "That claim no longer exists. Reload the queue.",
  claim_decided: "This claim has already been decided. Reloading the queue.",
  self_ledger_blocked: "This is your own ledger. Another admin must confirm it.",
  idempotency_key_in_progress: "Still saving the first attempt. Try again in a moment.",
  idempotency_conflict: "This was already saved with different details. Reload the page.",
};

function describeAdminClaimError(error: unknown): { message: string; reload: boolean } {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && ADMIN_CLAIM_ERROR_MESSAGES[code]) {
      return {
        message: ADMIN_CLAIM_ERROR_MESSAGES[code],
        reload: code === "claim_decided" || code === "claim_not_found",
      };
    }
    if (error.status === 403) {
      return { message: "You don't have permission to do that.", reload: false };
    }
  }
  return { message: "Couldn't save. Check your connection and try again.", reload: false };
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly claims: readonly AdminPaymentClaim[] };

/** Admin pending claims queue (S5.5, PLAN §9): one-tap confirm or reject with reason; own claims blocked. */
export function AdminClaimsPage() {
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<AdminPaymentClaim | null>(null);
  const confirmKeysRef = useRef(new Map<string, string>());

  const load = useCallback((signal?: AbortSignal) => {
    return apiFetch<{ claims: AdminPaymentClaim[] }>(
      "/admin/payment-claims",
      signal ? { signal } : {},
    )
      .then((data) => {
        if (!signal?.aborted) setState({ kind: "ready", claims: data.claims });
      })
      .catch(() => {
        if (!signal?.aborted) setState({ kind: "error" });
      });
  }, []);

  useEffect(() => {
    if (!moneyOn) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [moneyOn, load]);

  if (!moneyOn) {
    return <EmptyState title="Money">Money is not switched on yet.</EmptyState>;
  }
  if (state.kind === "loading") return <Skeleton label="Loading payment claims" />;
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load payment claims"
        onRetry={() => {
          setState({ kind: "loading" });
          void load();
        }}
      >
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  async function confirmClaim(claim: AdminPaymentClaim) {
    const key = confirmKeysRef.current.get(claim.id) ?? newIdempotencyKey();
    confirmKeysRef.current.set(claim.id, key);
    setBusyId(claim.id);
    try {
      await apiFetch(`/admin/payment-claims/${encodeURIComponent(claim.id)}/confirm`, {
        method: "POST",
        body: {},
        idempotencyKey: key,
      });
      confirmKeysRef.current.delete(claim.id);
      toast.show(`Payment confirmed (${String(claim.amountSek)} kr)`, "success");
      await load();
    } catch (error) {
      const { message, reload } = describeAdminClaimError(error);
      toast.show(message, "danger");
      if (isFinalRefusal(error)) {
        confirmKeysRef.current.delete(claim.id);
      }
      if (reload) await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="bcq-page" aria-labelledby="admin-claims-title">
      <h1 id="admin-claims-title" className="bcq-page__title">
        Payment claims
      </h1>
      {state.claims.length === 0 ? (
        <EmptyState title="No pending claims">New member claims appear here for review.</EmptyState>
      ) : (
        <ul className="bcq-members" aria-label="Pending payment claims">
          {state.claims.map((claim) => (
            <li key={claim.id} className="bcq-member">
              <div className="bcq-member__head">
                <span className="bcq-member__name">{claim.displayName}</span>
                <span className="bcq-money-amount">{claim.amountSek} kr</span>
                <StatusChip tone={balanceTone(claim.balanceSek)}>
                  {describeBalance(claim.balanceSek)}
                </StatusChip>
                {claim.isOwn ? <StatusChip tone="info">Your claim</StatusChip> : null}
              </div>
              <p className="bcq-member__meta">
                Paid <time dateTime={claim.paidOn}>{formatDay(claim.paidOn)}</time> · Ref{" "}
                {claim.paymentRef}
                {claim.note ? ` · ${claim.note}` : ""}
              </p>
              {claim.isOwn ? (
                <p className="bcq-field__hint">
                  Another admin must confirm or reject your own claim.
                </p>
              ) : null}
              <div className="bcq-member__actions">
                <Button
                  aria-label={`Confirm ${claim.displayName} ${String(claim.amountSek)} kr`}
                  disabled={claim.isOwn || busyId === claim.id}
                  onClick={() => void confirmClaim(claim)}
                >
                  Confirm
                </Button>
                <Button
                  variant="secondary"
                  aria-label={`Reject ${claim.displayName} ${String(claim.amountSek)} kr`}
                  disabled={claim.isOwn || busyId === claim.id}
                  onClick={() => {
                    setRejecting(claim);
                  }}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rejecting ? (
        <RejectClaimSheet
          claim={rejecting}
          onClose={() => {
            setRejecting(null);
          }}
          onRejected={async () => {
            setRejecting(null);
            toast.show("Claim rejected", "success");
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

function RejectClaimSheet({
  claim,
  onClose,
  onRejected,
}: {
  readonly claim: AdminPaymentClaim;
  readonly onClose: () => void;
  readonly onRejected: () => Promise<void>;
}) {
  const [key, setKey] = useState(newIdempotencyKey);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed === "") {
      setError("A reason is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/payment-claims/${encodeURIComponent(claim.id)}/reject`, {
        method: "POST",
        body: { reason: trimmed },
        idempotencyKey: key,
      });
      await onRejected();
    } catch (failure) {
      const { message } = describeAdminClaimError(failure);
      setError(message);
      if (isFinalRefusal(failure)) setKey(newIdempotencyKey());
      setBusy(false);
    }
  }

  return (
    <BottomSheet open title={`Reject ${claim.displayName}'s claim`} onClose={onClose}>
      <p className="bcq-member__meta">
        {claim.amountSek} kr · paid {formatDay(claim.paidOn)}
      </p>
      <form className="bcq-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="claim-reject-reason">
            Reason
          </label>
          <textarea
            id="claim-reject-reason"
            className="bcq-input bcq-textarea"
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </div>
        {error ? (
          <p className="bcq-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="danger" disabled={busy}>
          Reject claim
        </Button>
      </form>
    </BottomSheet>
  );
}
