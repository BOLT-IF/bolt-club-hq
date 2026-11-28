import { useEffect, useId, useRef, useState } from "react";

import { ApiError } from "../../api/client";
import type { EventDetail } from "../../api/events";
import type { SlotProps } from "../../routes/events/slots";
import { noteRsvpSaved } from "../install";
import {
  BottomSheet,
  Button,
  ConfirmDialog,
  Skeleton,
  StatusChip,
  Stepper,
  useToast,
  type StatusTone,
} from "../ui";
import {
  cancelRsvp,
  declineRsvp,
  getMyRsvp,
  isClosedAndEditable,
  putRsvp,
  type RsvpStatus,
  type RsvpView,
} from "./api";
import "./rsvp.css";

const LABEL: Record<RsvpStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  waitlisted: "Waitlisted",
  offered: "Spot offered",
  cancelled: "Cancelled",
  late_cancelled: "Cancelled",
  declined: "Not Going",
};
const TONE: Record<RsvpStatus, StatusTone> = {
  requested: "info",
  confirmed: "success",
  waitlisted: "warning",
  offered: "info",
  cancelled: "neutral",
  late_cancelled: "neutral",
  declined: "neutral",
};
const HINT: Partial<Record<RsvpStatus, string>> = {
  requested: "You'll hear when RSVPs close whether you got a spot.",
  confirmed: "You're in.",
  waitlisted: "You're on the waitlist. We'll tell you if a spot opens.",
  declined: "You're marked as not going and won't get reminders for this event.",
};
const ERRORS: Record<string, string> = {
  rsvp_closed: "RSVPs for this event have closed.",
  guest_limit: "That's more guests than this event allows.",
  invalid_body: "Please check the guest names.",
  idempotency_key_in_progress: "Still saving your last change. Try again in a moment.",
};

const isActive = (r: RsvpView | null): r is RsvpView =>
  r !== null &&
  r.status !== "cancelled" &&
  r.status !== "late_cancelled" &&
  r.status !== "declined";

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
  const toast = useToast();
  const [load, setLoad] = useState<Load>("loading");
  const [rsvp, setRsvp] = useState<RsvpView | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [draftNames, setDraftNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const headingId = useId();
  const updateFormId = useId();
  const quickHandledRef = useRef(false);

  const apply = (next: RsvpView | null) => {
    setRsvp(next);
    setNames(isActive(next) ? next.guests.map((g) => g.name) : []);
  };

  const closedEditable = isClosedAndEditable(event);

  useEffect(() => {
    if (closedEditable) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    getMyRsvp(event.id)
      .then(async (data) => {
        if (isCancelled()) return;
        const params = new URLSearchParams(window.location.search);
        const quick = params.get("quickRsvp");
        if (
          !quickHandledRef.current &&
          (quick === "going" || quick === "decline") &&
          isOpen(event)
        ) {
          quickHandledRef.current = true;
          params.delete("quickRsvp");
          const qs = params.toString();
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
          );
          try {
            if (quick === "going" && !isActive(data)) {
              const saved = await putRsvp(event.id, []);
              if (isCancelled()) return;
              apply(saved);
              noteRsvpSaved();
              setLoad("ready");
              return;
            }
            if (quick === "decline" && data?.status !== "declined") {
              const saved = await declineRsvp(event.id);
              if (isCancelled()) return;
              apply(saved);
              setLoad("ready");
              return;
            }
          } catch (quickErr: unknown) {
            if (isCancelled()) return;
            apply(data);
            setError(errorText(quickErr));
            setLoad("ready");
            return;
          }
        }
        apply(data);
        setLoad("ready");
      })
      .catch((err: unknown) => {
        if (isCancelled()) return;
        const status = err instanceof ApiError ? err.status : 0;
        // Pending, inactive and signed-out viewers cannot RSVP; the page explains why elsewhere.
        setLoad(status === 401 || status === 403 ? "hidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [closedEditable, event]);

  if (closedEditable || load === "hidden") return null;
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
  const declined = rsvp !== null && rsvp.status === "declined";
  const maxGuests = event.maxGuestsPerMember;
  const statusHint =
    rsvp?.status === "confirmed" && rsvp.guests.length > 0
      ? `You're in (${String(rsvp.guests.length)} ${rsvp.guests.length === 1 ? "guest" : "guests"}).`
      : rsvp
        ? HINT[rsvp.status]
        : undefined;

  const resizeNames = (current: string[], nextCount: number) =>
    nextCount > current.length
      ? [...current, ...Array<string>(nextCount - current.length).fill("")]
      : current.slice(0, nextCount);

  return (
    <section className="bcq-rsvp" aria-labelledby={headingId}>
      <div className="bcq-rsvp__head">
        <h2 id={headingId} className="bcq-rsvp__title">
          Your RSVP
        </h2>
        {active || declined ? (
          <StatusChip tone={TONE[rsvp.status]}>{LABEL[rsvp.status]}</StatusChip>
        ) : null}
      </div>

      {load === "error" ? (
        <p role="alert" className="bcq-rsvp__error">
          We couldn&apos;t load your RSVP.
        </p>
      ) : null}

      {(active || declined) && statusHint && open ? (
        <p className="bcq-rsvp__hint">{statusHint}</p>
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
        active ? (
          <div className="bcq-rsvp__actions">
            {maxGuests > 0 ? (
              <Button
                type="button"
                variant="tonal"
                block
                disabled={busy}
                onClick={() => {
                  setDraftNames(rsvp.guests.map((g) => g.name));
                  setSheetError(null);
                  setUpdateOpen(true);
                }}
              >
                Update RSVP
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive-tonal"
              block
              disabled={busy}
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel RSVP
            </Button>
          </div>
        ) : (
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
                    setNames((current) => resizeNames(current, n));
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
                Going
              </Button>
              {!declined ? (
                <Button
                  variant="tonal"
                  block
                  disabled={busy}
                  onClick={() => {
                    void run(() => declineRsvp(event.id));
                  }}
                >
                  Not Going
                </Button>
              ) : null}
            </div>
          </form>
        )
      ) : null}

      <BottomSheet
        open={updateOpen}
        title="Update RSVP"
        onClose={() => {
          if (!busy) setUpdateOpen(false);
        }}
        footer={
          <div className="bcq-rsvp__sheet-footer">
            <Button
              type="button"
              variant="tonal"
              block
              disabled={busy}
              onClick={() => {
                setUpdateOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" form={updateFormId} variant="primary" block disabled={busy}>
              {busy ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        }
      >
        <form
          id={updateFormId}
          className="bcq-rsvp__form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setSheetError(null);
            void putRsvp(event.id, draftNames)
              .then((saved) => {
                apply(saved);
                noteRsvpSaved();
                setUpdateOpen(false);
                toast.show("RSVP updated", "success");
              })
              .catch((err: unknown) => {
                setSheetError(errorText(err));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <div className="bcq-rsvp__field">
            <span className="bcq-rsvp__label" aria-hidden="true">
              Guests (max {maxGuests})
            </span>
            <Stepper
              label="guests"
              value={draftNames.length}
              min={0}
              max={maxGuests}
              onChange={(n) => {
                setDraftNames((current) => resizeNames(current, n));
              }}
            />
            {draftNames.map((name, i) => (
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
                    setDraftNames((current) => current.map((n, j) => (j === i ? value : n)));
                  }}
                />
              </label>
            ))}
          </div>
          {event.adhocFee > 0 ? (
            <p className="bcq-rsvp__fee-summary">
              {draftNames.length > 0
                ? `Guest fee: ${String(draftNames.length)} × ${String(event.adhocFee)} kr = ${String(draftNames.length * event.adhocFee)} kr`
                : `No extra guest fee (${String(event.adhocFee)} kr per guest)`}
            </p>
          ) : null}
          {sheetError ? (
            <p role="alert" className="bcq-rsvp__error">
              {sheetError}
            </p>
          ) : null}
        </form>
      </BottomSheet>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel RSVP?"
        description="Cancelling your RSVP will release your spot for this event."
        cancelLabel="Keep RSVP"
        confirmLabel="Confirm Cancel"
        destructive
        onCancel={() => {
          setConfirmCancel(false);
        }}
        onConfirm={() => {
          setConfirmCancel(false);
          void run(() => cancelRsvp(event.id));
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
