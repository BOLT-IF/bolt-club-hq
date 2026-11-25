import { useCallback, useEffect, useId, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import type { EventDetail } from "../../api/events";
import { registerSlot, type SlotProps } from "../../routes/events/slots";
import { Button, StatusChip } from "../ui";
import type { RsvpView } from "./api";
import "./rsvp.css";

interface PostCloseState {
  readonly rsvp: RsvpView | null;
  readonly freeSpots: number;
  readonly waitlistCount: number;
  readonly isPastCutoff: boolean;
}

const ERRORS: Record<string, string> = {
  no_seat: "Someone else claimed that spot just before you.",
  not_offered: "This spot is no longer offered.",
  host_not_confirmed: "You must be confirmed before claiming a spot for your guest.",
  event_ended: "This event has already ended.",
  rsvp_not_closed: "RSVPs have not closed yet.",
  idempotency_key_in_progress: "Still claiming your spot. Try again in a moment.",
};

function isClosedAndEditable(e: EventDetail): boolean {
  if (e.readOnly || e.status === "cancelled" || e.status === "completed") return false;
  return e.status === "closed" || new Date(e.rsvpCloseAt).getTime() <= Date.now();
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code && ERRORS[code]) return ERRORS[code];
  }
  return "We couldn't claim that spot. Please try again.";
}

async function claimSpotRequest(
  eventId: string,
  guestId?: string,
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(`/events/${encodeURIComponent(eventId)}/claim`, {
    method: "POST",
    body: guestId ? { guestId } : {},
    idempotencyKey: key,
  });
  return res.rsvp;
}

/**
 * Claim-a-spot card for the event page (`RsvpSlot`).
 * Renders only when the member or one of their guests has an `offered` spot.
 */
export function ClaimSpotPanel({ event }: SlotProps) {
  const closed = isClosedAndEditable(event);
  const [rsvp, setRsvp] = useState<RsvpView | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimedMessage, setClaimedMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const load = useCallback(async () => {
    const data = await apiFetch<PostCloseState>(
      `/events/${encodeURIComponent(event.id)}/rsvp/postclose`,
    );
    setRsvp(data.rsvp);
  }, [event.id]);

  useEffect(() => {
    if (!closed) return;
    let cancelled = false;
    apiFetch<PostCloseState>(`/events/${encodeURIComponent(event.id)}/rsvp/postclose`)
      .then((data) => {
        if (!cancelled) setRsvp(data.rsvp);
      })
      .catch(() => {
        if (!cancelled) setRsvp(null);
      });
    return () => {
      cancelled = true;
    };
  }, [closed, event.id]);

  if (!closed) return null;

  const memberOffered = rsvp?.status === "offered";
  const offeredGuests = rsvp?.guests.filter((g) => g.status === "offered") ?? [];
  if (!memberOffered && offeredGuests.length === 0 && !claimedMessage) return null;

  const paidEvent = event.kind !== "member_oneoff" && event.adhocFee > 0;

  const handleClaim = async (guestId?: string, guestName?: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await claimSpotRequest(event.id, guestId);
      setRsvp(updated);
      setClaimedMessage(
        guestName ? `Spot claimed for ${guestName}.` : "Spot claimed! You're confirmed.",
      );
    } catch (err) {
      setError(errorText(err));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bcq-rsvp" aria-labelledby={headingId}>
      <h2 id={headingId} className="bcq-rsvp__title">
        Claim offered spot
      </h2>

      {claimedMessage ? (
        <div className="bcq-rsvp__status">
          <StatusChip tone="success">{claimedMessage}</StatusChip>
        </div>
      ) : null}

      {memberOffered ? (
        <div className="bcq-rsvp__actions">
          <p className="bcq-rsvp__hint">
            A spot is available — first to claim gets it.
            {paidEvent && rsvp.tier !== 1
              ? ` Your balance will be charged ${String(event.adhocFee)} kr.`
              : ""}
          </p>
          <Button type="button" block disabled={busy} onClick={() => void handleClaim()}>
            Claim spot
          </Button>
        </div>
      ) : null}

      {offeredGuests.map((g) => (
        <div key={g.id} className="bcq-rsvp__actions">
          <p className="bcq-rsvp__hint">
            A spot is available for your guest {g.name} — first to claim gets it.
            {paidEvent ? ` Your balance will be charged ${String(event.adhocFee)} kr.` : ""}
          </p>
          <Button
            type="button"
            block
            disabled={busy}
            onClick={() => void handleClaim(g.id, g.name)}
          >
            Claim spot for {g.name}
          </Button>
        </div>
      ))}

      {error ? (
        <p role="alert" className="bcq-rsvp__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

registerSlot("RsvpSlot", ClaimSpotPanel);
