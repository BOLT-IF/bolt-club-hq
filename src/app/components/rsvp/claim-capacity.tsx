import { useId, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import { registerSlot, type SlotProps } from "../../routes/events/slots";
import { Button, ConfirmDialog } from "../ui";
import "./rsvp.css";

interface CapacityResponse {
  readonly capacity: number;
  readonly waitlistedCount: number;
  readonly promotedCount: number;
  readonly offeredCount: number;
}

const ERRORS: Record<string, string> = {
  forbidden: "You don't have permission to change capacity for this event.",
  admin_required: "Only an admin can override confirmed spots.",
  event_read_only: "This event has already ended or been cancelled.",
  invalid_body: "Capacity must be a whole number of at least 1.",
  idempotency_key_in_progress: "Still updating capacity. Try again in a moment.",
};

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "We couldn't update the capacity. Please try again.";
}

/**
 * Organizer/admin capacity control for the event page (`OrganizerToolsSlot`).
 */
export function CapacityPanel({ event, viewer }: SlotProps) {
  const [currentCapacity, setCurrentCapacity] = useState(event.capacity);
  const [draft, setDraft] = useState(String(event.capacity));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overridePrompt, setOverridePrompt] = useState<{
    capacity: number;
    confirmedCount: number;
  } | null>(null);
  const headingId = useId();
  const inputId = useId();

  if (!viewer.canManage || event.readOnly) return null;

  const submit = async (capacity: number, override: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch<CapacityResponse>(
        `/events/${encodeURIComponent(event.id)}/capacity`,
        {
          method: "PATCH",
          body: override ? { capacity, override: true } : { capacity },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      setCurrentCapacity(res.capacity);
      setDraft(String(res.capacity));
      const notes: string[] = [`Capacity updated to ${String(res.capacity)} spots.`];
      if (res.waitlistedCount > 0) {
        notes.push(`${String(res.waitlistedCount)} moved to waitlist.`);
      }
      if (res.promotedCount > 0) {
        notes.push(`${String(res.promotedCount)} promoted from waitlist.`);
      }
      if (res.offeredCount > 0) {
        notes.push(`${String(res.offeredCount)} offered a spot.`);
      }
      setMessage(notes.join(" "));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { error?: string; confirmedCount?: number } | null;
        if (body?.error === "capacity_below_confirmed") {
          setOverridePrompt({
            capacity,
            confirmedCount: body.confirmedCount ?? capacity + 1,
          });
          return;
        }
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bcq-rsvp" aria-labelledby={headingId}>
      <h2 id={headingId} className="bcq-rsvp__title">
        Event capacity
      </h2>
      <p className="bcq-rsvp__hint">Current capacity: {currentCapacity} spots</p>

      <form
        className="bcq-rsvp__form"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = Number(draft);
          if (!Number.isSafeInteger(parsed) || parsed < 1) {
            setError(ERRORS.invalid_body ?? "Capacity must be a whole number of at least 1.");
            return;
          }
          void submit(parsed, false);
        }}
      >
        <label htmlFor={inputId} className="bcq-rsvp__guest">
          <span>New capacity</span>
          <input
            id={inputId}
            type="number"
            min={1}
            step={1}
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
        </label>
        <div className="bcq-rsvp__actions">
          <Button type="submit" variant="secondary" block disabled={busy}>
            Update capacity
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={overridePrompt !== null}
        title="Lower capacity below confirmed?"
        description={
          overridePrompt
            ? `There are ${String(overridePrompt.confirmedCount)} confirmed spots. Lowering capacity to ${String(overridePrompt.capacity)} will move the latest confirmed members to the waitlist and notify them. Only admins can override.`
            : ""
        }
        confirmLabel="Override and lower"
        destructive
        onCancel={() => {
          setOverridePrompt(null);
        }}
        onConfirm={() => {
          const pending = overridePrompt;
          setOverridePrompt(null);
          if (pending) void submit(pending.capacity, true);
        }}
      />

      {message ? <p className="bcq-rsvp__hint">{message}</p> : null}
      {error ? (
        <p role="alert" className="bcq-rsvp__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

registerSlot("OrganizerToolsSlot", CapacityPanel);
