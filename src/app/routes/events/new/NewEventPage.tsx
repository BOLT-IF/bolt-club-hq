import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { Button, ErrorState, Skeleton } from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import { stockholmToUtc } from "./stockholm";
import "./new.css";

const FORMATS = [
  "Men's Doubles",
  "Mixed Doubles",
  "Women's Doubles",
  "Singles",
  "Training",
  "Open",
] as const;

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

function ClockIcon() {
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
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

interface SeriesOption {
  readonly id: string;
  readonly name: string;
  readonly termName?: string;
}

interface MemberOption {
  readonly id: string;
  readonly displayName: string;
}

interface Options {
  readonly canSetFee: boolean;
  readonly series?: readonly SeriesOption[];
  readonly members?: readonly MemberOption[];
}

type AudienceKind = "all" | "series" | "members";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && typeof error.body === "object" && error.body !== null) {
    const message = (error.body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "We couldn't create the event. Please try again.";
}

export function NewEventPage() {
  const [options, setOptions] = useState<Options | "loading" | "error">("loading");
  const [eventScope, setEventScope] = useState<"club" | "member">("club");
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("all");
  const [audienceSeriesId, setAudienceSeriesId] = useState("");
  const [pickedMembers, setPickedMembers] = useState<ReadonlySet<string>>(() => new Set());
  const [dateValue, setDateValue] = useState("");
  const [startValue, setStartValue] = useState("");
  const [endValue, setEndValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per filled-in form, so a double tap or a retry after a timeout creates one event.
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    let cancelled = false;
    apiFetch<Options>("/events/oneoff/options")
      .then((o) => {
        if (cancelled) return;
        setOptions(o);
        setEventScope(o.canSetFee ? "club" : "member");
        if (o.series && o.series.length > 0 && o.series[0]) {
          setAudienceSeriesId(o.series[0].id);
        }
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

  const isClubEvent = options.canSetFee && eventScope === "club";
  const seriesOptions = options.series ?? [];
  const memberOptions = options.members ?? [];

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (options === "loading" || options === "error") return;
    const f = new FormData(e.currentTarget);
    const text = (name: string) => {
      const value = f.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const date = text("date");
    const feeRaw = text("fee");
    const fee = feeRaw === "" ? 0 : Number(feeRaw);

    const body: Record<string, unknown> = {
      title: text("title"),
      location: text("location") || null,
      format: text("format"),
      startsAt: stockholmToUtc(date, text("start")),
      endsAt: stockholmToUtc(date, text("end")),
      capacity: Number(text("capacity")),
      maxGuestsPerMember: Number(text("guests")),
    };

    if (options.canSetFee) {
      body.eventScope = eventScope;
      body.adhocFee = fee;
      if (isClubEvent) {
        body.allocationMode = f.get("tiered") === "on" ? "tiered" : "instant";
      }
    } else if (fee > 0) {
      body.adhocFee = fee;
    }

    if (audienceKind === "series") {
      body.audienceKind = "series";
      body.audienceSeriesId = audienceSeriesId;
    } else if (audienceKind === "members") {
      if (pickedMembers.size === 0) {
        setError("Pick at least one eligible member.");
        return;
      }
      body.audienceKind = "members";
      body.eligibleMemberIds = [...pickedMembers];
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
    <section aria-labelledby="new-event-title" className="bcq-new-event-page">
      <h1 id="new-event-title" className="bcq-page__title">
        New Event
      </h1>
      <form className="bcq-new-event-form" onSubmit={(e) => void onSubmit(e)}>
        <div className="bcq-new-event-section">
          <h2 className="bcq-new-event-subheader">Event Details</h2>
          <div className="bcq-card bcq-form bcq-new-event-card">
            {options.canSetFee ? (
              <label className="bcq-form__field">
                Event Type
                <select
                  name="eventScope"
                  value={eventScope}
                  onChange={(e) => {
                    setEventScope(e.target.value === "member" ? "member" : "club");
                  }}
                >
                  <option value="club">Club Event (Billed via BOLT HQ)</option>
                  <option value="member">Member-Organized (Settled Outside App)</option>
                </select>
              </label>
            ) : (
              <p className="bcq-form__hint">
                Member-organized events confirm right away (first-come). Any cost is settled
                directly with you, outside BOLT HQ.
              </p>
            )}

            <label className="bcq-form__field">
              Title
              <input
                name="title"
                required
                maxLength={80}
                autoComplete="off"
                placeholder="e.g., Friday Night Doubles"
              />
            </label>
            <label className="bcq-form__field">
              Location (Optional)
              <input
                name="location"
                maxLength={120}
                autoComplete="off"
                placeholder="e.g., Sollentuna Rackethall"
              />
            </label>
            <label className="bcq-form__field">
              Format
              <select name="format" defaultValue="Men's Doubles">
                {FORMATS.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="bcq-new-event-section">
          <h2 className="bcq-new-event-subheader">Schedule &amp; Pricing</h2>
          <div className="bcq-card bcq-form bcq-new-event-card">
            <label className="bcq-form__field">
              Date
              <span className="bcq-picker-wrap">
                <span className="bcq-picker-wrap__icon" aria-hidden="true">
                  <CalendarIcon />
                </span>
                {dateValue === "" ? (
                  <span className="bcq-picker-placeholder" aria-hidden="true">
                    Select date
                  </span>
                ) : null}
                <input
                  className={
                    dateValue === ""
                      ? "bcq-picker-input bcq-picker-input--empty"
                      : "bcq-picker-input"
                  }
                  name="date"
                  type="date"
                  value={dateValue}
                  onChange={(e) => {
                    setDateValue(e.target.value);
                  }}
                  required
                />
              </span>
            </label>
            <div className="bcq-form__row">
              <label className="bcq-form__field">
                Start
                <span className="bcq-picker-wrap">
                  <span className="bcq-picker-wrap__icon" aria-hidden="true">
                    <ClockIcon />
                  </span>
                  {startValue === "" ? (
                    <span className="bcq-picker-placeholder" aria-hidden="true">
                      19:00
                    </span>
                  ) : null}
                  <input
                    className={
                      startValue === ""
                        ? "bcq-picker-input bcq-picker-input--empty"
                        : "bcq-picker-input"
                    }
                    name="start"
                    type="time"
                    value={startValue}
                    onChange={(e) => {
                      setStartValue(e.target.value);
                    }}
                    required
                  />
                </span>
              </label>
              <label className="bcq-form__field">
                End
                <span className="bcq-picker-wrap">
                  <span className="bcq-picker-wrap__icon" aria-hidden="true">
                    <ClockIcon />
                  </span>
                  {endValue === "" ? (
                    <span className="bcq-picker-placeholder" aria-hidden="true">
                      21:00
                    </span>
                  ) : null}
                  <input
                    className={
                      endValue === ""
                        ? "bcq-picker-input bcq-picker-input--empty"
                        : "bcq-picker-input"
                    }
                    name="end"
                    type="time"
                    value={endValue}
                    onChange={(e) => {
                      setEndValue(e.target.value);
                    }}
                    required
                  />
                </span>
              </label>
            </div>
            <div className="bcq-form__row">
              <label className="bcq-form__field">
                Spots
                <input
                  className="bcq-tabular-nums"
                  name="capacity"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  placeholder="e.g., 16"
                  required
                />
              </label>
              <label className="bcq-form__field">
                Guests Per Member
                <input
                  className="bcq-tabular-nums"
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

            {isClubEvent ? (
              <>
                <label className="bcq-form__field">
                  Club Fee in kr (0 for Free)
                  <input
                    className="bcq-tabular-nums"
                    name="fee"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    defaultValue={0}
                  />
                </label>
                <label className="bcq-form__check">
                  <input name="tiered" type="checkbox" defaultChecked />
                  <span>Tiered allocation: members first, then guests, when RSVP closes</span>
                </label>
                <p className="bcq-form__hint">
                  Events starting within 24 hours confirm right away (first-come). Paid immediate
                  events charge on confirmation and follow late-cancel rules.
                </p>
              </>
            ) : (
              <label className="bcq-form__field">
                Estimated Cost in kr (Optional, Settled Outside App)
                <input
                  className="bcq-tabular-nums"
                  name="fee"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  defaultValue={0}
                />
              </label>
            )}

            {seriesOptions.length > 0 || memberOptions.length > 0 ? (
              <div className="bcq-form__group">
                <label className="bcq-form__field">
                  Who Can Join &amp; Get Notified
                  <select
                    name="audienceKind"
                    value={audienceKind}
                    onChange={(e) => {
                      setAudienceKind(e.target.value as AudienceKind);
                    }}
                  >
                    <option value="all">Everyone (All Active Members)</option>
                    {seriesOptions.length > 0 ? (
                      <option value="series">Series Pass Holders</option>
                    ) : null}
                    {memberOptions.length > 0 ? (
                      <option value="members">Specific Members</option>
                    ) : null}
                  </select>
                </label>

                {audienceKind === "series" && seriesOptions.length > 0 ? (
                  <label className="bcq-form__field">
                    Series Group
                    <select
                      name="audienceSeriesId"
                      value={audienceSeriesId}
                      onChange={(e) => {
                        setAudienceSeriesId(e.target.value);
                      }}
                    >
                      {seriesOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.termName ? `${s.name} (${s.termName})` : s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {audienceKind === "members" && memberOptions.length > 0 ? (
                  <fieldset className="bcq-form__checks">
                    <legend className="bcq-form__field">Eligible Members</legend>
                    {memberOptions.map((m) => (
                      <label key={m.id} className="bcq-form__check">
                        <input
                          type="checkbox"
                          checked={pickedMembers.has(m.id)}
                          onChange={(e) => {
                            setPickedMembers((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(m.id);
                              else next.delete(m.id);
                              return next;
                            });
                          }}
                        />
                        <span>{m.displayName}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="bcq-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" block disabled={submitting}>
          {submitting ? "Creating…" : "Create Event"}
        </Button>
      </form>
    </section>
  );
}
