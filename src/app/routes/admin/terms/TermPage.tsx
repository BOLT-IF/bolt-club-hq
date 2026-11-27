import { useState } from "react";

import { apiFetch } from "../../../api/client";
import {
  Button,
  ChevronRightIcon,
  CompactEmptyState,
  ConfirmDialog,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import { useRouteParams } from "../../registry";
import { SeriesFormSheet } from "./SeriesForm";
import {
  AreaGate,
  CalendarIcon,
  FORMAT_LABEL,
  Loaded,
  NEXT_STATUS,
  PlusIcon,
  STATUS_LABEL,
  WEEKDAYS,
  errorMessage,
  formatDateRange,
  formatTermPeriod,
  useLoad,
  type SeriesRow,
  type TermRow,
  type TermStatus,
} from "./shared";
import "./terms.css";

function termStatusTone(status: TermStatus): StatusTone {
  if (status === "active") return "success";
  if (status === "open_for_passes") return "sky";
  return "neutral";
}

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
  const [addOpen, setAddOpen] = useState(false);

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
      <Loaded load={load}>
        {({ term, series }) => {
          const next = NEXT_STATUS[term.status];
          const nextLabel = next ? STATUS_LABEL[next] : "";
          return (
            <>
              <div>
                <div className="bcq-card__row">
                  <h1 className="bcq-page__title">{term.name}</h1>
                  <StatusChip tone={termStatusTone(term.status)}>
                    {STATUS_LABEL[term.status]}
                  </StatusChip>
                </div>
                <p className="bcq-card__meta" style={{ marginTop: "0.35rem" }}>
                  {formatDateRange(term.startsOn, term.endsOn)} · {formatTermPeriod(term)}
                </p>
              </div>

              {next ? (
                <Button
                  variant="tonal"
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

              <div className="bcq-terms-sec-head">
                <h2 className="bcq-terms-sec-label">Series</h2>
                {term.status === "closed" ? null : (
                  <Button
                    variant="primary"
                    className="bcq-btn--compact"
                    onClick={() => {
                      setAddOpen(true);
                    }}
                  >
                    <PlusIcon />
                    <span>Add Series</span>
                  </Button>
                )}
              </div>

              {series.length === 0 ? (
                <CompactEmptyState title="No Series Yet" icon={<CalendarIcon size={18} />}>
                  Add a series to schedule weekly sessions and passes
                </CompactEmptyState>
              ) : (
                <ul className="bcq-list">
                  {series.map((s) => (
                    <li key={s.id}>
                      <a
                        className="bcq-series-row"
                        href={`/admin/terms/series/${s.id}`}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          navigate(`/admin/terms/series/${s.id}`);
                        }}
                      >
                        <span className="bcq-series-row__body">
                          <span className="bcq-series-row__title">{s.name}</span>
                          <span className="bcq-card__meta">
                            {FORMAT_LABEL[s.format] ?? s.format} · {WEEKDAYS[s.weekday - 1]}{" "}
                            {s.startTime} · {s.capacity} places
                          </span>
                        </span>
                        <span className="bcq-series-row__chevron" aria-hidden="true">
                          <ChevronRightIcon />
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {term.status === "closed" ? null : (
                <SeriesFormSheet
                  open={addOpen}
                  title="Add Series"
                  submitLabel="Add Series"
                  eligibleCandidates={candidates.data?.members ?? []}
                  onClose={() => {
                    setAddOpen(false);
                  }}
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
              )}
            </>
          );
        }}
      </Loaded>
    </section>
  );
}
