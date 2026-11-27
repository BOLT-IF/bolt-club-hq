import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { apiFetch, newIdempotencyKey } from "../../../api/client";
import { BottomSheet, Button, EmptyState, Skeleton, StatusChip } from "../../../components/ui";
import { describeError, isFinalRefusal, type AdminPassOffer, type MemberStatus } from "./moneyApi";

export interface AssignPassMemberOption {
  readonly id: string;
  readonly displayName: string;
  readonly paymentRef?: string;
  readonly status?: MemberStatus;
}

export interface AssignPassSheetProps {
  /** Pre-selected member when opened from a member's ledger. */
  readonly member?: { readonly id: string; readonly displayName: string };
  /** Member list when opened from Balances; filtered to active members. */
  readonly members?: readonly AssignPassMemberOption[];
  readonly onClose: () => void;
  readonly onAssigned: (member: { id: string; displayName: string }) => Promise<void> | void;
}

type OffersState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly offers: readonly AdminPassOffer[] };

function isOfferSelectable(offer: AdminPassOffer): boolean {
  return !offer.alreadyOwned && offer.seatsRemaining > 0;
}

function formatPrice(offer: AdminPassOffer): string {
  const base = `${String(offer.priceSek)} kr`;
  return offer.discounted ? `${base} (returning rate)` : base;
}

/**
 * Admin pass grant sheet shared between AdminBalances and AdminMemberLedger.
 * Charges the full or returning-member series price to the member's balance;
 * never overrides the price directly (admins adjust or record payment on the ledger).
 */
export function AssignPassSheet({ member, members, onClose, onAssigned }: AssignPassSheetProps) {
  const activeMembers = useMemo(
    () => (members ?? []).filter((m) => (m.status ?? "active") === "active"),
    [members],
  );
  const [selectedMemberId, setSelectedMemberId] = useState(member?.id ?? "");
  const [selectedSeriesId, setSelectedSeriesId] = useState("");
  const [offersState, setOffersState] = useState<OffersState>(
    member ? { kind: "loading" } : { kind: "idle" },
  );
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const selectedMemberName = useMemo(() => {
    if (member) return member.displayName;
    return activeMembers.find((m) => m.id === selectedMemberId)?.displayName ?? "";
  }, [member, activeMembers, selectedMemberId]);

  useEffect(() => {
    if (!selectedMemberId) return;
    let cancelled = false;
    const controller = new AbortController();
    apiFetch<{ offers: AdminPassOffer[] }>(
      `/admin/passes/offers?memberId=${encodeURIComponent(selectedMemberId)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (cancelled) return;
        const firstAvailable = data.offers.find(isOfferSelectable);
        setSelectedSeriesId(firstAvailable?.seriesId ?? "");
        setOffersState({ kind: "ready", offers: data.offers });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || cancelled) return;
        setSelectedSeriesId("");
        setOffersState({ kind: "error", message: describeError(failure) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedMemberId, reloadNonce]);

  const offers = offersState.kind === "ready" ? offersState.offers : [];
  const selectedOffer =
    offers.find((o) => o.seriesId === selectedSeriesId && isOfferSelectable(o)) ?? null;
  const anySelectable = offers.some(isOfferSelectable);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!selectedMemberId) {
      setSubmitError("Choose a member first.");
      return;
    }
    if (!selectedOffer) {
      setSubmitError("Choose an available series.");
      return;
    }
    setSubmitError(null);
    setBusy(true);
    try {
      await apiFetch("/admin/passes", {
        method: "POST",
        body: { memberId: selectedMemberId, seriesId: selectedOffer.seriesId },
        idempotencyKey: key,
      });
      await onAssigned({ id: selectedMemberId, displayName: selectedMemberName });
    } catch (failure) {
      setSubmitError(describeError(failure));
      if (isFinalRefusal(failure)) setKey(newIdempotencyKey());
      setBusy(false);
    }
  }

  const title = member ? `Assign pass to ${member.displayName}` : "Assign pass";

  return (
    <BottomSheet open title={title} onClose={onClose}>
      <form className="bcq-form" noValidate onSubmit={(e) => void submit(e)}>
        {!member ? (
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="assign-pass-member">
              Member
            </label>
            {activeMembers.length === 0 ? (
              <p className="bcq-field__hint">No active members available.</p>
            ) : (
              <select
                id="assign-pass-member"
                className="bcq-input"
                value={selectedMemberId}
                disabled={busy}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setSelectedMemberId(nextId);
                  setSelectedSeriesId("");
                  setOffersState(nextId ? { kind: "loading" } : { kind: "idle" });
                  setSubmitError(null);
                  setKey(newIdempotencyKey());
                }}
              >
                <option value="">Select a member…</option>
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.paymentRef ? `${m.displayName} (${m.paymentRef})` : m.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}

        {selectedMemberId ? (
          offersState.kind === "loading" ? (
            <Skeleton label="Loading pass offers" />
          ) : offersState.kind === "error" ? (
            <div className="bcq-field">
              <p className="bcq-field__error" role="alert">
                {offersState.message}
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOffersState({ kind: "loading" });
                  setReloadNonce((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : offers.length === 0 ? (
            <EmptyState title="No passes available">
              No series are currently open for pass assignment.
            </EmptyState>
          ) : (
            <fieldset className="bcq-pass-options">
              <legend className="bcq-field__label">Series</legend>
              {offers.map((offer) => {
                const selectable = isOfferSelectable(offer);
                const selected = selectedSeriesId === offer.seriesId && selectable;
                const statusLabel = offer.alreadyOwned
                  ? "Already holds pass"
                  : offer.seatsRemaining <= 0
                    ? "Sold out"
                    : null;
                const rowClass = [
                  "bcq-pass-option",
                  selected ? "bcq-pass-option--selected" : "",
                  !selectable ? "bcq-pass-option--disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <label key={offer.seriesId} className={rowClass}>
                    <input
                      type="radio"
                      name="assign-pass-series"
                      value={offer.seriesId}
                      checked={selected}
                      disabled={!selectable || busy}
                      onChange={() => {
                        setSelectedSeriesId(offer.seriesId);
                        setSubmitError(null);
                      }}
                    />
                    <span className="bcq-pass-option__body">
                      <span className="bcq-pass-option__head">
                        <span className="bcq-pass-option__title">
                          {offer.seriesName} · {offer.termName}
                        </span>
                        <span className="bcq-pass-option__price">{formatPrice(offer)}</span>
                      </span>
                      <span className="bcq-pass-option__meta">
                        {offer.remainingEvents} of {offer.totalEvents} sessions ·{" "}
                        {offer.seatsRemaining} of {offer.passCap} seats left
                      </span>
                      {statusLabel ? (
                        <span>
                          <StatusChip tone={offer.alreadyOwned ? "success" : "neutral"}>
                            {statusLabel}
                          </StatusChip>
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
              {!anySelectable ? (
                <p className="bcq-field__hint">
                  No open series are currently eligible for this member.
                </p>
              ) : null}
            </fieldset>
          )
        ) : null}

        {selectedOffer ? (
          <p className="bcq-field__hint">
            {selectedOffer.priceSek} kr will be charged to {selectedMemberName || "the member"}
            &apos;s balance.
          </p>
        ) : null}

        {submitError ? (
          <p className="bcq-field__error" role="alert">
            {submitError}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={busy || !selectedMemberId || offersState.kind !== "ready" || !selectedOffer}
        >
          {busy
            ? "Assigning..."
            : selectedOffer
              ? `Assign Pass (${String(selectedOffer.priceSek)} kr)`
              : "Assign Pass"}
        </Button>
      </form>
    </BottomSheet>
  );
}
