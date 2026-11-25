import "./passes.css";
import { useCallback, useEffect, useState } from "react";

import { newIdempotencyKey } from "../../../api/client";
import {
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  SpotsBar,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import {
  describePassError,
  fetchPassOffers,
  isFinalPassRefusal,
  purchasePass,
  type MemberPass,
  type PassOffer,
  type PassesOverview,
} from "./passesApi";

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Stockholm",
});

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: PassesOverview };

function OfferCard({
  offer,
  onSelect,
}: {
  readonly offer: PassOffer;
  readonly onSelect: (offer: PassOffer) => void;
}) {
  const day = WEEKDAYS[offer.weekday] ?? "";
  const schedule = [day ? `${day} ${offer.startTime}` : offer.startTime, offer.location]
    .filter(Boolean)
    .join(" · ");
  const prorated = offer.priceSek < offer.passPrice;

  return (
    <li className="bcq-pass-card">
      <div className="bcq-pass-card__head">
        <h3 className="bcq-pass-card__title">{offer.seriesName}</h3>
        <StatusChip tone="neutral">{offer.format}</StatusChip>
      </div>
      <p className="bcq-pass-card__meta">
        {offer.termName} · {schedule}
      </p>
      <div className="bcq-pass-card__price-row">
        <span className="bcq-pass-card__price">{offer.priceSek} kr</span>
        <span className="bcq-pass-card__proration">
          {prorated
            ? `Prorated from ${String(offer.passPrice)} kr (${String(offer.remainingEvents)} of ${String(offer.totalEvents)} sessions left)`
            : `${String(offer.remainingEvents)} sessions`}
        </span>
      </div>
      <SpotsBar taken={offer.passesSold} total={offer.passCap} label="Pass seats" />
      <p className="bcq-pass-terms">{offer.termsNotice}</p>
      <div>
        {offer.alreadyOwned ? (
          <StatusChip tone="success">You hold a pass</StatusChip>
        ) : offer.seatsRemaining <= 0 ? (
          <StatusChip tone="neutral">Sold out</StatusChip>
        ) : (
          <Button
            onClick={() => {
              onSelect(offer);
            }}
          >
            Buy pass
          </Button>
        )}
      </div>
    </li>
  );
}

function OwnedPassCard({ pass }: { readonly pass: MemberPass }) {
  return (
    <li className="bcq-pass-card">
      <div className="bcq-pass-card__head">
        <h3 className="bcq-pass-card__title">{pass.seriesName}</h3>
        <StatusChip tone={pass.status === "active" ? "success" : "danger"}>
          {pass.status === "active" ? "Active" : "Revoked"}
        </StatusChip>
      </div>
      <p className="bcq-pass-card__meta">
        {pass.termName} · {pass.priceCharged} kr · Up to {pass.eventsCovered} sessions
      </p>
      <p className="bcq-pass-card__meta">
        Purchased {dateFmt.format(new Date(pass.purchasedAt))}
        {pass.revokedAt ? ` · Revoked ${dateFmt.format(new Date(pass.revokedAt))}` : ""}
      </p>
    </li>
  );
}

function BuyPassSheet({
  offer,
  onClose,
  onPurchased,
}: {
  readonly offer: PassOffer;
  readonly onClose: () => void;
  readonly onPurchased: (upgradedRsvps: number) => Promise<void>;
}) {
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      const res = await purchasePass(offer.seriesId, key);
      await onPurchased(res.upgradedRsvps);
    } catch (failure) {
      setError(describePassError(failure));
      if (isFinalPassRefusal(failure)) setKey(newIdempotencyKey());
      setBusy(false);
    }
  }

  return (
    <BottomSheet open title={`Buy ${offer.seriesName} pass`} onClose={onClose}>
      <div className="bcq-pass-sheet">
        <p className="bcq-pass-sheet__summary">
          <strong>{offer.priceSek} kr</strong> will be added to your club balance for{" "}
          {offer.termName} ({offer.remainingEvents} remaining sessions).
        </p>
        <p className="bcq-pass-terms">{offer.termsNotice}</p>
        {error ? (
          <p className="bcq-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bcq-confirm__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {busy ? "Buying…" : `Confirm purchase (${String(offer.priceSek)} kr)`}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** Member passes screen (PLAN §6.5, §12): prorated pass offers, terms notice, owned passes. */
export function PassesPage() {
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [buying, setBuying] = useState<PassOffer | null>(null);

  const load = useCallback((signal?: AbortSignal, isCancelled: () => boolean = () => false) => {
    return fetchPassOffers(signal)
      .then((data) => {
        if (!isCancelled()) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!signal?.aborted && !isCancelled()) setState({ kind: "error" });
      });
  }, []);

  useEffect(() => {
    if (!moneyOn) return;
    let cancelled = false;
    const controller = new AbortController();
    void load(controller.signal, () => cancelled);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [moneyOn, load]);

  if (!moneyOn) {
    return <EmptyState title="Money">Money is not switched on yet.</EmptyState>;
  }
  if (state.kind === "loading") return <Skeleton label="Loading passes" />;
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load passes"
        onRetry={() => {
          setState({ kind: "loading" });
          void load();
        }}
      >
        Check your connection and try again.
      </ErrorState>
    );
  }

  const { offers, passes } = state.data;

  return (
    <section className="bcq-passes" aria-labelledby="passes-title">
      <h1 id="passes-title" className="bcq-page__title">
        Passes
      </h1>

      <section className="bcq-passes__section" aria-labelledby="passes-offers-heading">
        <h2 id="passes-offers-heading" className="bcq-passes__heading">
          Available passes
        </h2>
        {offers.length === 0 ? (
          <EmptyState title="No passes on sale">
            No series are currently open for pass purchases.
          </EmptyState>
        ) : (
          <ul className="bcq-passes__list" aria-label="Available passes">
            {offers.map((offer) => (
              <OfferCard key={offer.seriesId} offer={offer} onSelect={setBuying} />
            ))}
          </ul>
        )}
      </section>

      {passes.length > 0 ? (
        <section className="bcq-passes__section" aria-labelledby="passes-owned-heading">
          <h2 id="passes-owned-heading" className="bcq-passes__heading">
            Your passes
          </h2>
          <ul className="bcq-passes__list" aria-label="Your passes">
            {passes.map((p) => (
              <OwnedPassCard key={p.id} pass={p} />
            ))}
          </ul>
        </section>
      ) : null}

      {buying ? (
        <BuyPassSheet
          offer={buying}
          onClose={() => {
            setBuying(null);
          }}
          onPurchased={async (upgradedRsvps) => {
            const extra =
              upgradedRsvps > 0
                ? ` ${String(upgradedRsvps)} open RSVP${upgradedRsvps === 1 ? "" : "s"} confirmed.`
                : "";
            toast.show(`Pass purchased.${extra}`, "success");
            setBuying(null);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}
