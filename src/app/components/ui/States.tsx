import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section className="bcq-state bcq-state--empty" aria-labelledby="bcq-empty-title">
      <h2 id="bcq-empty-title" className="bcq-state__title">
        {title}
      </h2>
      {children ? <p className="bcq-state__body">{children}</p> : null}
      {action}
    </section>
  );
}

export function ErrorState({
  title = "Something went wrong",
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
        <button type="button" className="bcq-btn bcq-btn--secondary" onClick={onRetry}>
          Try again
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
