import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import {
  formatClubYear,
  resolveTermMembershipPeriod,
  type TermSeason,
} from "../../../../domain/club-fee";
import { EmptyState, ErrorState, Skeleton } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { useFeatureFlag } from "../../../lib/flags";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type TermStatus = "draft" | "open_for_passes" | "active" | "closed";

export interface TermRow {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  season?: TermSeason | null;
  clubYear?: number | null;
  status: TermStatus;
  clonedFromTermId: string | null;
  seriesCount?: number;
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Human-readable date range (e.g., "Jan 17 – May 16, 2027"). Omits first year when same year. */
export function formatDateRange(startsOn: string, endsOn: string): string {
  const s = parseIsoDate(startsOn);
  const e = parseIsoDate(endsOn);
  if (!s || !e) return `${startsOn} – ${endsOn}`;
  const sMonth = MONTHS[s.month - 1];
  const eMonth = MONTHS[e.month - 1];
  if (!sMonth || !eMonth) return `${startsOn} – ${endsOn}`;
  if (s.year === e.year) {
    return `${sMonth} ${String(s.day)} – ${eMonth} ${String(e.day)}, ${String(e.year)}`;
  }
  return `${sMonth} ${String(s.day)}, ${String(s.year)} – ${eMonth} ${String(e.day)}, ${String(e.year)}`;
}

export function formatTermPeriod(t: Pick<TermRow, "startsOn" | "season" | "clubYear">): string {
  const { season, clubYear } = resolveTermMembershipPeriod({
    startsOn: t.startsOn,
    season: t.season ?? null,
    clubYear: t.clubYear ?? null,
  });
  return `${season === "fall" ? "Fall" : "Spring"} · ${formatClubYear(clubYear)}`;
}

export function PlusIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function CalendarIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
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
  passHolders?: Array<{
    id: string;
    memberId: string;
    displayName: string;
    paymentRef: string;
    priceCharged: number;
    purchasedAt: string;
  }>;
}

export const STATUS_LABEL: Record<TermStatus, string> = {
  draft: "Draft",
  open_for_passes: "Open for Passes",
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

export const FORMATS = [
  "Men's Doubles",
  "Mixed Doubles",
  "Women's Doubles",
  "Singles",
  "Training",
  "Open",
] as const;

export const FORMAT_LABEL: Record<string, string> = {
  "Men's Doubles": "Men's Doubles",
  "Mixed Doubles": "Mixed Doubles",
  "Women's Doubles": "Women's Doubles",
  Singles: "Singles",
  Training: "Training",
  Open: "Open",
};

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
    return <EmptyState title="Terms & Series">This area is not available yet.</EmptyState>;
  }
  return <>{children}</>;
}

/** Page frame: gate, loading and error states. */
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

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  required = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "date" | "time" | "number";
  readonly placeholder?: string;
  readonly hint?: string;
  readonly required?: boolean;
}) {
  return (
    <label className="bcq-terms-field">
      <span className="bcq-terms-field__label">{label}</span>
      <input
        className={cx(
          "bcq-terms-input",
          (type === "number" || type === "time" || type === "date") && "bcq-terms-input--tabular",
        )}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        inputMode={type === "number" ? "numeric" : undefined}
        min={type === "number" ? 0 : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint ? <span className="bcq-terms-field__hint">{hint}</span> : null}
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
    <label className="bcq-terms-field">
      <span className="bcq-terms-field__label">{label}</span>
      <select
        className="bcq-terms-input"
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
