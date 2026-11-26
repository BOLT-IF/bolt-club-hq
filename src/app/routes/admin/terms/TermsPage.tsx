import { useState, type SyntheticEvent } from "react";

import { apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  formatClubYear,
  inferClubYear,
  inferTermSeason,
  type TermSeason,
} from "../../../../domain/club-fee";
import { BottomSheet, Button, EmptyState, StatusChip, useToast } from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import {
  AreaGate,
  BackLink,
  Loaded,
  STATUS_LABEL,
  SelectField,
  TextField,
  errorMessage,
  formatTermPeriod,
  toWhole,
  useLoad,
  type TermRow,
} from "./shared";
import "./terms.css";

function DateRangeFields({
  name,
  starts,
  ends,
  season,
  clubYear,
  onName,
  onStarts,
  onEnds,
  onSeason,
  onClubYear,
}: {
  readonly name: string;
  readonly starts: string;
  readonly ends: string;
  readonly season: string;
  readonly clubYear: string;
  readonly onName: (v: string) => void;
  readonly onStarts: (v: string) => void;
  readonly onEnds: (v: string) => void;
  readonly onSeason: (v: string) => void;
  readonly onClubYear: (v: string) => void;
}) {
  const parsedYear = toWhole(clubYear);
  return (
    <>
      <TextField label="Name" value={name} onChange={onName} required />
      <TextField label="Starts on" type="date" value={starts} onChange={onStarts} required />
      <TextField label="Ends on" type="date" value={ends} onChange={onEnds} required />
      <SelectField
        label="Season"
        value={season}
        onChange={onSeason}
        options={[
          { value: "fall", label: "Fall" },
          { value: "spring", label: "Spring" },
        ]}
      />
      <TextField
        label="Membership year"
        type="number"
        value={clubYear}
        onChange={onClubYear}
        hint={
          parsedYear !== null
            ? `Club year ${formatClubYear(parsedYear)} (Fall ${String(parsedYear)} + Spring ${String(parsedYear + 1)})`
            : "Starting year of the Fall–Spring club year (e.g. 2026 for 2026/2027)"
        }
      />
    </>
  );
}

function inferFromStartsOn(startsOn: string): { season: TermSeason; clubYear: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return null;
  try {
    const season = inferTermSeason(startsOn);
    const clubYear = String(inferClubYear(startsOn, season));
    return { season, clubYear };
  } catch {
    return null;
  }
}

function buildTermPeriodBody(season: string, clubYear: string) {
  const year = toWhole(clubYear);
  return {
    ...(season === "fall" || season === "spring" ? { season } : {}),
    ...(year !== null ? { clubYear: year } : {}),
  };
}

function NewTermForm({ onCreated }: { readonly onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [season, setSeason] = useState<string>("fall");
  const [clubYear, setClubYear] = useState("");
  const [busy, setBusy] = useState(false);

  function handleStartsOn(next: string) {
    setStartsOn(next);
    const inferred = inferFromStartsOn(next);
    if (inferred) {
      setSeason(inferred.season);
      setClubYear(inferred.clubYear);
    }
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/terms", {
        method: "POST",
        body: { name, startsOn, endsOn, ...buildTermPeriodBody(season, clubYear) },
      });
      setName("");
      setStartsOn("");
      setEndsOn("");
      setSeason("fall");
      setClubYear("");
      toast.show("Term created", "success");
      onCreated();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="bcq-form" onSubmit={(e) => void submit(e)}>
      <h2 className="bcq-section-title">New term</h2>
      <DateRangeFields
        name={name}
        starts={startsOn}
        ends={endsOn}
        season={season}
        clubYear={clubYear}
        onName={setName}
        onStarts={handleStartsOn}
        onEnds={setEndsOn}
        onSeason={setSeason}
        onClubYear={setClubYear}
      />
      <Button type="submit" disabled={busy}>
        Create term
      </Button>
    </form>
  );
}

function CloneSheet({
  source,
  onClose,
}: {
  readonly source: TermRow | null;
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [season, setSeason] = useState<string>("fall");
  const [clubYear, setClubYear] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per sheet opening, so a double tap or a retry is one clone.
  const [key, setKey] = useState(newIdempotencyKey);

  function handleStartsOn(next: string) {
    setStartsOn(next);
    const inferred = inferFromStartsOn(next);
    if (inferred) {
      setSeason(inferred.season);
      setClubYear(inferred.clubYear);
    }
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!source) return;
    setBusy(true);
    try {
      const period = buildTermPeriodBody(season, clubYear);
      const body = name.trim()
        ? { name, startsOn, endsOn, ...period }
        : { startsOn, endsOn, ...period };
      const res = await apiFetch<{ term: TermRow }>(`/terms/${source.id}/clone`, {
        method: "POST",
        body,
        idempotencyKey: key,
      });
      toast.show("Term cloned", "success");
      setKey(newIdempotencyKey());
      onClose();
      navigate(`/admin/terms/${res.term.id}`);
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={source !== null} title={`Clone ${source?.name ?? "term"}`} onClose={onClose}>
      <form className="bcq-form" onSubmit={(e) => void submit(e)}>
        <p className="bcq-card__meta">
          Copies the series only. No events, passes, captains or skip-dates come along.
        </p>
        <DateRangeFields
          name={name}
          starts={startsOn}
          ends={endsOn}
          season={season}
          clubYear={clubYear}
          onName={setName}
          onStarts={handleStartsOn}
          onEnds={setEndsOn}
          onSeason={setSeason}
          onClubYear={setClubYear}
        />
        <Button type="submit" disabled={busy}>
          Clone term
        </Button>
      </form>
    </BottomSheet>
  );
}

function tone(status: TermRow["status"]) {
  return status === "active" ? "success" : status === "open_for_passes" ? "info" : "neutral";
}

export function TermsPage() {
  return (
    <AreaGate>
      <TermsList />
    </AreaGate>
  );
}

function TermsList() {
  const load = useLoad<{ terms: TermRow[] }>("/terms");
  const [cloning, setCloning] = useState<TermRow | null>(null);

  return (
    <section className="bcq-page bcq-stack" aria-labelledby="terms-title">
      <BackLink to="/admin">Admin</BackLink>
      <h1 id="terms-title" className="bcq-page__title">
        Terms &amp; series
      </h1>
      <Loaded load={load}>
        {({ terms }) =>
          terms.length === 0 ? (
            <EmptyState title="No terms yet">Create your first term below.</EmptyState>
          ) : (
            <ul className="bcq-list">
              {terms.map((t) => (
                <li key={t.id} className="bcq-card">
                  <div className="bcq-card__row">
                    <a
                      className="bcq-link bcq-card__title"
                      href={`/admin/terms/${t.id}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        navigate(`/admin/terms/${t.id}`);
                      }}
                    >
                      {t.name}
                    </a>
                    <StatusChip tone={tone(t.status)}>{STATUS_LABEL[t.status]}</StatusChip>
                  </div>
                  <p className="bcq-card__meta">
                    {t.startsOn} to {t.endsOn} · {formatTermPeriod(t)} · {t.seriesCount ?? 0} series
                  </p>
                  <Button
                    variant="secondary"
                    aria-label={`Clone ${t.name}`}
                    onClick={() => {
                      setCloning(t);
                    }}
                  >
                    Clone
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <NewTermForm onCreated={load.reload} />
      <CloneSheet
        source={cloning}
        onClose={() => {
          setCloning(null);
        }}
      />
    </section>
  );
}
