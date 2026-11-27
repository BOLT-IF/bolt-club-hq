import { useEffect, useRef, useState } from "react";

import { cx } from "../../lib/cx";
import { useToast } from "./Toast";

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Filled tonal copy button with instant 2-second emerald "Copied" feedback (PWA_UI_Rules.md §3). */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  ariaLabel,
  toastMessage,
  className,
}: {
  readonly value: string;
  readonly label?: string;
  readonly copiedLabel?: string;
  readonly ariaLabel?: string;
  readonly toastMessage?: string;
  readonly className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    (clipboard ? clipboard.writeText(value) : Promise.reject(new Error("no clipboard"))).then(
      () => {
        setCopied(true);
        if (toastMessage) toast.show(toastMessage, "success");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
        }, 2000);
      },
      () => {
        toast.show("Couldn't copy. Select the text and copy it by hand.", "danger");
      },
    );
  };

  return (
    <button
      type="button"
      className={cx("bcq-btn bcq-btn--tonal", copied && "bcq-btn--copied", className)}
      aria-label={ariaLabel}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}
