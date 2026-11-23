import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly block?: boolean;
  readonly children: ReactNode;
}

/** 48px minimum height for generous touch targets (mobile-first). */
export function Button({
  variant = "primary",
  block = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("bcq-btn", `bcq-btn--${variant}`, block && "bcq-btn--block", className)}
      {...rest}
    >
      {children}
    </button>
  );
}
