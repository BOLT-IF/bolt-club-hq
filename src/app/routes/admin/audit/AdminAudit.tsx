import { useEffect, useState, type ReactNode } from "react";

import { apiFetch } from "../../../api/client";
import {
  BottomSheet,
  Button,
  ChevronRightIcon,
  CopyButton,
  EmptyState,
  ErrorState,
  Skeleton,
} from "../../../components/ui";
import { cx } from "../../../lib/cx";
import "../../members/members.css";
import "./audit.css";

const TZ = "Europe/Stockholm";

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
}

interface AuditPage {
  readonly entries: AuditEntry[];
  readonly nextCursor: string | null;
}

interface Filters {
  actor: string;
  entity: string;
  entityId: string;
  action: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { actor: "", entity: "", entityId: "", action: "", from: "", to: "" };

/** Offset of Stockholm from UTC at `utc`, in minutes. */
function stockholmOffsetMinutes(utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(utc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((local - utc.getTime()) / 60_000);
}

/** UTC instant of 00:00 Stockholm time on `day` (YYYY-MM-DD). Midnight is never in a DST gap. */
export function stockholmDayStartUtc(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  // The offset at local midnight equals the offset shortly before it; one correction is enough.
  const guess = midnightAsUtc - stockholmOffsetMinutes(new Date(midnightAsUtc)) * 60_000;
  return new Date(midnightAsUtc - stockholmOffsetMinutes(new Date(guess)) * 60_000).toISOString();
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function query(filters: Filters, cursor: string | null): string {
  const q = new URLSearchParams();
  if (filters.actor) q.set("actor", filters.actor);
  if (filters.entity.trim()) q.set("entity", filters.entity.trim());
  if (filters.entityId.trim()) q.set("entityId", filters.entityId.trim());
  if (filters.action.trim()) q.set("action", filters.action.trim());
  if (filters.from) q.set("from", stockholmDayStartUtc(filters.from));
  // The UI's "To" day is inclusive; the API's `to` is exclusive.
  if (filters.to) q.set("to", stockholmDayStartUtc(nextDay(filters.to)));
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return s ? `/admin/audit?${s}` : "/admin/audit";
}

const formatAt = (at: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(at));

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const ACTION_LABELS: Record<string, string> = {
  "attendance.mark": "Attendance Marked",
  "member.approve": "Member Approved",
  "member.created": "Member Created",
  "member.update": "Member Updated",
  "member.role_change": "Member Role Changed",
  "member.deactivate": "Member Deactivated",
  "member.reactivate": "Member Reactivated",
  "pass.purchase": "Pass Purchased",
  "pass.assign": "Pass Assigned",
  "pass.revoke": "Pass Revoked",
  "club_fee.mark_external_paid": "Club Fee Marked Paid",
  "club_fee.waive": "Club Fee Waived",
  "series.generate": "Series Generated",
  "series.create": "Series Created",
  "event.create": "Event Created",
  "event.update": "Event Updated",
  "event.cancel": "Event Cancelled",
  "payment.record": "Payment Recorded",
  "claim.confirm": "Payment Claim Confirmed",
  "claim.reject": "Payment Claim Rejected",
  "poll.create": "Poll Created",
  "poll.close": "Poll Closed",
};

const ENTITY_LABELS: Record<string, string> = {
  member: "Member",
  event: "Event",
  pass: "Pass",
  club_fee: "Club Fee",
  series: "Series",
  poll: "Poll",
  payment_claim: "Payment Claim",
  reminder_rule: "Reminder Rule",
};

function toTitleCase(raw: string): string {
  return raw
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? toTitleCase(action);
}

function humanizeEntity(entity: string): string {
  return ENTITY_LABELS[entity] ?? toTitleCase(entity);
}

function formatShortEntityId(entityId: string): string {
  if (entityId.length <= 16) return entityId;
  return `${entityId.slice(0, 8)}…${entityId.slice(-4)}`;
}

function SlidersIcon() {
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
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CalendarIcon({ size = 18 }: { readonly size?: number }) {
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
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
    </svg>
  );
}

function CalendarCheckIcon() {
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
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
      <path d="m9 16 2 2 4-4" />
    </svg>
  );
}

function UserCheckIcon() {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

function ReceiptIcon() {
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
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 17.5v-11" />
    </svg>
  );
}

function HistoryIcon() {
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
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function categoryMeta(action: string): { toneClass: string; icon: ReactNode } {
  if (action.startsWith("attendance.")) {
    return { toneClass: "bcq-icon-badge--emerald", icon: <CalendarCheckIcon /> };
  }
  if (action.startsWith("member.")) {
    return { toneClass: "bcq-audit-badge--blue", icon: <UserCheckIcon /> };
  }
  if (
    action.startsWith("pass.") ||
    action.startsWith("club_fee.") ||
    action.startsWith("payment.") ||
    action.startsWith("claim.")
  ) {
    return { toneClass: "bcq-icon-badge--amber", icon: <ReceiptIcon /> };
  }
  if (action.startsWith("event.") || action.startsWith("series.")) {
    return { toneClass: "bcq-icon-badge--slate", icon: <CalendarIcon size={18} /> };
  }
  return { toneClass: "bcq-icon-badge--neutral", icon: <HistoryIcon /> };
}

function countActiveFilters(filters: Filters): number {
  let count = 0;
  if (filters.actor) count += 1;
  if (filters.action.trim()) count += 1;
  if (filters.entity.trim()) count += 1;
  if (filters.entityId.trim()) count += 1;
  if (filters.from) count += 1;
  if (filters.to) count += 1;
  return count;
}

function summarizeFilters(
  filters: Filters,
  actors: ReadonlyArray<{ id: string; displayName: string }>,
): string {
  const parts: string[] = [];
  if (filters.actor) {
    const actor = actors.find((a) => a.id === filters.actor);
    parts.push(actor ? `Actor: ${actor.displayName}` : `Actor: ${filters.actor}`);
  }
  if (filters.action.trim()) parts.push(`Action: ${filters.action.trim()}`);
  if (filters.entity.trim()) parts.push(`Entity: ${filters.entity.trim()}`);
  if (filters.entityId.trim()) parts.push(`ID: ${formatShortEntityId(filters.entityId.trim())}`);
  if (filters.from && filters.to) {
    parts.push(`${filters.from} → ${filters.to}`);
  } else if (filters.from) {
    parts.push(`From ${filters.from}`);
  } else if (filters.to) {
    parts.push(`To ${filters.to}`);
  }
  return parts.join(" · ");
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly entries: AuditEntry[]; readonly nextCursor: string | null };

/** Admin audit log: newest first, filter by actor, entity, action and Stockholm date range. */
export function AdminAudit() {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [actors, setActors] = useState<Array<{ id: string; displayName: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ members: Array<{ id: string; displayName: string }> }>("/admin/members")
      .then((data) => {
        if (!cancelled) setActors(data.members);
      })
      .catch(() => {
        // The actor filter falls back to "Anyone" only; the log itself still loads.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bumped to refetch the first page (apply, clear, retry); handlers set "loading" themselves.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuditPage>(query(applied, null))
      .then((page) => {
        if (!cancelled)
          setState({ kind: "ready", entries: page.entries, nextCursor: page.nextCursor });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [applied, generation]);

  function reload(filters: Filters) {
    setState({ kind: "loading" });
    setApplied(filters);
    setGeneration((g) => g + 1);
  }

  async function loadMore() {
    if (state.kind !== "ready" || !state.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<AuditPage>(query(applied, state.nextCursor));
      setState({
        kind: "ready",
        entries: [...state.entries, ...page.entries],
        nextCursor: page.nextCursor,
      });
    } catch {
      setState({ kind: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  function applyDraftFilters() {
    reload({ ...draft });
    setFiltersOpen(false);
  }

  function clearFilters() {
    setDraft(NO_FILTERS);
    reload(NO_FILTERS);
    setFiltersOpen(false);
  }

  const field = (key: keyof Filters) => ({
    id: `audit-${key}`,
    className: "bcq-input",
    value: draft[key],
    onChange: (e: { target: { value: string } }) => {
      setDraft((d) => ({ ...d, [key]: e.target.value }));
    },
  });

  const activeFilterCount = countActiveFilters(applied);
  const filterSummary = summarizeFilters(applied, actors);

  const selectedWho = selectedEntry
    ? (selectedEntry.actorName ?? (selectedEntry.actorId ? selectedEntry.actorId : "System"))
    : "";
  const selectedCategory = selectedEntry ? categoryMeta(selectedEntry.action) : null;

  return (
    <section className="bcq-page bcq-audit-page" aria-labelledby="admin-audit-title">
      <div className="bcq-audit-head">
        <h1 id="admin-audit-title" className="bcq-page__title">
          Audit Log
        </h1>
        <button
          type="button"
          className="bcq-audit-filter-btn"
          aria-label={
            activeFilterCount > 0 ? `Filters (${String(activeFilterCount)} active)` : "Filters"
          }
          onClick={() => {
            setDraft(applied);
            setFiltersOpen(true);
          }}
        >
          <span className="bcq-audit-filter-btn__icon" aria-hidden="true">
            <SlidersIcon />
          </span>
          <span>Filters</span>
          {activeFilterCount > 0 ? (
            <span className="bcq-audit-filter-btn__badge" aria-hidden="true">
              {activeFilterCount}
            </span>
          ) : null}
        </button>
      </div>

      {activeFilterCount > 0 ? (
        <div className="bcq-audit-active-strip" role="region" aria-label="Active filters">
          <p className="bcq-audit-active-strip__text">
            <strong>
              {activeFilterCount === 1 ? "1 filter:" : `${String(activeFilterCount)} filters:`}
            </strong>{" "}
            {filterSummary}
          </p>
          <button type="button" className="bcq-audit-active-strip__clear" onClick={clearFilters}>
            Clear
          </button>
        </div>
      ) : null}

      {state.kind === "loading" ? <Skeleton lines={4} label="Loading audit log" /> : null}
      {state.kind === "error" ? (
        <ErrorState
          title="Couldn't Load Audit Log"
          onRetry={() => {
            reload(applied);
          }}
        >
          Check your connection, or that you are signed in as an admin.
        </ErrorState>
      ) : null}
      {state.kind === "ready" && state.entries.length === 0 ? (
        <EmptyState title="No Audit Entries">Nothing matches these filters.</EmptyState>
      ) : null}
      {state.kind === "ready" && state.entries.length > 0 ? (
        <div className="bcq-audit-feed">
          <p className="bcq-audit-section__label">Audit Events</p>
          <ul className="bcq-audit-list">
            {state.entries.map((e) => {
              const who = e.actorName ?? (e.actorId ? e.actorId : "System");
              const actionTitle = humanizeAction(e.action);
              const entityLabel = humanizeEntity(e.entity);
              const cat = categoryMeta(e.action);
              return (
                <li key={e.id} className="bcq-audit-item" aria-label={`${actionTitle} by ${who}`}>
                  <button
                    type="button"
                    className="bcq-audit-card"
                    onClick={() => {
                      setSelectedEntry(e);
                    }}
                  >
                    <span className={cx("bcq-icon-badge", cat.toneClass)} aria-hidden="true">
                      {cat.icon}
                    </span>
                    <span className="bcq-audit-card__body">
                      <span className="bcq-audit-card__title">{actionTitle}</span>
                      <span className="bcq-audit-card__meta">
                        <time dateTime={e.at}>{formatAt(e.at)}</time> · by {who}
                      </span>
                      <span className="bcq-audit-card__entity">
                        <span>{entityLabel}</span>
                        <span className="bcq-audit-id-pill">{formatShortEntityId(e.entityId)}</span>
                      </span>
                    </span>
                    <span className="bcq-audit-card__chevron" aria-hidden="true">
                      <ChevronRightIcon />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {state.nextCursor ? (
            <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}

      <BottomSheet
        open={filtersOpen}
        title="Filter Audit Log"
        onClose={() => {
          setFiltersOpen(false);
        }}
        footer={
          <div className="bcq-audit-sheet-footer">
            <Button type="button" onClick={applyDraftFilters}>
              Apply Filters
            </Button>
            <Button type="button" variant="tonal" onClick={clearFilters}>
              Clear
            </Button>
          </div>
        }
      >
        <form
          className="bcq-form bcq-audit__filters"
          aria-label="Filters"
          onSubmit={(event) => {
            event.preventDefault();
            applyDraftFilters();
          }}
        >
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="audit-actor">
              Actor
            </label>
            <select {...field("actor")}>
              <option value="">Anyone</option>
              {actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="audit-action">
              Action
            </label>
            <div className="bcq-audit-input-wrap">
              <input
                {...field("action")}
                className={cx("bcq-input", draft.action.length > 0 && "bcq-audit-input--clearable")}
                placeholder="e.g. member.role_change"
                autoComplete="off"
              />
              {draft.action.length > 0 ? (
                <button
                  type="button"
                  className="bcq-search__clear"
                  aria-label="Clear action"
                  onClick={() => {
                    setDraft((d) => ({ ...d, action: "" }));
                  }}
                >
                  <ClearIcon />
                </button>
              ) : null}
            </div>
          </div>
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="audit-entity">
              Entity
            </label>
            <input {...field("entity")} placeholder="e.g. member" autoComplete="off" />
          </div>
          <div className="bcq-field">
            <label className="bcq-field__label" htmlFor="audit-entityId">
              Entity ID
            </label>
            <div className="bcq-audit-input-wrap">
              <input
                {...field("entityId")}
                className={cx(
                  "bcq-input bcq-audit-input--mono",
                  draft.entityId.length > 0 && "bcq-audit-input--clearable",
                )}
                placeholder="e.g. mem_123"
                autoComplete="off"
              />
              {draft.entityId.length > 0 ? (
                <button
                  type="button"
                  className="bcq-search__clear"
                  aria-label="Clear Entity ID"
                  onClick={() => {
                    setDraft((d) => ({ ...d, entityId: "" }));
                  }}
                >
                  <ClearIcon />
                </button>
              ) : null}
            </div>
          </div>
          <div className="bcq-audit-date-grid">
            <div className="bcq-field">
              <label className="bcq-field__label" htmlFor="audit-from">
                From
              </label>
              <div className="bcq-audit-date-wrap">
                <span className="bcq-audit-date__icon" aria-hidden="true">
                  <CalendarIcon size={16} />
                </span>
                <input {...field("from")} className="bcq-input bcq-audit-date__input" type="date" />
              </div>
            </div>
            <div className="bcq-field">
              <label className="bcq-field__label" htmlFor="audit-to">
                To
              </label>
              <div className="bcq-audit-date-wrap">
                <span className="bcq-audit-date__icon" aria-hidden="true">
                  <CalendarIcon size={16} />
                </span>
                <input
                  {...field("to")}
                  className="bcq-input bcq-audit-date__input"
                  type="date"
                  min={draft.from || undefined}
                />
              </div>
            </div>
          </div>
        </form>
      </BottomSheet>

      <BottomSheet
        open={selectedEntry !== null}
        title="Change Details"
        onClose={() => {
          setSelectedEntry(null);
        }}
        footer={
          <div className="bcq-audit-detail-footer">
            <Button
              type="button"
              variant="tonal"
              onClick={() => {
                setSelectedEntry(null);
              }}
            >
              Close
            </Button>
          </div>
        }
      >
        {selectedEntry ? (
          <div className="bcq-audit-detail">
            <div className="bcq-audit-detail__hero">
              {selectedCategory ? (
                <span
                  className={cx("bcq-icon-badge", selectedCategory.toneClass)}
                  aria-hidden="true"
                >
                  {selectedCategory.icon}
                </span>
              ) : null}
              <div className="bcq-audit-detail__hero-text">
                <h3 className="bcq-audit-detail__title">{humanizeAction(selectedEntry.action)}</h3>
                <span className="bcq-audit-detail__raw">{selectedEntry.action}</span>
              </div>
            </div>

            <dl className="bcq-audit-detail__meta">
              <div className="bcq-audit-detail__row">
                <dt>Timestamp</dt>
                <dd className="bcq-tabular-nums">
                  <time dateTime={selectedEntry.at}>{formatAt(selectedEntry.at)}</time>
                </dd>
              </div>
              <div className="bcq-audit-detail__row">
                <dt>Actor</dt>
                <dd>{selectedWho}</dd>
              </div>
              <div className="bcq-audit-detail__row">
                <dt>Entity</dt>
                <dd>{humanizeEntity(selectedEntry.entity)}</dd>
              </div>
              <div className="bcq-audit-detail__row bcq-audit-detail__row--copy">
                <div className="bcq-audit-detail__row-text">
                  <dt>Entity ID</dt>
                  <dd className="bcq-audit-detail__mono">{selectedEntry.entityId}</dd>
                </div>
                <CopyButton
                  value={selectedEntry.entityId}
                  label="Copy"
                  ariaLabel="Copy Entity ID"
                />
              </div>
            </dl>

            {selectedEntry.before !== null || selectedEntry.after !== null ? (
              <div className="bcq-audit-detail__payloads">
                {selectedEntry.before !== null ? (
                  <div>
                    <h4 className="bcq-audit__label">Before</h4>
                    <pre className="bcq-audit__json">{pretty(selectedEntry.before)}</pre>
                  </div>
                ) : null}
                {selectedEntry.after !== null ? (
                  <div>
                    <h4 className="bcq-audit__label">After</h4>
                    <pre className="bcq-audit__json">{pretty(selectedEntry.after)}</pre>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="bcq-audit-detail__empty">No before/after payload recorded.</p>
            )}
          </div>
        ) : null}
      </BottomSheet>
    </section>
  );
}
