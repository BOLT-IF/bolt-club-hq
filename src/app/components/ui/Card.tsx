import { useState, type ReactNode } from "react";

import { cx } from "../../lib/cx";
import { ChevronRightIcon } from "./GroupedList";

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={cx("bcq-card", className)}>{children}</div>;
}

export function FormRow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={cx("bcq-form-grid-2", className)}>{children}</div>;
}

/** Collapsed-by-default disclosure for Past / Inactive / Closed items (PWA_UI_Rules.md §4). */
export function DisclosureSection({
  label,
  defaultOpen = false,
  children,
}: {
  readonly label: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bcq-disclosure">
      <button
        type="button"
        className="bcq-disclosure__trigger"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span>{label}</span>
        <span
          className={cx("bcq-disclosure__chevron", open && "bcq-disclosure__chevron--open")}
          aria-hidden="true"
        >
          <ChevronRightIcon />
        </span>
      </button>
      {open ? <div className="bcq-disclosure__body">{children}</div> : null}
    </div>
  );
}
