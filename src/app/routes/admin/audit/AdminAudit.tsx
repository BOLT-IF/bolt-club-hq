import { useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import { Button, EmptyState, ErrorState, Skeleton } from "../../../components/ui";
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

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly entries: AuditEntry[]; readonly nextCursor: string | null };

/** Admin audit log: newest first, filter by actor, entity, action and Stockholm date range. */
export function AdminAudit() {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
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

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    reload({ ...draft });
  }

  const field = (key: keyof Filters) => ({
    id: `audit-${key}`,
    className: "bcq-input",
    value: draft[key],
    onChange: (e: { target: { value: string } }) => {
      setDraft((d) => ({ ...d, [key]: e.target.value }));
    },
  });

  return (
    <section className="bcq-page" aria-labelledby="admin-audit-title">
      <h1 id="admin-audit-title" className="bcq-page__title">
        Audit log
      </h1>

      <form className="bcq-form bcq-audit__filters" onSubmit={submit} aria-label="Filters">
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
          <input {...field("action")} placeholder="member.role_change" autoComplete="off" />
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="audit-entity">
            Entity
          </label>
          <input {...field("entity")} placeholder="member" autoComplete="off" />
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="audit-entityId">
            Entity id
          </label>
          <input {...field("entityId")} autoComplete="off" />
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="audit-from">
            From
          </label>
          <input {...field("from")} type="date" />
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="audit-to">
            To
          </label>
          <input {...field("to")} type="date" min={draft.from || undefined} />
        </div>
        <div className="bcq-audit__buttons">
          <Button type="submit">Apply filters</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDraft(NO_FILTERS);
              reload(NO_FILTERS);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {state.kind === "loading" ? <Skeleton label="Loading audit log" /> : null}
      {state.kind === "error" ? (
        <ErrorState
          title="Couldn't load the audit log"
          onRetry={() => {
            reload(applied);
          }}
        >
          Check your connection, or that you are signed in as an admin.
        </ErrorState>
      ) : null}
      {state.kind === "ready" && state.entries.length === 0 ? (
        <EmptyState title="No audit entries">Nothing matches these filters.</EmptyState>
      ) : null}
      {state.kind === "ready" && state.entries.length > 0 ? (
        <>
          <ul className="bcq-members">
            {state.entries.map((e) => {
              const who = e.actorName ?? (e.actorId ? e.actorId : "System");
              return (
                <li key={e.id} className="bcq-member" aria-label={`${e.action} by ${who}`}>
                  <div className="bcq-member__head">
                    <h2 className="bcq-member__name">{e.action}</h2>
                  </div>
                  <p className="bcq-member__meta">
                    <time dateTime={e.at}>{formatAt(e.at)}</time> · by {who}
                  </p>
                  <p className="bcq-member__meta">
                    <span>{`${e.entity} ${e.entityId}`}</span>
                  </p>
                  {e.before !== null || e.after !== null ? (
                    <details className="bcq-audit__change">
                      <summary>Change</summary>
                      {e.before !== null ? (
                        <>
                          <h3 className="bcq-audit__label">Before</h3>
                          <pre className="bcq-audit__json">{pretty(e.before)}</pre>
                        </>
                      ) : null}
                      {e.after !== null ? (
                        <>
                          <h3 className="bcq-audit__label">After</h3>
                          <pre className="bcq-audit__json">{pretty(e.after)}</pre>
                        </>
                      ) : null}
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {state.nextCursor ? (
            <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
