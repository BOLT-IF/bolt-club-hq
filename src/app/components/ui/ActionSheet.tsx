import type { ReactNode } from "react";

import { cx } from "../../lib/cx";
import { BottomSheet } from "./BottomSheet";

function ActionSheetRoot({
  open,
  title,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <BottomSheet open={open} title={title} onClose={onClose}>
      <div className="bcq-actionsheet">{children}</div>
    </BottomSheet>
  );
}

function ActionSheetHeader({
  title,
  subtitle,
}: {
  readonly title: string;
  readonly subtitle?: string;
}) {
  return (
    <div className="bcq-actionsheet__header">
      <p className="bcq-actionsheet__title">{title}</p>
      {subtitle ? <p className="bcq-actionsheet__subtitle">{subtitle}</p> : null}
    </div>
  );
}

function ActionSheetGroup({ children }: { readonly children: ReactNode }) {
  return <div className="bcq-actionsheet__group">{children}</div>;
}

function ActionSheetItem({
  icon,
  tone = "tonal",
  disabled = false,
  onClick,
  children,
}: {
  readonly icon?: ReactNode;
  readonly tone?: "tonal" | "destructive-tonal" | "destructive-solid";
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cx("bcq-actionsheet__item", `bcq-actionsheet__item--${tone}`)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function ActionSheetDivider() {
  return <hr className="bcq-actionsheet__divider" />;
}

function ActionSheetCancel({
  onClick,
  label = "Cancel",
}: {
  readonly onClick: () => void;
  readonly label?: string;
}) {
  return (
    <button
      type="button"
      className="bcq-actionsheet__item bcq-actionsheet__item--cancel"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function MoreHorizontalIcon() {
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
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

/** Compound Bottom Action Sheet primitive (PWA_UI_Rules.md §4). */
export const ActionSheet = {
  Root: ActionSheetRoot,
  Header: ActionSheetHeader,
  Group: ActionSheetGroup,
  Item: ActionSheetItem,
  Divider: ActionSheetDivider,
  Cancel: ActionSheetCancel,
};
