import { useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch } from "../../../../api/client";
import { BottomSheet, Button, EmptyState, StatusChip, useToast } from "../../../../components/ui";
import { useRouteParams } from "../../../registry";
import {
  AreaGate,
  BackLink,
  Loaded,
  TextField,
  WEEKDAYS,
  errorMessage,
  toWhole,
  useLoad,
} from "../shared";
import "../terms.css";

/** Club time zone (PLAN A1). Display only; the server does all date maths. */
const ZONE = "Europe/Stockholm";

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
      <BackLink to={`/admin/terms/series/${series.id}`}>Series</BackLink>
      <h1 className="bcq-page__title">{series.name}: schedule</h1>
      <p className="bcq-card__meta">
        {`Every ${WEEKDAYS[series.weekday - 1] ?? ""} at ${series.startTime} (Stockholm time)`}
      </p>
      <Button disabled={busy} onClick={() => void generate()}>
        Generate events
      </Button>
      <p className="bcq-card__meta">
        Creates the missing nights only. Edited and cancelled nights are left as they are.
      </p>

      {series.skipDatesLocked ? (
        <p className="bcq-notice">
          Skip-dates are locked because passes are on sale. Changing them needs an override.
        </p>
      ) : null}

      <h2 className="bcq-section-title">Occurrences</h2>
      {occurrences.length === 0 ? (
        <EmptyState title="No dates">This term has no dates for this weekday.</EmptyState>
      ) : (
        <ul className="bcq-list">
          {occurrences.map((o) => (
            <li key={o.date} className="bcq-card">
              <div className="bcq-card__row">
                <span className="bcq-card__title">
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
                  <StatusChip>Not generated</StatusChip>
                )}
              </div>
              {o.event ? (
                <div className="bcq-card__row">
                  <span className="bcq-card__meta">
                    {`${o.event.location ?? "No location"} · ${String(o.event.capacity)} spots`}
                  </span>
                  {o.event.status === "scheduled" ? (
                    <Button
                      variant="secondary"
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
                <label className="bcq-check">
                  <input
                    type="checkbox"
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
                  <span>Skip this date</span>
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      {lockBlocked ? (
        <div role="alert" className="bcq-notice">
          <p>
            Passes are already on sale for this series. Buyers were told how many nights they get,
            so change skip-dates only if you must.
          </p>
          <Button variant="danger" disabled={busy} onClick={() => void saveSkips(true)}>
            Save anyway
          </Button>
        </div>
      ) : null}
      <Button variant="secondary" disabled={busy} onClick={() => void saveSkips(false)}>
        Save skip-dates
      </Button>

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
  return (
    <BottomSheet open={event !== null} title="Edit occurrence" onClose={onClose}>
      {event ? <EditForm key={event.id} base={base} event={event} onSaved={onSaved} /> : null}
    </BottomSheet>
  );
}

function EditForm({
  base,
  event,
  onSaved,
}: {
  readonly base: string;
  readonly event: OccurrenceEvent;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
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

  function submit(e: SyntheticEvent) {
    e.preventDefault();
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
    <form className="bcq-form" onSubmit={submit}>
      <TextField label="Location" value={form.location} onChange={set("location")} />
      <TextField
        label="Start time"
        type="time"
        value={form.startTime}
        onChange={set("startTime")}
        hint="Stockholm time. The RSVP close time moves with it."
      />
      <TextField label="Capacity" type="number" value={form.capacity} onChange={set("capacity")} />
      <TextField
        label="Guests per member"
        type="number"
        value={form.guests}
        onChange={set("guests")}
      />
      {blocked ? (
        <div role="alert" className="bcq-notice">
          <p>
            {`That would put the pass cap at ${String(blocked.passCap)}, below the ${String(blocked.passesSold)} passes already sold.`}
          </p>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void save({ ...blocked.changes, overrideCapBelowSold: true })}
          >
            Save anyway
          </Button>
        </div>
      ) : null}
      <Button type="submit" disabled={busy}>
        Save
      </Button>
    </form>
  );
}
