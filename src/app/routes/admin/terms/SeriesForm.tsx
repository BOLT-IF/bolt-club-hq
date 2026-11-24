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
  return out;
}

export function SeriesForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  readonly initial?: SeriesRow;
  readonly submitLabel: string;
  /** Receives only the changed fields (all of them when creating). Throw to keep the form. */
  readonly onSubmit: (changes: Record<string, unknown>) => Promise<void>;
}) {
  const base = initial ? fromSeries(initial) : EMPTY;
  const [form, setForm] = useState<FormState>(base);
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
    if (initial && Object.keys(changes).length === 0) {
      setProblem("Nothing to save yet.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      await onSubmit(changes);
      if (!initial) setForm(EMPTY);
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
