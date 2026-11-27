import type { MouseEvent, ReactNode } from "react";

import { cx } from "../../lib/cx";
import { navigate } from "../../lib/navigate";

export function ChevronRightIcon() {
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
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function GroupedListSection({
  title,
  children,
  className,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx("bcq-grouped-section", className)}>
      {title ? <h2 className="bcq-section-subheader">{title}</h2> : null}
      <ul className="bcq-grouped-card">{children}</ul>
    </div>
  );
}

export type GroupedIconTone = "neutral" | "amber" | "emerald" | "danger";

interface GroupedListRowBase {
  readonly icon?: ReactNode;
  readonly iconTone?: GroupedIconTone;
  readonly label: string;
  readonly subtitle?: string;
  readonly trailing?: ReactNode;
  readonly chevron?: boolean;
  readonly danger?: boolean;
  readonly className?: string;
}

export type GroupedListRowProps =
  | (GroupedListRowBase & {
      readonly href: string;
      readonly onClick?: () => void;
    })
  | (GroupedListRowBase & {
      readonly href?: undefined;
      readonly onClick: () => void;
    })
  | (GroupedListRowBase & {
      readonly href?: undefined;
      readonly onClick?: undefined;
      readonly asLabel?: boolean;
    });

function RowInner({
  icon,
  iconTone = "neutral",
  label,
  subtitle,
  trailing,
  chevron,
  danger,
}: GroupedListRowBase) {
  return (
    <>
      {icon ? (
        <span
          className={cx(
            "bcq-grouped-row__icon",
            iconTone !== "neutral" && `bcq-grouped-row__icon--${iconTone}`,
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="bcq-grouped-row__content">
        <span className={cx("bcq-grouped-row__label", danger && "bcq-grouped-row__label--danger")}>
          {label}
        </span>
        {subtitle ? <span className="bcq-grouped-row__subtitle">{subtitle}</span> : null}
      </span>
      {trailing || chevron ? (
        <span className="bcq-grouped-row__trailing">
          {trailing}
          {chevron ? (
            <span className="bcq-grouped-row__chevron">
              <ChevronRightIcon />
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

function GroupedListRow(props: GroupedListRowProps) {
  if (props.href !== undefined) {
    const href = props.href;
    const handleNav = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      props.onClick?.();
      navigate(href);
    };
    return (
      <li className="bcq-grouped-item">
        <a href={href} className={cx("bcq-grouped-row", props.className)} onClick={handleNav}>
          <RowInner {...props} chevron={props.chevron ?? true} />
        </a>
      </li>
    );
  }

  if (props.onClick !== undefined) {
    return (
      <li className="bcq-grouped-item">
        <button
          type="button"
          className={cx("bcq-grouped-row", props.className)}
          onClick={props.onClick}
        >
          <RowInner {...props} />
        </button>
      </li>
    );
  }

  if (props.asLabel) {
    return (
      <li className="bcq-grouped-item">
        <label className={cx("bcq-grouped-row", props.className)}>
          <RowInner {...props} />
        </label>
      </li>
    );
  }

  return (
    <li className="bcq-grouped-item">
      <div className={cx("bcq-grouped-row", props.className)}>
        <RowInner {...props} />
      </div>
    </li>
  );
}

export const GroupedList = {
  Section: GroupedListSection,
  Row: GroupedListRow,
};
