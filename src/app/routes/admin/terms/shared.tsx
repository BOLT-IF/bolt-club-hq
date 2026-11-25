import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import { EmptyState, ErrorState, Skeleton } from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { goBack } from "../../../lib/navigate";

export type TermStatus = "draft" | "open_for_passes" | "active" | "closed";

export interface TermRow {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: TermStatus;
  clonedFromTermId: string | null;
  seriesCount?: number;
}

export interface SeriesRow {
  id: string;
  termId: string;
  name: string;
  format: string;
  level: string | null;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string | null;
  capacity: number;
  passPrice: number;
  discountedPassPrice: number | null;
  adhocFee: number;
  maxGuestsDefault: number;
  rsvpCloseOffsetMin: number;
  shareSlug: string;
  skipDates: string[];
  skipDatesLocked: boolean;
  passCap: number;
  captains: Array<{ id: string; displayName: string }>;
  discountEligible?: Array<{ id: string; displayName: string }>;
}

export const STATUS_LABEL: Record<TermStatus, string> = {
  draft: "Draft",
  open_for_passes: "Open for passes",
  active: "Active",
  closed: "Closed",
};

export const NEXT_STATUS: Record<TermStatus, TermStatus | null> = {
  draft: "open_for_passes",
  open_for_passes: "active",
  active: "closed",
  closed: null,
};

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const FORMATS = ["MD", "WD", "XD", "mixed", "open"] as const;

const MESSAGES: Record<string, string> = {
  invalid_transition: "That status change isn't allowed from here.",
  dates_locked: "Dates can only change while the term is a draft.",
  term_closed: "This term is closed and can no longer be changed.",
  term_not_deletable: "Only an empty draft term can be deleted.",
  series_in_use: "This series already has events or passes.",
  invalid_captains: "Captains must be active members.",
  invalid_discount_members: "Discounted members must be active members.",
  forbidden_field: "Only an admin can change those fields.",
};

/** A short, human message for a failed call. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; detail?: string } | null;
    const code = body?.error;
    if (code && code in MESSAGES) return MESSAGES[code] ?? "";
    if (body?.detail) return body.detail;
  }
  return "Something went wrong. Please try again.";
}

/** Loads a GET endpoint. `reload` refetches; failures surface as `error`. */
export interface LoadState<T> {
  data: T | null;
  error: boolean;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(path: string): LoadState<T> {
  const [state, setState] = useState<{ data: T | null; error: boolean; loading: boolean }>({
    data: null,
    error: false,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch<T>(path)
      .then((data) => {
        if (!cancelled) setState({ data, error: false, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, error: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: false }));
    setTick((n) => n + 1);
  }, []);
  return { ...state, reload };
}

/** Keeps the whole area dark until the events flag is on. */
export function AreaGate({ children }: { readonly children: ReactNode }) {
  if (!useFeatureFlag("events")) {
    return <EmptyState title="Terms & series">This area is not available yet.</EmptyState>;
  }
  return <>{children}</>;
}

/** Page frame: gate, title, explicit back control target, loading and error states. */
export function Loaded<T>({
  load,
  children,
}: {
  readonly load: LoadState<T>;
  readonly children: (data: T) => ReactNode;
}) {
  if (load.error) {
    return <ErrorState onRetry={load.reload}>We couldn&apos;t load this page.</ErrorState>;
  }
  if (load.loading && !load.data) return <Skeleton label="Loading" />;
  return load.data ? <>{children(load.data)}</> : null;
}

export function BackLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <a
      href={to}
      className="bcq-link"
      onClick={(event) => {
        event.preventDefault();
        goBack(to);
      }}
    >
      {children}
    </a>
  );
}

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  hint,
  required = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "date" | "time" | "number";
  readonly hint?: string;
  readonly required?: boolean;
}) {
  return (
    <label className="bcq-field">
      <span className="bcq-field__label">{label}</span>
      <input
        className="bcq-input"
        type={type}
        value={value}
        required={required}
        inputMode={type === "number" ? "numeric" : undefined}
        min={type === "number" ? 0 : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint ? <span className="bcq-field__hint">{hint}</span> : null}
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="bcq-field">
      <span className="bcq-field__label">{label}</span>
      <select
        className="bcq-input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whole number from a text field; null when blank or not a whole number. */
export function toWhole(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value) : null;
}
