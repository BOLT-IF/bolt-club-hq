import { useRef, useState } from "react";

import { ApiError, apiFetch } from "../../../../api/client";
import {
  BottomSheet,
  Button,
  ConfirmDialog,
  EmptyState,
  StatusChip,
  useToast,
} from "../../../../components/ui";
import { useBackTarget } from "../../../../shell/AppShell";
import { useRouteParams } from "../../../registry";
import { AreaGate, Loaded, TextField, WEEKDAYS, errorMessage, toWhole, useLoad } from "../shared";
import "../terms.css";

/** Club time zone (PLAN A1). Display only; the server does all date maths. */
const ZONE = "Europe/Stockholm";

function LockIcon() {
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
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

interface OccurrenceEvent {
  id: string;
  startsAt: string;
  location: string | null;
  capacity: number;
  maxGuestsPerMember: number;
  status: "scheduled" | "closed" | "cancelled" | "completed";
}

interface Occurrence {
  date: string;
  skipped: boolean;
  event: OccurrenceEvent | null;
}

interface Listing {
  series: {
    id: string;
    termId: string;
    name: string;
    weekday: number;
    startTime: string;
    skipDates: string[];
    skipDatesLocked: boolean;
  };
  occurrences: Occurrence[];
}

const STATUS: Record<OccurrenceEvent["status"], string> = {
  scheduled: "Scheduled",
  closed: "Closed",
  cancelled: "Cancelled",
  completed: "Completed",
};

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T00:00:00Z`));

const localTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

const codeOf = (error: unknown) =>
  error instanceof ApiError ? (error.body as Record<string, unknown> | null) : null;

export function SchedulePage() {
  return (
    <AreaGate>
      <Schedule />
    </AreaGate>
  );
}

function Schedule() {
  const { id = "" } = useRouteParams();
  const base = `/series/${encodeURIComponent(id)}`;
  const load = useLoad<Listing>(`${base}/occurrences`);

  return (
    <section className="bcq-page bcq-stack">
      <Loaded load={load}>
        {(data) => (
          <ScheduleBody key={JSON.stringify(data)} base={base} data={data} reload={load.reload} />
        )}
      </Loaded>
    </section>
  );
}

function setsEqual(a: ReadonlySet<string>, b: readonly string[]): boolean {
  if (a.size !== b.length) return false;
  return b.every((item) => a.has(item));
}

function ScheduleBody({
  base,
  data,
  reload,
}: {
  readonly base: string;
  readonly data: Listing;
  readonly reload: () => void;
}) {
  const toast = useToast();
  const { series, occurrences } = data;
  const [skip, setSkip] = useState<ReadonlySet<string>>(() => new Set(series.skipDates));
  const [lockBlocked, setLockBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<OccurrenceEvent | null>(null);

  useBackTarget({ label: series.name, fallback: `/admin/terms/series/${series.id}` });

  const hasSkipChanges = !setsEqual(skip, series.skipDates);

  async function generate() {
    setBusy(true);
    try {
      const res = await apiFetch<{ created: number }>(`${base}/generate-events`, {
        method: "POST",
      });
      toast.show(
        res.created === 1 ? "1 event created" : `${String(res.created)} events created`,
        "success",
      );
      reload();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function saveSkips(overrideLock: boolean) {
    setBusy(true);
    try {
      await apiFetch(`${base}/skip-dates`, {
        method: "PUT",
        body: { skipDates: [...skip].sort(), ...(overrideLock ? { overrideLock: true } : {}) },
      });
      setLockBlocked(false);
      toast.show("Skip-dates saved", "success");
      reload();
    } catch (error) {
      const body = codeOf(error);
      if (body?.error === "skip_dates_locked") setLockBlocked(true);
      else if (body?.error === "skip_date_has_event") {
        toast.show("A date with an event can't be skipped. Cancel the event instead.", "danger");
      } else toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="bcq-page__title">{series.name} Schedule</h1>
        <p className="bcq-card__meta" style={{ marginTop: "0.3rem" }}>
          {`Every ${WEEKDAYS[series.weekday - 1] ?? ""} at ${series.startTime} (Stockholm time)`}
        </p>
      </div>

      <div>
        <Button block disabled={busy} onClick={() => void generate()}>
          Generate Events
        </Button>
        <p className="bcq-card__meta" style={{ marginTop: "0.45rem" }}>
          Creates missing nights only. Edited and cancelled nights stay unchanged.
        </p>
      </div>

      {series.skipDatesLocked ? (
        <p className="bcq-terms-info-banner">
          <span className="bcq-terms-info-banner__icon" aria-hidden="true">
            <LockIcon />
          </span>
          <span>
            Skip-dates are locked because passes are on sale. Changing them requires an override.
          </span>
        </p>
      ) : null}

      <h2 className="bcq-terms-sec-label">Occurrences ({occurrences.length})</h2>
      {occurrences.length === 0 ? (
        <EmptyState title="No Dates">This term has no dates for this weekday</EmptyState>
      ) : (
        <ul className="bcq-list">
          {occurrences.map((o) => (
            <li key={o.date} className="bcq-card">
              <div className="bcq-card__row">
                <span className="bcq-card__title bcq-terms-input--tabular">
                  {dayLabel(o.date)}
                  {o.event ? ` · ${localTime(o.event.startsAt)}` : ""}
                </span>
                {o.event ? (
                  <StatusChip tone={o.event.status === "cancelled" ? "danger" : "success"}>
                    {STATUS[o.event.status]}
                  </StatusChip>
                ) : o.skipped ? (
                  <StatusChip tone="warning">Skipped</StatusChip>
                ) : (
                  <StatusChip>Not Generated</StatusChip>
                )}
              </div>
              {o.event ? (
                <div className="bcq-card__row">
                  <span className="bcq-card__meta">
                    {`${o.event.location ?? "No location"} · ${String(o.event.capacity)} spots`}
                  </span>
                  {o.event.status === "scheduled" ? (
                    <Button
                      variant="tonal"
                      className="bcq-btn--compact bcq-occ-edit-btn"
                      aria-label={`Edit ${dayLabel(o.date)}`}
                      onClick={() => {
                        setEditing(o.event);
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="bcq-occ-switch-row">
                  <span className="bcq-occ-switch-row__label">Skip this date</span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="bcq-switch"
                    checked={skip.has(o.date)}
                    aria-label={`Skip ${dayLabel(o.date)}`}
                    onChange={(e) => {
                      setSkip((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.add(o.date);
                        else next.delete(o.date);
                        return next;
                      });
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!series.skipDatesLocked || hasSkipChanges ? (
        <Button
          variant="tonal"
          disabled={busy || !hasSkipChanges}
          onClick={() => void saveSkips(false)}
        >
          Save Skip-Dates
        </Button>
      ) : null}

      <ConfirmDialog
        open={lockBlocked}
        title="Override Locked Skip-Dates?"
        description="Passes are already on sale for this series. Buyers were told how many nights they get, so change skip-dates only if you must."
        confirmLabel={busy ? "Saving…" : "Save Anyway"}
        destructive
        onConfirm={() => void saveSkips(true)}
        onCancel={() => {
          if (!busy) setLockBlocked(false);
        }}
      />

      <EditSheet
        base={base}
        event={editing}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          toast.show("Occurrence saved", "success");
          reload();
        }}
      />
    </>
  );
}

function EditSheet({
  base,
  event,
  onClose,
  onSaved,
}: {
  readonly base: string;
  readonly event: OccurrenceEvent | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  return event ? (
    <EditForm key={event.id} base={base} event={event} onClose={onClose} onSaved={onSaved} />
  ) : null;
}

function EditForm({
  base,
  event,
  onClose,
  onSaved,
}: {
  readonly base: string;
  readonly event: OccurrenceEvent;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const initial = {
    location: event.location ?? "",
    capacity: String(event.capacity),
    startTime: localTime(event.startsAt),
    guests: String(event.maxGuestsPerMember),
  };
  const [form, setForm] = useState(initial);
  const [blocked, setBlocked] = useState<{
    changes: Record<string, unknown>;
    passCap: number;
    passesSold: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  function changes(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    if (form.location !== initial.location) out.location = form.location.trim() || null;
    if (form.startTime !== initial.startTime) out.startTime = form.startTime;
    for (const [key, field] of [
      ["capacity", "capacity"],
      ["maxGuestsPerMember", "guests"],
    ] as const) {
      if (form[field] === initial[field]) continue;
      const n = toWhole(form[field]);
      if (n === null) return null;
      out[key] = n;
    }
    return out;
  }

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiFetch(`${base}/occurrences/${encodeURIComponent(event.id)}`, {
        method: "PATCH",
        body,
      });
      setBlocked(null);
      onSaved();
    } catch (error) {
      const err = codeOf(error);
      if (err?.error === "cap_below_passes_sold") {
        setBlocked({
          changes: body,
          passCap: Number(err.passCap),
          passesSold: Number(err.passesSold),
        });
      } else if (err?.error === "event_closed") {
        toast.show("RSVPs for this night have closed, so it can't be edited here.", "danger");
      } else toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  function runSubmit() {
    if (formRef.current?.reportValidity() === false) return;
    const body = changes();
    if (body === null) {
      toast.show("Capacity and guests must be whole numbers.", "danger");
      return;
    }
    if (Object.keys(body).length === 0) return;
    setBlocked(null);
    void save(body);
  }

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <>
      <BottomSheet
        open
        title="Edit Occurrence"
        onClose={() => {
          if (!busy) onClose();
        }}
        footer={
          <div className="bcq-terms-sheet-footer">
            <Button type="button" disabled={busy} onClick={runSubmit}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="tonal"
              disabled={busy}
              onClick={() => {
                if (!busy) onClose();
              }}
            >
              Cancel
            </Button>
          </div>
        }
      >
        <form
          ref={formRef}
          className="bcq-form"
          onSubmit={(e) => {
            e.preventDefault();
            runSubmit();
          }}
        >
          <TextField label="Location" value={form.location} onChange={set("location")} />
          <TextField
            label="Start Time"
            type="time"
            value={form.startTime}
            onChange={set("startTime")}
            hint="Stockholm time. The RSVP close time moves with it."
          />
          <div className="bcq-terms-grid-2">
            <TextField
              label="Capacity"
              type="number"
              value={form.capacity}
              onChange={set("capacity")}
            />
            <TextField
              label="Guests Per Member"
              type="number"
              value={form.guests}
              onChange={set("guests")}
            />
          </div>
        </form>
      </BottomSheet>

      <ConfirmDialog
        open={blocked !== null}
        title="Override Pass Cap?"
        description={
          blocked
            ? `That puts the pass cap at ${String(blocked.passCap)}, below the ${String(blocked.passesSold)} passes already sold.`
            : ""
        }
        confirmLabel={busy ? "Saving…" : "Save Anyway"}
        destructive
        onConfirm={() => {
          if (blocked && !busy) {
            void save({ ...blocked.changes, overrideCapBelowSold: true });
          }
        }}
        onCancel={() => {
          if (!busy) setBlocked(null);
        }}
      />
    </>
  );
}
