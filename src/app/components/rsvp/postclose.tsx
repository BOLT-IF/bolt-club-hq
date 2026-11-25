import { useCallback, useEffect, useId, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import type { EventDetail } from "../../api/events";
import { registerSlot, type SlotProps } from "../../routes/events/slots";
import { Button, ConfirmDialog, Skeleton, StatusChip, Stepper, type StatusTone } from "../ui";
import type { RsvpStatus, RsvpView } from "./api";
import "./rsvp.css";

interface PostCloseState {
  readonly rsvp: RsvpView | null;
  readonly freeSpots: number;
  readonly waitlistCount: number;
  readonly isPastCutoff: boolean;
}

const LABEL: Record<RsvpStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  waitlisted: "Waitlisted",
  offered: "Spot offered",
  cancelled: "Cancelled",
  late_cancelled: "Late cancelled",
};

const TONE: Record<RsvpStatus, StatusTone> = {
  requested: "info",
  confirmed: "success",
  waitlisted: "warning",
  offered: "info",
  cancelled: "neutral",
  late_cancelled: "neutral",
};

const ERRORS: Record<string, string> = {
  rsvp_not_closed: "RSVPs have not closed yet.",
  event_ended: "This event has already ended.",
  guest_limit: "That's more guests than this event allows.",
  invalid_body: "Please check the guest names.",
  no_active_rsvp: "You don't have an active RSVP to cancel.",
  idempotency_key_in_progress: "Still saving your last change. Try again in a moment.",
};

const isActive = (r: RsvpView | null): r is RsvpView =>
  r !== null && r.status !== "cancelled" && r.status !== "late_cancelled";

function isClosedAndEditable(e: EventDetail): boolean {
  if (e.readOnly || e.status === "cancelled" || e.status === "completed") return false;
  return e.status === "closed" || new Date(e.rsvpCloseAt).getTime() <= Date.now();
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "We couldn't update your RSVP. Please try again.";
}

async function fetchPostClose(eventId: string): Promise<PostCloseState> {
  return apiFetch<PostCloseState>(`/events/${encodeURIComponent(eventId)}/rsvp/postclose`);
}

async function putLate(
  eventId: string,
  guests: readonly string[],
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(
    `/events/${encodeURIComponent(eventId)}/rsvp/late`,
    { method: "PUT", body: { guests }, idempotencyKey: key },
  );
  return res.rsvp;
}

async function postLateCancel(
  eventId: string,
  guestId?: string,
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(
    `/events/${encodeURIComponent(eventId)}/rsvp/late-cancel`,
    {
      method: "POST",
      body: guestId ? { guestId } : {},
      idempotencyKey: key,
    },
  );
  return res.rsvp;
}

type Load = "loading" | "hidden" | "error" | "ready";

/** Post-close RSVP controls for the event page (`RsvpSlot`): late RSVP, guest edits, late cancel. */
export function PostCloseRsvpPanel({ event }: SlotProps) {
  const closed = isClosedAndEditable(event);
  const [load, setLoad] = useState<Load>(closed ? "loading" : "hidden");
  const [state, setState] = useState<PostCloseState | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const apply = useCallback((next: PostCloseState) => {
    setState(next);
    setNames(isActive(next.rsvp) ? next.rsvp.guests.map((g) => g.name) : []);
  }, []);

  const refresh = useCallback(async () => {
    const data = await fetchPostClose(event.id);
    apply(data);
  }, [apply, event.id]);

  useEffect(() => {
    if (!closed) return;
    let cancelled = false;
    fetchPostClose(event.id)
      .then((data) => {
        if (cancelled) return;
        apply(data);
        setLoad("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        setLoad(status === 401 || status === 403 ? "hidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [apply, closed, event.id]);

  if (!closed || load === "hidden") return null;
  if (load === "loading") return <Skeleton lines={2} label="Loading late RSVP options" />;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const rsvp = state?.rsvp ?? null;
  const active = isActive(rsvp);
  const freeSpots = state?.freeSpots ?? 0;
  const waitlistCount = state?.waitlistCount ?? 0;
  const maxGuests = event.maxGuestsPerMember;
  const paidEvent = event.kind !== "member_oneoff" && event.adhocFee > 0;

  return (
    <section className="bcq-rsvp" aria-labelledby={headingId}>
      <h2 id={headingId} className="bcq-rsvp__title">
        Late RSVP &amp; changes
      </h2>

      {load === "error" ? (
        <p role="alert" className="bcq-rsvp__error">
          We couldn&apos;t load late RSVP options.
        </p>
      ) : null}

      {state ? (
        <p className="bcq-rsvp__hint">
          {freeSpots > 0
            ? `${String(freeSpots)} ${freeSpots === 1 ? "spot" : "spots"} free`
            : `Event is full${waitlistCount > 0 ? ` (${String(waitlistCount)} on waitlist)` : ""}`}
        </p>
      ) : null}

      {rsvp ? (
        <div className="bcq-rsvp__status">
          <StatusChip tone={TONE[rsvp.status]}>{LABEL[rsvp.status]}</StatusChip>
        </div>
      ) : null}

      {load === "ready" ? (
        <form
          className="bcq-rsvp__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => putLate(event.id, names));
          }}
        >
          {maxGuests > 0 ? (
            <div className="bcq-rsvp__field">
              <span className="bcq-rsvp__label" aria-hidden="true">
                Guests (max {maxGuests})
              </span>
              <Stepper
                label="guests"
                value={names.length}
                min={0}
                max={maxGuests}
                onChange={(n) => {
                  setNames((current) =>
                    n > current.length
                      ? [...current, ...Array<string>(n - current.length).fill("")]
                      : current.slice(0, n),
                  );
                }}
              />
              {names.map((name, i) => (
                <label key={i} className="bcq-rsvp__guest">
                  <span>Guest {i + 1} name</span>
                  <input
                    type="text"
                    value={name}
                    maxLength={60}
                    autoComplete="off"
                    placeholder="Guest"
                    onChange={(e) => {
                      const value = e.target.value;
                      setNames((current) => current.map((n, j) => (j === i ? value : n)));
                    }}
                  />
                </label>
              ))}
            </div>
          ) : null}

          <div className="bcq-rsvp__actions">
            {!active ? (
              <Button type="submit" block disabled={busy}>
                {freeSpots > 0 && waitlistCount === 0 ? "Join late" : "Join waitlist"}
              </Button>
            ) : (
              <>
                {maxGuests > 0 ? (
                  <Button type="submit" block disabled={busy}>
                    Save guests
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  block
                  disabled={busy}
                  onClick={() => {
                    if (rsvp.status === "confirmed") {
                      setConfirmCancel(true);
                    } else {
                      void run(() => postLateCancel(event.id));
                    }
                  }}
                >
                  {rsvp.status === "confirmed" ? "Late cancel" : "Leave waitlist"}
                </Button>
              </>
            )}
          </div>
        </form>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        title="Late cancel RSVP?"
        description={[
          paidEvent
            ? `Your ${String(event.adhocFee)} kr charge stands unless your spot is refilled.`
            : "Your spot will be given to the next person.",
          rsvp && rsvp.guests.length > 0 ? "Your guests will also be cancelled." : "",
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel="Confirm late cancel"
        destructive
        onCancel={() => {
          setConfirmCancel(false);
        }}
        onConfirm={() => {
          setConfirmCancel(false);
          void run(() => postLateCancel(event.id));
        }}
      />

      {error ? (
        <p role="alert" className="bcq-rsvp__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

registerSlot("RsvpSlot", PostCloseRsvpPanel);
