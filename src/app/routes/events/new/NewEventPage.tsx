import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { Button, ErrorState, Skeleton } from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import { stockholmToUtc } from "./stockholm";
import "./new.css";

const FORMATS = [
  ["open", "Open play"],
  ["mixed", "Mixed"],
  ["MD", "Men's doubles"],
  ["WD", "Women's doubles"],
  ["XD", "Mixed doubles"],
] as const;

interface Options {
  readonly canSetFee: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && typeof error.body === "object" && error.body !== null) {
    const message = (error.body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "We couldn't create the event. Please try again.";
}

export function NewEventPage() {
  const [options, setOptions] = useState<Options | "loading" | "error">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per filled-in form, so a double tap or a retry after a timeout creates one event.
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    let cancelled = false;
    apiFetch<Options>("/events/oneoff/options")
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .catch(() => {
        if (!cancelled) setOptions("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (options === "loading") return <Skeleton label="Loading" />;
  if (options === "error") return <ErrorState>We couldn&apos;t open the event form.</ErrorState>;

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => {
      const value = f.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const date = text("date");
    const body: Record<string, unknown> = {
      title: text("title"),
      location: text("location") || null,
      format: text("format"),
      startsAt: stockholmToUtc(date, text("start")),
      endsAt: stockholmToUtc(date, text("end")),
      capacity: Number(text("capacity")),
      maxGuestsPerMember: Number(text("guests")),
    };
    if (options !== "loading" && options !== "error" && options.canSetFee) {
      body.adhocFee = Number(text("fee") || "0");
      body.allocationMode = f.get("tiered") === "on" ? "tiered" : "instant";
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ event: { slug: string } }>("/events", {
        method: "POST",
        body,
        idempotencyKey: key.current,
      });
      navigate(`/events/${res.event.slug}`);
    } catch (err) {
      // A rejected form gets a fresh key so the corrected one is a new request.
      key.current = newIdempotencyKey();
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <form className="bcq-form" aria-labelledby="new-event-title" onSubmit={(e) => void onSubmit(e)}>
      <h1 id="new-event-title" className="bcq-page__title">
        New event
      </h1>
      {options.canSetFee ? null : (
        <p className="bcq-form__hint">Member events are free and first-come.</p>
      )}

      <label className="bcq-form__field">
        Title
        <input name="title" required maxLength={80} autoComplete="off" />
      </label>
      <label className="bcq-form__field">
        Location (optional)
        <input name="location" maxLength={120} autoComplete="off" />
      </label>
      <label className="bcq-form__field">
        Format
        <select name="format" defaultValue="open">
          {FORMATS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="bcq-form__field">
        Date
        <input name="date" type="date" required />
      </label>
      <div className="bcq-form__row">
        <label className="bcq-form__field">
          Start
          <input name="start" type="time" required />
        </label>
        <label className="bcq-form__field">
          End
          <input name="end" type="time" required />
        </label>
      </div>
      <div className="bcq-form__row">
        <label className="bcq-form__field">
          Spots
          <input name="capacity" type="number" inputMode="numeric" min={1} step={1} required />
        </label>
        <label className="bcq-form__field">
          Guests per member
          <input
            name="guests"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            defaultValue={1}
            required
          />
        </label>
      </div>
      {options.canSetFee ? (
        <>
          <label className="bcq-form__field">
            Fee in kr (0 for free)
            <input name="fee" type="number" inputMode="numeric" min={0} step={1} defaultValue={0} />
          </label>
          <label className="bcq-form__check">
            <input name="tiered" type="checkbox" defaultChecked />
            Tiered allocation: members first, then guests, when RSVP closes
          </label>
        </>
      ) : null}
      <p className="bcq-form__hint">RSVP closes 24 hours before the start.</p>

      {error ? (
        <p className="bcq-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" block disabled={submitting}>
        {submitting ? "Creating…" : "Create event"}
      </Button>
    </form>
  );
}
