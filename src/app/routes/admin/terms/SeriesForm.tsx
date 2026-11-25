import { useState, type SyntheticEvent } from "react";

import { Button } from "../../../components/ui";
import { FORMATS, SelectField, TextField, WEEKDAYS, toWhole, type SeriesRow } from "./shared";

export type SeriesValues = Pick<
  SeriesRow,
  | "name"
  | "format"
  | "weekday"
  | "startTime"
  | "durationMin"
  | "location"
  | "capacity"
  | "passPrice"
  | "adhocFee"
  | "maxGuestsDefault"
  | "rsvpCloseOffsetMin"
>;

interface FormState {
  name: string;
  format: string;
  weekday: string;
  startTime: string;
  durationMin: string;
  location: string;
  capacity: string;
  passPrice: string;
  discountedPassPrice: string;
  adhocFee: string;
  maxGuestsDefault: string;
  rsvpCloseOffsetMin: string;
}

const EMPTY: FormState = {
  name: "",
  format: "open",
  weekday: "1",
  startTime: "",
  durationMin: "",
  location: "",
  capacity: "",
  passPrice: "",
  discountedPassPrice: "",
  adhocFee: "",
  maxGuestsDefault: "1",
  rsvpCloseOffsetMin: "1440",
};

function fromSeries(s: SeriesRow): FormState {
  return {
    name: s.name,
    format: s.format,
    weekday: String(s.weekday),
    startTime: s.startTime,
    durationMin: String(s.durationMin),
    location: s.location ?? "",
    capacity: String(s.capacity),
    passPrice: String(s.passPrice),
    discountedPassPrice: s.discountedPassPrice === null ? "" : String(s.discountedPassPrice),
    adhocFee: String(s.adhocFee),
    maxGuestsDefault: String(s.maxGuestsDefault),
    rsvpCloseOffsetMin: String(s.rsvpCloseOffsetMin),
  };
}

/** The fields whose value differs from `base`, as an API body (whole kronor, whole minutes). */
function diff(form: FormState, base: FormState): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const numeric = [
    "weekday",
    "durationMin",
    "capacity",
    "passPrice",
    "adhocFee",
    "maxGuestsDefault",
    "rsvpCloseOffsetMin",
  ] as const;
  for (const key of ["name", "format", "startTime"] as const) {
    if (form[key] !== base[key]) out[key] = form[key].trim();
  }
  if (form.location !== base.location) out.location = form.location.trim() || null;
  for (const key of numeric) {
    if (form[key] === base[key]) continue;
    const n = toWhole(form[key]);
    if (n === null) return null;
    out[key] = n;
  }
  if (form.discountedPassPrice !== base.discountedPassPrice) {
    const trimmed = form.discountedPassPrice.trim();
    if (trimmed === "") {
      out.discountedPassPrice = null;
    } else {
      const n = toWhole(trimmed);
      if (n === null) return null;
      out.discountedPassPrice = n;
    }
  }
  return out;
}

export function SeriesForm({
  initial,
  submitLabel,
  eligibleCandidates,
  onSubmit,
}: {
  readonly initial?: SeriesRow;
  readonly submitLabel: string;
  readonly eligibleCandidates?: ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
  }>;
  /** Receives only the changed fields (all of them when creating). Throw to keep the form. */
  readonly onSubmit: (changes: Record<string, unknown>) => Promise<void>;
}) {
  const base = initial ? fromSeries(initial) : EMPTY;
  const [form, setForm] = useState<FormState>(base);
  const [pickedEligible, setPickedEligible] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof FormState) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    const changes = diff(form, base);
    if (changes === null) {
      setProblem("Prices, capacity and times must be whole numbers.");
      return;
    }
    const effectivePassPrice = toWhole(form.passPrice);
    const effectiveDiscount =
      form.discountedPassPrice.trim() === "" ? null : toWhole(form.discountedPassPrice);
    if (
      effectivePassPrice !== null &&
      effectiveDiscount !== null &&
      effectiveDiscount > effectivePassPrice
    ) {
      setProblem("Discounted pass price cannot be higher than the regular pass price.");
      return;
    }
    if (initial && Object.keys(changes).length === 0) {
      setProblem("Nothing to save yet.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const payload =
        !initial && pickedEligible.size > 0
          ? { ...changes, discountEligibleIds: [...pickedEligible] }
          : changes;
      await onSubmit(payload);
      if (!initial) {
        setForm(EMPTY);
        setPickedEligible(new Set());
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="bcq-form" onSubmit={(e) => void submit(e)} noValidate={false}>
      <TextField label="Name" value={form.name} onChange={set("name")} required />
      <SelectField
        label="Format"
        value={form.format}
        onChange={set("format")}
        options={FORMATS.map((f) => ({ value: f, label: f }))}
      />
      <SelectField
        label="Weekday"
        value={form.weekday}
        onChange={set("weekday")}
        options={WEEKDAYS.map((label, i) => ({ value: String(i + 1), label }))}
      />
      <TextField
        label="Start time"
        type="time"
        value={form.startTime}
        onChange={set("startTime")}
        required
      />
      <TextField
        label="Duration (minutes)"
        type="number"
        value={form.durationMin}
        onChange={set("durationMin")}
        required
      />
      <TextField label="Location" value={form.location} onChange={set("location")} />
      <TextField
        label="Capacity"
        type="number"
        value={form.capacity}
        onChange={set("capacity")}
        required
      />
      <TextField
        label="Pass price (kr)"
        type="number"
        value={form.passPrice}
        onChange={set("passPrice")}
        required
      />
      <TextField
        label="Discounted pass price (kr, optional)"
        type="number"
        value={form.discountedPassPrice}
        onChange={set("discountedPassPrice")}
      />
      {!initial && eligibleCandidates && eligibleCandidates.length > 0 ? (
        <fieldset className="bcq-checks">
          <legend className="bcq-field__label">Eligible for discounted rate</legend>
          {eligibleCandidates.map((m) => (
            <label key={m.id} className="bcq-check">
              <input
                type="checkbox"
                checked={pickedEligible.has(m.id)}
                onChange={(e) => {
                  setPickedEligible((current) => {
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
      <TextField
        label="Drop-in fee (kr)"
        type="number"
        value={form.adhocFee}
        onChange={set("adhocFee")}
        required
      />
      <TextField
        label="Guests per member"
        type="number"
        value={form.maxGuestsDefault}
        onChange={set("maxGuestsDefault")}
      />
      <TextField
        label="RSVP closes (minutes before start)"
        type="number"
        value={form.rsvpCloseOffsetMin}
        onChange={set("rsvpCloseOffsetMin")}
      />
      {problem ? (
        <p role="status" className="bcq-field__hint">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
