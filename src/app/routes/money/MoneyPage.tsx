import "./money.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";

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
  ChevronRightIcon,
  CompactEmptyState,
  CopyButton,
  ErrorState,
  Skeleton,
  StatusChip,
  type StatusTone,
} from "../../components/ui";
import { cx } from "../../lib/cx";
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
  pass: "Season Pass",
  adhoc: "Event Fee",
  guest: "Guest Fee",
  club_fee: "Club Fee",
  manual: "Charge",
  payment: "Payment",
  waiver: "Waiver",
  revocation: "Pass Revoked",
  opening_balance: "Opening Balance",
};

const DEFAULT_PAY_INSTRUCTION =
  "Include your payment reference in the transfer message so we can match it to you.";

function CheckCircleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function ReceiptIcon({ size = 18 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 17.5v-11" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg
      width="18"
      height="18"
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

function LandmarkIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="22" x2="21" y2="22" />
      <line x1="6" y1="18" x2="6" y2="11" />
      <line x1="10" y1="18" x2="10" y2="11" />
      <line x1="14" y1="18" x2="14" y2="11" />
      <line x1="18" y1="18" x2="18" y2="11" />
      <polygon points="12 2 20 7 4 7" />
    </svg>
  );
}

function ChevronDownIcon({ rotated }: { readonly rotated: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx("bcq-pay-card__chevron", rotated && "is-open")}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="bcq-pay-callout__icon"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

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

function BalanceCard({ ledger }: { readonly ledger: MyLedger }) {
  const isOwed = ledger.owedSek > 0;
  const isCredit = !isOwed && ledger.creditSek > 0;

  const figure = isOwed ? kr(ledger.owedSek) : isCredit ? kr(ledger.creditSek) : "0 kr";
  const subtitle = isCredit ? "Available Credit" : "Current Balance";
  const pillLabel = isOwed ? "Balance Due" : isCredit ? "Credit" : "All Paid";
  const pillTone: StatusTone = isOwed ? "warning" : "success";

  return (
    <section aria-labelledby="money-balance" className="bcq-money-balance">
      <h2 id="money-balance" className="bcq-visually-hidden">
        Balance
      </h2>
      <div className="bcq-money-balance__top">
        <div className="bcq-money-balance__left">
          <span
            className={cx(
              "bcq-money-balance__icon",
              isOwed ? "bcq-money-balance__icon--amber" : "bcq-money-balance__icon--emerald",
            )}
            aria-hidden="true"
          >
            {isOwed ? <WalletIcon /> : <CheckCircleIcon />}
          </span>
          <div className="bcq-money-balance__copy">
            <p className="bcq-money-balance__figure">{figure}</p>
            <p className="bcq-money-balance__sub">{subtitle}</p>
          </div>
        </div>
        <StatusChip tone={pillTone}>{pillLabel}</StatusChip>
      </div>
      {isCredit ? (
        <p className="bcq-money-balance__credit-note">
          Your credit is automatically applied to your next charges.
        </p>
      ) : null}
    </section>
  );
}

function AppLink({
  href,
  className,
  children,
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      className={className}
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
            <AppLink href={eventHref} className="bcq-chevron-link bcq-money__event-link">
              <span>{item.eventTitle ?? "View Event"}</span>
              <ChevronRightIcon />
            </AppLink>
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

function PayDetailRow({
  label,
  value,
  copyable = false,
  copyAriaLabel,
  copyToast,
}: {
  readonly label: string;
  readonly value: string;
  readonly copyable?: boolean;
  readonly copyAriaLabel?: string;
  readonly copyToast?: string;
}) {
  return (
    <li className="bcq-pay-row">
      <div className="bcq-pay-row__text">
        <span className="bcq-pay-row__label">{label}</span>
        <span className={cx("bcq-pay-row__value", copyable && "bcq-pay-row__value--mono")}>
          {value}
        </span>
      </div>
      {copyable ? (
        <CopyButton
          value={value}
          label="Copy"
          copiedLabel="Copied"
          ariaLabel={copyAriaLabel ?? `Copy ${label.toLowerCase()}`}
          toastMessage={copyToast ?? `${label} copied`}
          className="bcq-pay-row__copy"
        />
      ) : null}
    </li>
  );
}

type PayInfo = { settings: PaymentSettings | null; paymentRef: string | null };

function HowToPay({
  info,
  defaultExpanded,
}: {
  readonly info: PayInfo | null;
  readonly defaultExpanded: boolean;
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;

  const bank = info?.settings?.bank ?? null;
  const hasBank = Boolean(bank && (bank.accountNumber || bank.bankgiro || bank.iban));
  const ref = info?.paymentRef ?? null;
  const customNote = info?.settings?.paymentInstructions?.trim() || null;
  const calloutNote = customNote ?? (ref || hasBank ? DEFAULT_PAY_INSTRUCTION : null);

  return (
    <section aria-labelledby="money-how" className="bcq-pay-card">
      <h2 id="money-how" className="bcq-pay-card__heading">
        <button
          type="button"
          className="bcq-pay-card__trigger"
          aria-expanded={expanded}
          aria-controls="money-how-panel"
          onClick={() => {
            setUserExpanded(!expanded);
          }}
        >
          <span className="bcq-pay-card__trigger-left">
            <span className="bcq-pay-card__icon" aria-hidden="true">
              <LandmarkIcon />
            </span>
            <span className="bcq-pay-card__title">How to Pay</span>
          </span>
          <ChevronDownIcon rotated={expanded} />
        </button>
      </h2>

      {expanded ? (
        <div id="money-how-panel" className="bcq-pay-card__panel">
          {info === null ? <Skeleton lines={2} label="Loading payment details" /> : null}
          {info !== null ? (
            <>
              {hasBank && bank ? (
                <ul className="bcq-pay-rows">
                  {bank.accountHolder ? (
                    <PayDetailRow label="Recipient" value={bank.accountHolder} />
                  ) : null}
                  {bank.bankName ? <PayDetailRow label="Bank" value={bank.bankName} /> : null}
                  {bank.accountNumber ? (
                    <PayDetailRow
                      label="Account Number"
                      value={bank.accountNumber}
                      copyable
                      copyAriaLabel="Copy account number"
                      copyToast="Account number copied"
                    />
                  ) : null}
                  {bank.bankgiro ? (
                    <PayDetailRow
                      label="Bankgiro"
                      value={bank.bankgiro}
                      copyable
                      copyAriaLabel="Copy bankgiro"
                      copyToast="Bankgiro copied"
                    />
                  ) : null}
                  {bank.iban ? (
                    <PayDetailRow
                      label="IBAN"
                      value={bank.iban}
                      copyable
                      copyAriaLabel="Copy IBAN"
                      copyToast="IBAN copied"
                    />
                  ) : null}
                  {ref ? (
                    <PayDetailRow
                      label="Payment Reference"
                      value={ref}
                      copyable
                      copyAriaLabel="Copy payment reference"
                      copyToast="Payment reference copied"
                    />
                  ) : null}
                </ul>
              ) : (
                <p className="bcq-pay-card__fallback">
                  Ask the treasurer for the club&apos;s bank details.
                </p>
              )}

              {calloutNote ? (
                <div className="bcq-pay-callout">
                  <InfoIcon />
                  <p className="bcq-pay-callout__text">{calloutNote}</p>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Member Money screen (PLAN §9): balance, quick links, how to pay, and activity ledger. */
export function MoneyPage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; forbidden: boolean }
    | { status: "ready"; ledger: MyLedger }
  >({ status: "loading" });
  const [payInfo, setPayInfo] = useState<PayInfo | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    void Promise.allSettled([
      fetchMyLedger(signal),
      fetchPaymentSettings(signal),
      fetchMyPaymentRef(signal),
    ]).then(([ledgerRes, settingsRes, refRes]) => {
      if (signal?.aborted) return;
      setPayInfo({
        settings: settingsRes.status === "fulfilled" ? settingsRes.value : null,
        paymentRef: refRes.status === "fulfilled" ? refRes.value : null,
      });
      if (ledgerRes.status === "fulfilled") {
        setState({ status: "ready", ledger: ledgerRes.value });
      } else {
        const error: unknown = ledgerRes.reason;
        setState({ status: "error", forbidden: error instanceof ApiError && error.status === 403 });
      }
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const owesBalance = state.status === "ready" && state.ledger.owedSek > 0;

  return (
    <section aria-labelledby="money-title" className="bcq-money">
      <h1 id="money-title" className="bcq-page__title">
        Money
      </h1>

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
      {state.status === "ready" ? <BalanceCard ledger={state.ledger} /> : null}

      {state.status !== "loading" ? (
        <>
          <nav aria-label="Money actions" className="bcq-money-nav">
            <AppLink href="/money/claims" className="bcq-money-nav__card">
              <span className="bcq-money-nav__left">
                <span className="bcq-money-nav__icon" aria-hidden="true">
                  <ReceiptIcon size={17} />
                </span>
                <span className="bcq-money-nav__label">Payment Claims</span>
              </span>
              <span className="bcq-money-nav__chevron" aria-hidden="true">
                <ChevronRightIcon />
              </span>
            </AppLink>
            <AppLink href="/money/passes" className="bcq-money-nav__card">
              <span className="bcq-money-nav__left">
                <span className="bcq-money-nav__icon" aria-hidden="true">
                  <TicketIcon />
                </span>
                <span className="bcq-money-nav__label">Passes</span>
              </span>
              <span className="bcq-money-nav__chevron" aria-hidden="true">
                <ChevronRightIcon />
              </span>
            </AppLink>
          </nav>

          <HowToPay info={payInfo} defaultExpanded={owesBalance} />
        </>
      ) : null}

      {state.status === "ready" ? (
        <section aria-labelledby="money-activity" className="bcq-money-activity">
          <h2 id="money-activity" className="bcq-section-subheader">
            Activity
          </h2>
          {state.ledger.items.length === 0 ? (
            <CompactEmptyState title="No Activity Yet" icon={<ReceiptIcon size={18} />}>
              Fees appear here after an event closes
            </CompactEmptyState>
          ) : (
            <ul className="bcq-money__list" aria-label="Ledger entries">
              {[...state.ledger.items].reverse().map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </section>
  );
}
