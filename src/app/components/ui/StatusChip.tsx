import type { ReactNode } from "react";

import { cx } from "../../lib/cx";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info" | "sky";

/** Text plus colour, so status never depends on colour alone (WCAG 1.4.1). */
export function StatusChip({
  tone = "neutral",
  children,
}: {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
}) {
  return <span className={cx("bcq-chip", `bcq-chip--${tone}`)}>{children}</span>;
}
