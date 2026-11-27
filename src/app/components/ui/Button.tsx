import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../../lib/cx";

export type ButtonVariant =
  | "primary"
  | "tonal"
  | "secondary"
  | "destructive-tonal"
  | "destructive-solid"
  | "danger"
  | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly block?: boolean;
  readonly children: ReactNode;
}

/** 4-tier tactile button following Apple HIG (min 44px touch target, press scale). */
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
