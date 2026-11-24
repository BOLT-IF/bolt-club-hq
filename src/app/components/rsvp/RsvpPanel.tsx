import { useEffect, useId, useState } from "react";

import { ApiError } from "../../api/client";
import type { EventDetail } from "../../api/events";
import type { SlotProps } from "../../routes/events/slots";
import { noteRsvpSaved } from "../install";
import { Button, Skeleton, StatusChip, Stepper, type StatusTone } from "../ui";
import { cancelRsvp, getMyRsvp, putRsvp, type RsvpStatus, type RsvpView } from "./api";
import "./rsvp.css";

const LABEL: Record<RsvpStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  waitlisted: "Waitlisted",
  offered: "Spot offered",
  cancelled: "Cancelled",
  late_cancelled: "Cancelled",
};
const TONE: Record<RsvpStatus, StatusTone> = {
  requested: "info",
  confirmed: "success",
  waitlisted: "warning",
  offered: "info",
  cancelled: "neutral",
  late_cancelled: "neutral",
};
const HINT: Partial<Record<RsvpStatus, string>> = {
  requested: "You'll hear when RSVPs close whether you got a spot.",
  confirmed: "You're in.",
  waitlisted: "You're on the waitlist. We'll tell you if a spot opens.",
};
const ERRORS: Record<string, string> = {
  rsvp_closed: "RSVPs for this event have closed.",
  guest_limit: "That's more guests than this event allows.",
  invalid_body: "Please check the guest names.",
  idempotency_key_in_progress: "Still saving your last change. Try again in a moment.",
};

const isActive = (r: RsvpView | null): r is RsvpView =>
  r !== null && r.status !== "cancelled" && r.status !== "late_cancelled";

/** Before close only (S4.2). The server is the authority; this only hides controls. */
function isOpen(e: EventDetail): boolean {
  return e.status === "scheduled" && !e.readOnly && new Date(e.rsvpCloseAt).getTime() > Date.now();
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "We couldn't save your RSVP. Please try again.";
}

type Load = "loading" | "hidden" | "error" | "ready";

/** RSVP panel for the event page (`RsvpSlot`): status, guest stepper, RSVP and cancel. */
export function RsvpPanel({ event }: SlotProps) {
  const [load, setLoad] = useState<Load>("loading");
  const [rsvp, setRsvp] = useState<RsvpView | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const apply = (next: RsvpView | null) => {
    setRsvp(next);
    setNames(isActive(next) ? next.guests.map((g) => g.name) : []);
  };

  useEffect(() => {
    let cancelled = false;
    getMyRsvp(event.id)
      .then((data) => {
        if (cancelled) return;
        apply(data);
        setLoad("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        // Pending, inactive and signed-out viewers cannot RSVP; the page explains why elsewhere.
        setLoad(status === 401 || status === 403 ? "hidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  if (load === "hidden") return null;
  if (load === "loading") return <Skeleton lines={2} label="Loading your RSVP" />;

  const run = async (action: () => Promise<RsvpView>) => {
    setBusy(true);
    setError(null);
    try {
      apply(await action());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const open = isOpen(event);
  const active = isActive(rsvp);
  const maxGuests = event.maxGuestsPerMember;

  return (
    <section className="bcq-rsvp" aria-labelledby={headingId}>
      <h2 id={headingId} className="bcq-rsvp__title">
        Your RSVP
      </h2>

      {load === "error" ? (
        <p role="alert" className="bcq-rsvp__error">
          We couldn&apos;t load your RSVP.
        </p>
      ) : null}

      {active ? (
        <div className="bcq-rsvp__status">
          <StatusChip tone={TONE[rsvp.status]}>{LABEL[rsvp.status]}</StatusChip>
          {HINT[rsvp.status] && open ? <p className="bcq-rsvp__hint">{HINT[rsvp.status]}</p> : null}
        </div>
      ) : null}

      {active && rsvp.guests.length > 0 ? (
        <ul className="bcq-rsvp__guests" aria-label="Your guests">
          {rsvp.guests.map((g) => (
            <li key={g.id}>
              {g.name} <StatusChip tone={TONE[g.status]}>{LABEL[g.status]}</StatusChip>
            </li>
          ))}
        </ul>
      ) : null}

      {!open ? (
        <p className="bcq-rsvp__hint">RSVPs are closed.</p>
      ) : load === "ready" ? (
        <form
          className="bcq-rsvp__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const saved = await putRsvp(event.id, names);
              noteRsvpSaved();
              return saved;
            });
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
            <Button type="submit" block disabled={busy}>
              {active ? "Update RSVP" : "RSVP"}
            </Button>
            {active ? (
              <Button
                variant="secondary"
                block
                disabled={busy}
                onClick={() => {
                  void run(() => cancelRsvp(event.id));
                }}
              >
                Cancel RSVP
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="bcq-rsvp__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
