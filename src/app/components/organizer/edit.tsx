import { useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import type { SlotProps } from "../../routes/events/slots";
import { Button, ConfirmDialog, StatusChip } from "../ui";
import "./edit.css";

function CalendarIcon() {
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
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
    </svg>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EventEditPanel({ event, viewer }: SlotProps) {
  const [title, setTitle] = useState(event.title);
  const [location, setLocation] = useState(event.location ?? "");
  const [startsLocal, setStartsLocal] = useState(() => toLocalInput(event.startsAt));
  const [endsLocal, setEndsLocal] = useState(() => toLocalInput(event.endsAt));
  const [fee, setFee] = useState(String(event.adhocFee));

  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelledDone, setCancelledDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saveKeyRef = useRef<string>(newIdempotencyKey());
  const cancelKeyRef = useRef<string>(newIdempotencyKey());

  if (!viewer.canManage || event.readOnly || event.status === "cancelled") {
    return null;
  }

  const isClosed = event.status === "closed";
  const feeLocked = isClosed || event.kind === "member_oneoff";

  if (cancelledDone) {
    return (
      <section aria-labelledby="event-edit-heading" className="bcq-event-edit">
        <div className="bcq-event-edit__head">
          <h2 id="event-edit-heading" className="bcq-event-edit__title">
            Manage Event
          </h2>
          <StatusChip tone="danger">Cancelled</StatusChip>
        </div>
        <p className="bcq-event-edit__notice">
          Event cancelled. All charges have been reversed and participants notified.
        </p>
      </section>
    );
  }

  const handleSave = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }

    const nextStarts = new Date(startsLocal);
    const nextEnds = new Date(endsLocal);
    if (Number.isNaN(nextStarts.getTime()) || Number.isNaN(nextEnds.getTime())) {
      setError("Enter valid start and end times.");
      return;
    }
    if (nextEnds <= nextStarts) {
      setError("End time must be after start time.");
      return;
    }

    const parsedFee = Number(fee);
    if (!feeLocked && (!Number.isInteger(parsedFee) || parsedFee < 0)) {
      setError("Fee must be a whole number of kronor (0 or more).");
      return;
    }

    const body: Record<string, unknown> = {
      title: trimmedTitle,
      location: location.trim() === "" ? null : location.trim(),
      startsAt: nextStarts.toISOString(),
      endsAt: nextEnds.toISOString(),
    };
    if (!feeLocked) {
      body.adhocFee = parsedFee;
    }

    setSaving(true);
    try {
      await apiFetch(`/events/${encodeURIComponent(event.id)}/details`, {
        method: "PATCH",
        body,
        idempotencyKey: saveKeyRef.current,
      });
      saveKeyRef.current = newIdempotencyKey();
      setNotice(
        isClosed
          ? "Changes saved. If date, time, or location changed, participants were notified and have 24h to cancel for free."
          : "Changes saved.",
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Fee or event details cannot be changed in the current state.");
      } else if (err instanceof ApiError && err.status === 403) {
        setError("You do not have permission to make that change.");
      } else {
        setError("Could not save changes. Please try again.");
      }
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        saveKeyRef.current = newIdempotencyKey();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEvent = async () => {
    setConfirmCancel(false);
    setCancelling(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/events/${encodeURIComponent(event.id)}/cancel`, {
        method: "POST",
        idempotencyKey: cancelKeyRef.current,
      });
      cancelKeyRef.current = newIdempotencyKey();
      setCancelledDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This event can no longer be cancelled.");
      } else {
        setError("Could not cancel event. Please try again.");
      }
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        cancelKeyRef.current = newIdempotencyKey();
      }
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section aria-labelledby="event-edit-heading" className="bcq-event-edit">
      <div className="bcq-event-edit__head">
        <h2 id="event-edit-heading" className="bcq-event-edit__title">
          Manage Event
        </h2>
        {isClosed ? <StatusChip>Closed</StatusChip> : <StatusChip>Scheduled</StatusChip>}
      </div>

      <form
        className="bcq-event-edit__form"
        onSubmit={(e) => {
          void handleSave(e);
        }}
      >
        <div className="bcq-event-edit__field">
          <label className="bcq-event-edit__label" htmlFor="edit-event-title">
            Title
          </label>
          <input
            id="edit-event-title"
            className="bcq-event-edit__input"
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            maxLength={120}
            required
          />
        </div>

        <div className="bcq-event-edit__field">
          <label className="bcq-event-edit__label" htmlFor="edit-event-location">
            Location
          </label>
          <input
            id="edit-event-location"
            className="bcq-event-edit__input"
            type="text"
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
            }}
            maxLength={200}
            placeholder="Hall or address"
          />
        </div>

        <div className="bcq-event-edit__field">
          <label className="bcq-event-edit__label" htmlFor="edit-event-starts">
            Starts
          </label>
          <div className="bcq-event-edit__picker-wrap">
            <span className="bcq-event-edit__picker-icon" aria-hidden="true">
              <CalendarIcon />
            </span>
            <input
              id="edit-event-starts"
              className="bcq-event-edit__input bcq-event-edit__picker-input"
              type="datetime-local"
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
              }}
              required
            />
          </div>
        </div>

        <div className="bcq-event-edit__field">
          <label className="bcq-event-edit__label" htmlFor="edit-event-ends">
            Ends
          </label>
          <div className="bcq-event-edit__picker-wrap">
            <span className="bcq-event-edit__picker-icon" aria-hidden="true">
              <CalendarIcon />
            </span>
            <input
              id="edit-event-ends"
              className="bcq-event-edit__input bcq-event-edit__picker-input"
              type="datetime-local"
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
              }}
              required
            />
          </div>
        </div>

        <div className="bcq-event-edit__field">
          <label className="bcq-event-edit__label" htmlFor="edit-event-fee">
            Drop-In Fee (kr)
          </label>
          <input
            id="edit-event-fee"
            className="bcq-event-edit__input bcq-tabular-nums"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={fee}
            onChange={(e) => {
              setFee(e.target.value);
            }}
            disabled={feeLocked}
          />
          {isClosed ? (
            <p className="bcq-event-edit__hint">
              Fee cannot change after close. Changing date, time, or location notifies participants
              and opens a 24h free-cancel window.
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="bcq-event-edit__error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="bcq-event-edit__notice" role="status">
            {notice}
          </p>
        ) : null}

        <div className="bcq-event-edit__actions">
          <Button type="submit" block disabled={saving || cancelling}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
          <Button
            type="button"
            variant="destructive-tonal"
            block
            disabled={saving || cancelling}
            onClick={() => {
              setConfirmCancel(true);
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel Event"}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel This Event?"
        description="All charges for this event will be reversed and participants will be notified."
        confirmLabel="Cancel Event"
        destructive
        onConfirm={() => {
          void handleCancelEvent();
        }}
        onCancel={() => {
          setConfirmCancel(false);
        }}
      />
    </section>
  );
}
