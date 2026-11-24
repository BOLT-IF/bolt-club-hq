import { useState } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import { Button, useToast } from "../../../components/ui";
import { useRouteParams } from "../../registry";
import { SeriesForm } from "./SeriesForm";
import {
  AreaGate,
  BackLink,
  Loaded,
  WEEKDAYS,
  errorMessage,
  useLoad,
  type SeriesRow,
} from "./shared";
import "./terms.css";

export function SeriesPage() {
  return (
    <AreaGate>
      <SeriesDetail />
    </AreaGate>
  );
}

interface Blocked {
  readonly changes: Record<string, unknown>;
  readonly passCap: number;
  readonly passesSold: number;
}

function SeriesDetail() {
  const { id = "" } = useRouteParams();
  const path = `/series/${encodeURIComponent(id)}`;
  const load = useLoad<{ series: SeriesRow }>(path);
  const toast = useToast();
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  async function save(changes: Record<string, unknown>) {
    try {
      await apiFetch(path, { method: "PATCH", body: changes });
      setBlocked(null);
      toast.show("Changes saved", "success");
      load.reload();
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as Record<string, unknown>) : null;
      if (body?.error === "cap_below_passes_sold") {
        setBlocked({
          changes,
          passCap: Number(body.passCap),
          passesSold: Number(body.passesSold),
        });
        return;
      }
      toast.show(errorMessage(error), "danger");
      throw error;
    }
  }

  return (
    <section className="bcq-page bcq-stack">
      <Loaded load={load}>
        {({ series }) => (
          <>
            <BackLink to={`/admin/terms/${series.termId}`}>Term</BackLink>
            <h1 className="bcq-page__title">{series.name}</h1>
            <p className="bcq-card__meta">
              {series.format} · {WEEKDAYS[series.weekday - 1]} {series.startTime}
            </p>
            <p>
              Pass cap: <strong>{series.passCap}</strong>
            </p>
            <p className="bcq-card__meta">
              Share link: /s/{series.shareSlug}
              {series.skipDatesLocked ? " · Skip-dates are locked" : ""}
            </p>

            {blocked ? (
              <div role="alert" className="bcq-notice">
                <p>
                  {`That capacity would put the cap at ${String(blocked.passCap)}, below the ${String(blocked.passesSold)} passes already sold.`}
                </p>
                <Button
                  variant="danger"
                  onClick={() => {
                    void save({ ...blocked.changes, overrideCapBelowSold: true }).catch(
                      () => undefined,
                    );
                  }}
                >
                  Save anyway
                </Button>
              </div>
            ) : null}

            <h2 className="bcq-section-title">Details</h2>
            <SeriesForm
              key={JSON.stringify(series)}
              initial={series}
              submitLabel="Save changes"
              onSubmit={save}
            />

            <Captains series={series} onSaved={load.reload} />
          </>
        )}
      </Loaded>
    </section>
  );
}

function Captains({
  series,
  onSaved,
}: {
  readonly series: SeriesRow;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const candidates = useLoad<{ members: Array<{ id: string; displayName: string }> }>(
    "/series/captain-candidates",
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(series.captains.map((c) => c.id)),
  );
  const [busy, setBusy] = useState(false);

  // Only admins can list candidates (and appoint captains); for anyone else the section is hidden.
  if (candidates.error || !candidates.data) return null;

  async function save() {
    setBusy(true);
    try {
      await apiFetch(`/series/${encodeURIComponent(series.id)}/captains`, {
        method: "PUT",
        body: { memberIds: [...picked] },
      });
      toast.show("Captains saved", "success");
      onSaved();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  // Keep API order: existing captains first in the saved list, then in pick order.
  const ordered = candidates.data.members;
  return (
    <fieldset className="bcq-checks">
      <legend className="bcq-section-title">Captains</legend>
      {ordered.map((m) => (
        <label key={m.id} className="bcq-check">
          <input
            type="checkbox"
            checked={picked.has(m.id)}
            onChange={(e) => {
              setPicked((current) => {
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
      <Button disabled={busy} onClick={() => void save()}>
        Save captains
      </Button>
    </fieldset>
  );
}
