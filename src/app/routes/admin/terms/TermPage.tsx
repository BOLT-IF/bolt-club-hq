import { useState } from "react";

import { apiFetch } from "../../../api/client";
import { ConfirmDialog, StatusChip, useToast } from "../../../components/ui";
import { Button } from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import { useRouteParams } from "../../registry";
import { SeriesForm } from "./SeriesForm";
import {
  AreaGate,
  BackLink,
  Loaded,
  NEXT_STATUS,
  STATUS_LABEL,
  WEEKDAYS,
  errorMessage,
  formatTermPeriod,
  useLoad,
  type SeriesRow,
  type TermRow,
} from "./shared";
import "./terms.css";

export function TermPage() {
  return (
    <AreaGate>
      <TermDetail />
    </AreaGate>
  );
}

function TermDetail() {
  const { id = "" } = useRouteParams();
  const load = useLoad<{ term: TermRow; series: SeriesRow[] }>(`/terms/${encodeURIComponent(id)}`);
  const candidates = useLoad<{ members: Array<{ id: string; displayName: string }> }>(
    "/series/captain-candidates",
  );
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  async function advance(to: string) {
    setConfirming(false);
    try {
      await apiFetch(`/terms/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: to } });
      toast.show("Term updated", "success");
      load.reload();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    }
  }

  return (
    <section className="bcq-page bcq-stack">
      <BackLink to="/admin/terms">Terms &amp; Series</BackLink>
      <Loaded load={load}>
        {({ term, series }) => {
          const next = NEXT_STATUS[term.status];
          const nextLabel = next ? STATUS_LABEL[next] : "";
          return (
            <>
              <div className="bcq-card__row">
                <h1 className="bcq-page__title">{term.name}</h1>
                <StatusChip>{STATUS_LABEL[term.status]}</StatusChip>
              </div>
              <p className="bcq-card__meta">
                {term.startsOn} to {term.endsOn} · {formatTermPeriod(term)}
              </p>
              {next ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  {`Move to ${nextLabel}`}
                </Button>
              ) : null}
              <ConfirmDialog
                open={confirming}
                title={`Move to ${nextLabel}?`}
                description={
                  next === "open_for_passes"
                    ? "Members can buy passes once the term is open. Skip-dates lock for every series in this term. This cannot be undone."
                    : "A term only moves forward. This cannot be undone."
                }
                confirmLabel={nextLabel}
                onConfirm={() => {
                  if (next) void advance(next);
                }}
                onCancel={() => {
                  setConfirming(false);
                }}
              />

              <h2 className="bcq-section-title">Series</h2>
              {series.length === 0 ? (
                <p className="bcq-card__meta">No series yet.</p>
              ) : (
                <ul className="bcq-list">
                  {series.map((s) => (
                    <li key={s.id} className="bcq-card">
                      <a
                        className="bcq-link bcq-card__title"
                        href={`/admin/terms/series/${s.id}`}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          navigate(`/admin/terms/series/${s.id}`);
                        }}
                      >
                        {s.name}
                      </a>
                      <p className="bcq-card__meta">
                        {s.format} · {WEEKDAYS[s.weekday - 1]} {s.startTime} · {s.capacity} places
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {term.status === "closed" ? null : (
                <div className="bcq-card">
                  <h2 className="bcq-section-title">Add a Series</h2>
                  <SeriesForm
                    submitLabel="Add Series"
                    eligibleCandidates={candidates.data?.members ?? []}
                    onSubmit={async (changes) => {
                      try {
                        await apiFetch("/series", {
                          method: "POST",
                          body: { termId: term.id, ...changes },
                        });
                        toast.show("Series added", "success");
                        load.reload();
                      } catch (error) {
                        toast.show(errorMessage(error), "danger");
                        throw error;
                      }
                    }}
                  />
                </div>
              )}
            </>
          );
        }}
      </Loaded>
    </section>
  );
}
