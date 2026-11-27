import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "../../lib/cx";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface BottomSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

function CloseIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * Modal sheet anchored to the bottom of the screen, portaled above the bottom nav bar.
 * Supports internal scrolling with an optional sticky footer, Escape/backdrop dismiss,
 * body scroll lock, and focus trapping.
 */
export function BottomSheet({ open, title, onClose, footer, children }: BottomSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    first?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl?.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl?.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  const sheet = (
    <div className="bcq-sheet-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx("bcq-sheet", footer !== undefined && "bcq-sheet--with-footer")}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="bcq-sheet__top">
          <div className="bcq-sheet__grip" aria-hidden="true" />
          <header className="bcq-sheet__header">
            <h2 id={titleId} className="bcq-sheet__title">
              {title}
            </h2>
            <button type="button" className="bcq-sheet__close" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
        </div>
        <div className="bcq-sheet__body">{children}</div>
        {footer !== undefined ? <div className="bcq-sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(sheet, document.body) : sheet;
}
