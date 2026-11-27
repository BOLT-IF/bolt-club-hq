import "../../members/members.css";
import "../money.css";
import "./claims.css";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  Button,
  DisclosureSection,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { navigate } from "../../../lib/navigate";

export interface PaymentClaim {
  readonly id: string;
  readonly memberId: string;
  readonly amountSek: number;
  readonly paidOn: string;
  readonly note: string | null;
  readonly status: "pending" | "confirmed" | "rejected";
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
}

const stockholmTodayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });
const claimDayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function todayStockholm(): string {
  return stockholmTodayFmt.format(new Date());
}

function parseKronor(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

function isValidCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatDay(day: string): string {
  if (!isValidCalendarDay(day)) return day;
  return claimDayFmt.format(new Date(`${day}T00:00:00Z`));
}

function isFinalRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return false;
  return (error.body as { error?: unknown } | null)?.error !== "idempotency_key_in_progress";
}

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  invalid_amount: "Enter whole kronor above 0.",
  invalid_paid_on: "Enter a valid date that isn't in the future.",
  invalid_note: "Note must be 500 characters or fewer.",
  idempotency_key_in_progress: "Still saving your first attempt. Try again in a moment.",
  idempotency_conflict: "This was already submitted with different details. Reload the page.",
};

function describeClaimSubmitError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && CLAIM_ERROR_MESSAGES[code]) {
      return CLAIM_ERROR_MESSAGES[code];
    }
    if (error.status === 403) return "Your account can't submit a payment claim right now.";
  }
  return "Couldn't submit your claim. Check your connection and try again.";
}

function claimStatus(status: PaymentClaim["status"]): { tone: StatusTone; text: string } {
  switch (status) {
    case "pending":
      return { tone: "warning", text: "Pending" };
    case "confirmed":
      return { tone: "success", text: "Confirmed" };
    case "rejected":
      return { tone: "danger", text: "Rejected" };
  }
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly forbidden: boolean }
  | { readonly status: "ready"; readonly claims: readonly PaymentClaim[] };

/** Member Payment Claims screen (S5.5, PLAN §9): report a payment and view claim statuses. */
export function MemberClaimsPage() {
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const today = todayStockholm();
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One Idempotency-Key per submission attempt; reused on timeouts / 409 in-progress, rotated on final 4xx or success.
  const keyRef = useRef(newIdempotencyKey());

  const load = useCallback((signal?: AbortSignal) => {
    return apiFetch<{ claims: PaymentClaim[] }>("/me/payment-claims", signal ? { signal } : {})
      .then((res) => {
        setState({ status: "ready", claims: res.claims });
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        setState({ status: "error", forbidden: error instanceof ApiError && error.status === 403 });
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

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    const amountSek = parseKronor(amount);
    if (amountSek === null) {
      setFormError("Enter whole kronor above 0.");
      return;
    }
    const maxDay = todayStockholm();
    if (!isValidCalendarDay(paidOn) || paidOn > maxDay) {
      setFormError("Enter a valid date that isn't in the future.");
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > 500) {
      setFormError("Note must be 500 characters or fewer.");
      return;
    }

    setFormError(null);
    setSubmitting(true);
    try {
      await apiFetch<PaymentClaim>("/me/payment-claims", {
        method: "POST",
        body: {
          amountSek,
          paidOn,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        },
        idempotencyKey: keyRef.current,
      });
      keyRef.current = newIdempotencyKey();
      setAmount("");
      setPaidOn(todayStockholm());
      setNote("");
      toast.show("Payment claim submitted", "success");
      await load();
    } catch (error) {
      setFormError(describeClaimSubmitError(error));
      if (isFinalRefusal(error)) {
        keyRef.current = newIdempotencyKey();
      }
    } finally {
      setSubmitting(false);
    }
  }

  const pendingClaims =
    state.status === "ready" ? state.claims.filter((c) => c.status === "pending") : [];
  const pastClaims =
    state.status === "ready" ? state.claims.filter((c) => c.status !== "pending") : [];

  const renderClaim = (claim: PaymentClaim) => {
    const chip = claimStatus(claim.status);
    return (
      <li key={claim.id} className="bcq-money__item">
        <div className="bcq-money__row">
          <strong className="bcq-money__sum">{claim.amountSek} kr</strong>
          <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
        </div>
        <p className="bcq-money__when">
          Paid <time dateTime={claim.paidOn}>{formatDay(claim.paidOn)}</time>
        </p>
        {claim.note ? <p className="bcq-claims__note">{claim.note}</p> : null}
        {claim.status === "rejected" && claim.rejectReason ? (
          <p className="bcq-claims__reason">Reason: {claim.rejectReason}</p>
        ) : null}
      </li>
    );
  };

  return (
    <section aria-labelledby="claims-title" className="bcq-money">
      <h1 id="claims-title" className="bcq-page__title">
        Payment Claims
      </h1>
      <div>
        <a
          className="bcq-btn bcq-btn--tonal"
          href="/money"
          onClick={(e) => {
            e.preventDefault();
            navigate("/money");
          }}
        >
          Balance &amp; Bank Details
        </a>
      </div>

      <section aria-labelledby="claim-form-title" className="bcq-money__card">
        <h2 id="claim-form-title" className="bcq-money__heading">
          I&apos;ve Paid
        </h2>
        <p className="bcq-field__hint" style={{ marginBottom: "1rem" }}>
          Let the club know after you transfer money. Your balance updates once an admin confirms
          it.
        </p>
        <form className="bcq-form" noValidate onSubmit={(e) => void onSubmit(e)}>
          <div className="bcq-form-grid-2">
            <div className="bcq-field">
              <label className="bcq-field__label" htmlFor="claim-amount">
                Amount (kr)
              </label>
              <input
                id="claim-amount"
                className="bcq-input"
                inputMode="numeric"
                autoComplete="off"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            </div>
            <div className="bcq-field">
              <label className="bcq-field__label" htmlFor="claim-paid-on">
                Date Paid
              </label>
              <input
                id="claim-paid-on"
                className="bcq-input"
                type="date"
                max={today}
                value={paidOn}
                onChange={(e) => {
                  setPaidOn(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="claim-note">
              Note (Optional)
            </label>
            <textarea
              id="claim-note"
              className="bcq-input bcq-textarea"
              maxLength={500}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </div>
          {formError ? (
            <p className="bcq-field__error" role="alert">
              {formError}
            </p>
          ) : null}
          <Button type="submit" block disabled={submitting}>
            {submitting ? "Submitting…" : "Submit Claim"}
          </Button>
        </form>
      </section>

      <section aria-labelledby="my-claims-heading">
        <h2 id="my-claims-heading" className="bcq-money__heading">
          Your Claims
        </h2>
        {state.status === "loading" ? <Skeleton label="Loading payment claims" /> : null}
        {state.status === "error" ? (
          <ErrorState
            title="Couldn't Load Payment Claims"
            onRetry={() => {
              setState({ status: "loading" });
              void load();
            }}
          >
            {state.forbidden
              ? "Your account can't open payment claims right now."
              : "Check your connection and try again."}
          </ErrorState>
        ) : null}
        {state.status === "ready" ? (
          state.claims.length === 0 ? (
            <EmptyState title="No Payment Claims Yet">
              Claims you submit appear here while an admin reviews them.
            </EmptyState>
          ) : (
            <div className="bcq-money">
              {pendingClaims.length > 0 ? (
                <ul className="bcq-money__list" aria-label="Pending payment claims">
                  {pendingClaims.map(renderClaim)}
                </ul>
              ) : null}
              {pastClaims.length > 0 ? (
                <DisclosureSection label={`Past Claims (${String(pastClaims.length)})`}>
                  <ul className="bcq-money__list" aria-label="Past payment claims">
                    {pastClaims.map(renderClaim)}
                  </ul>
                </DisclosureSection>
              ) : null}
            </div>
          )
        ) : null}
      </section>
    </section>
  );
}
