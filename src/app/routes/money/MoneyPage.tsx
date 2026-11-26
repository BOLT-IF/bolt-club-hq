import "./money.css";
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../api/client";
import {
  fetchMyLedger,
  fetchMyPaymentRef,
  fetchPaymentSettings,
  type LedgerItem,
  type MyLedger,
  type PaymentSettings,
} from "../../api/ledger";
import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../components/ui";
import { navigate } from "../../lib/navigate";

const TZ = "Europe/Stockholm";
const eventDay = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: TZ,
});
const entryDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ });

/** Whole kronor; money in shows with a real minus sign. */
const kr = (sek: number): string => `${sek < 0 ? "−" : ""}${String(Math.abs(sek))} kr`;

const REASON_LABEL: Record<string, string> = {
  pass: "Season pass",
  adhoc: "Event fee",
  guest: "Guest fee",
  manual: "Charge",
  payment: "Payment",
  waiver: "Waiver",
  revocation: "Pass revoked",
  opening_balance: "Opening balance",
};

function itemTitle(item: LedgerItem): string {
  const label = REASON_LABEL[item.reason] ?? "Entry";
  return item.kind === "reversal" ? `Reversal: ${label.toLowerCase()}` : label;
}

function itemStatus(item: LedgerItem): { tone: StatusTone; text: string } {
  switch (item.status) {
    case "paid":
      return { tone: "success", text: "Paid" };
    case "partly_paid":
      return { tone: "warning", text: `Partly paid, ${kr(item.outstandingSek)} left` };
    case "unpaid":
      return { tone: "danger", text: "Unpaid" };
    case "applied":
      return { tone: "neutral", text: "Used" };
    case "partly_applied":
    case "unapplied":
      return { tone: "info", text: `${kr(item.outstandingSek)} credit left` };
    case "reversed":
      return { tone: "neutral", text: "Cancelled" };
    case "reversal":
      return { tone: "neutral", text: "Cancellation" };
  }
}

function Balance({ ledger }: { readonly ledger: MyLedger }) {
  const text =
    ledger.owedSek > 0
      ? `You owe ${kr(ledger.owedSek)}`
      : ledger.creditSek > 0
        ? `Credit ${kr(ledger.creditSek)}`
        : "You're all paid up";
  const tone = ledger.owedSek > 0 ? "owe" : ledger.creditSek > 0 ? "credit" : "even";
  return (
    <section
      aria-labelledby="money-balance"
      className={`bcq-money__balance bcq-money__balance--${tone}`}
    >
      <h2 id="money-balance" className="bcq-visually-hidden">
        Balance
      </h2>
      <p className="bcq-money__amount">{text}</p>
      {ledger.creditSek > 0 ? (
        <p className="bcq-money__hint">Your credit is used for your next charges.</p>
      ) : null}
    </section>
  );
}

function NavLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a
      className="bcq-money__link"
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

function Item({ item }: { readonly item: LedgerItem }) {
  const status = itemStatus(item);
  const eventHref =
    item.eventId !== null ? `/history?eventId=${encodeURIComponent(item.eventId)}` : null;
  return (
    <li className="bcq-money__item">
      <span className="bcq-money__row">
        <strong>{itemTitle(item)}</strong>
        <span className="bcq-money__sum">{kr(item.amountSek)}</span>
      </span>
      {eventHref || item.eventTitle || item.guestName || item.note ? (
        <span className="bcq-money__detail">
          {eventHref ? (
            <NavLink href={eventHref}>{item.eventTitle ?? "View event"}</NavLink>
          ) : item.eventTitle ? (
            <span>{item.eventTitle}</span>
          ) : null}
          {item.eventStartsAt ? (
            <time dateTime={item.eventStartsAt}>
              {eventDay.format(new Date(item.eventStartsAt))}
            </time>
          ) : null}
          {item.guestName ? <span>Guest: {item.guestName}</span> : null}
          {item.note ? <span>{item.note}</span> : null}
        </span>
      ) : null}
      <span className="bcq-money__row">
        <time className="bcq-money__when" dateTime={item.createdAt}>
          {entryDay.format(new Date(item.createdAt))}
        </time>
        <StatusChip tone={status.tone}>{status.text}</StatusChip>
      </span>
    </li>
  );
}

type PayInfo = { settings: PaymentSettings | null; paymentRef: string | null };

function HowToPay({ info }: { readonly info: PayInfo | null }) {
  const toast = useToast();
  const bank = info?.settings?.bank ?? null;
  const hasBank = Boolean(bank && (bank.accountNumber || bank.bankgiro || bank.iban));
  const ref = info?.paymentRef ?? null;

  const copy = (value: string) => {
    // `clipboard` is missing on insecure origins and some older browsers.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    (clipboard ? clipboard.writeText(value) : Promise.reject(new Error("no clipboard"))).then(
      () => {
        toast.show("Payment reference copied", "success");
      },
      () => {
        toast.show("Couldn't copy. Select the reference and copy it by hand.", "danger");
      },
    );
  };

  return (
    <section aria-labelledby="money-how" className="bcq-money__card">
      <h2 id="money-how" className="bcq-money__heading">
        How to pay
      </h2>
      {info === null ? <Skeleton lines={2} label="Loading payment details" /> : null}
      {info !== null ? (
        <>
          {hasBank && bank ? (
            <dl className="bcq-money__bank">
              {bank.accountHolder ? (
                <>
                  <dt>Recipient</dt>
                  <dd>{bank.accountHolder}</dd>
                </>
              ) : null}
              {bank.bankName ? (
                <>
                  <dt>Bank</dt>
                  <dd>{bank.bankName}</dd>
                </>
              ) : null}
              {bank.accountNumber ? (
                <>
                  <dt>Account number</dt>
                  <dd>{bank.accountNumber}</dd>
                </>
              ) : null}
              {bank.bankgiro ? (
                <>
                  <dt>Bankgiro</dt>
                  <dd>{bank.bankgiro}</dd>
                </>
              ) : null}
              {bank.iban ? (
                <>
                  <dt>IBAN</dt>
                  <dd>{bank.iban}</dd>
                </>
              ) : null}
              {ref ? (
                <>
                  <dt>Payment reference</dt>
                  <dd className="bcq-money__ref">
                    <strong>{ref}</strong>
                    <Button
                      variant="ghost"
                      aria-label="Copy payment reference"
                      onClick={() => {
                        copy(ref);
                      }}
                    >
                      Copy
                    </Button>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p>Ask the treasurer for the club&apos;s bank details.</p>
          )}
          {ref ? (
            <p className="bcq-money__hint">
              Always write your payment reference on the transfer so we can match it to you.
            </p>
          ) : null}
          {info.settings?.paymentInstructions ? (
            <p className="bcq-money__instructions">{info.settings.paymentInstructions}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Member Money screen (PLAN §9): balance, how to pay, and every entry with FIFO status. */
export function MoneyPage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; forbidden: boolean }
    | { status: "ready"; ledger: MyLedger }
  >({ status: "loading" });
  const [payInfo, setPayInfo] = useState<PayInfo | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    fetchMyLedger(signal)
      .then((ledger) => {
        setState({ status: "ready", ledger });
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        setState({ status: "error", forbidden: error instanceof ApiError && error.status === 403 });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    // Best effort: the ledger still shows if these fail (e.g. an exited member).
    void Promise.allSettled([
      fetchPaymentSettings(controller.signal),
      fetchMyPaymentRef(controller.signal),
    ]).then(([settings, ref]) => {
      if (controller.signal.aborted) return;
      setPayInfo({
        settings: settings.status === "fulfilled" ? settings.value : null,
        paymentRef: ref.status === "fulfilled" ? ref.value : null,
      });
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  return (
    <section aria-labelledby="money-title" className="bcq-money">
      <h1 id="money-title" className="bcq-page__title">
        Money
      </h1>
      <nav aria-label="Money actions" className="bcq-money__nav">
        <NavLink href="/money/claims">Payment claims</NavLink>
        <NavLink href="/money/passes">Passes</NavLink>
      </nav>
      {state.status === "loading" ? <Skeleton label="Loading your balance" /> : null}
      {state.status === "error" ? (
        <ErrorState
          title="Couldn't load your money"
          onRetry={() => {
            setState({ status: "loading" });
            load();
          }}
        >
          {state.forbidden
            ? "You can only see your own money, and your account can't open it right now."
            : "Check your connection and try again."}
        </ErrorState>
      ) : null}
      {state.status === "ready" ? <Balance ledger={state.ledger} /> : null}
      <HowToPay info={payInfo} />
      {state.status === "ready" ? (
        state.ledger.items.length === 0 ? (
          <EmptyState title="Nothing here yet">
            No charges or payments yet. Fees appear here after an event closes.
          </EmptyState>
        ) : (
          <section aria-labelledby="money-entries">
            <h2 id="money-entries" className="bcq-money__heading">
              Entries
            </h2>
            <ul className="bcq-money__list" aria-label="Ledger entries">
              {[...state.ledger.items].reverse().map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </ul>
          </section>
        )
      ) : null}
    </section>
  );
}
