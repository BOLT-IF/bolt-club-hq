import { useId, type ReactNode } from "react";

import { cx } from "../../lib/cx";

function DefaultEmptyIcon() {
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
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/** Compact single-row left-aligned empty state with 36x36px tinted icon (PWA_UI_Rules.md §5). */
export function EmptyState({
  title,
  children,
  action,
  icon,
  tone = "neutral",
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
  readonly tone?: "neutral" | "success";
}) {
  const titleId = useId();
  return (
    <section className="bcq-state bcq-state--empty" aria-labelledby={titleId}>
      <span
        className={cx("bcq-state__icon", tone === "neutral" && "bcq-state__icon--neutral")}
        aria-hidden="true"
      >
        {icon ?? <DefaultEmptyIcon />}
      </span>
      <div className="bcq-state__content">
        <h2 id={titleId} className="bcq-state__title">
          {title}
        </h2>
        {children ? <p className="bcq-state__body">{children}</p> : null}
        {action ? <div className="bcq-state__action">{action}</div> : null}
      </div>
    </section>
  );
}

export const CompactEmptyState = EmptyState;

export function ErrorState({
  title = "Something Went Wrong",
  children,
  onRetry,
}: {
  readonly title?: string;
  readonly children?: ReactNode;
  readonly onRetry?: () => void;
}) {
  return (
    <section className="bcq-state bcq-state--error" role="alert">
      <h2 className="bcq-state__title">{title}</h2>
      {children ? <p className="bcq-state__body">{children}</p> : null}
      {onRetry ? (
        <button type="button" className="bcq-btn bcq-btn--tonal" onClick={onRetry}>
          Try Again
        </button>
      ) : null}
    </section>
  );
}

export function Skeleton({
  lines = 3,
  label = "Loading",
}: {
  readonly lines?: number;
  readonly label?: string;
}) {
  return (
    <div className="bcq-skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="bcq-skeleton__line" aria-hidden="true" />
      ))}
      <span className="bcq-visually-hidden">{label}</span>
    </div>
  );
}
