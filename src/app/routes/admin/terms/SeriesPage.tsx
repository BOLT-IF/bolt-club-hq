import { useEffect, useState } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import {
  BottomSheet,
  Button,
  ChevronRightIcon,
  ConfirmDialog,
  CopyButton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { navigate } from "../../../lib/navigate";
import { useBackTarget } from "../../../shell/AppShell";
import { useRouteParams } from "../../registry";
import { SeriesFormSheet } from "./SeriesForm";
import {
  AreaGate,
  CalendarIcon,
  FORMAT_LABEL,
  Loaded,
  WEEKDAYS,
  errorMessage,
  useLoad,
  type SeriesRow,
} from "./shared";
import "./terms.css";

interface MemberCandidate {
  readonly id: string;
  readonly displayName: string;
}

interface BlockedCap {
  readonly changes: Record<string, unknown>;
  readonly passCap: number;
  readonly passesSold: number;
}

function SearchIcon() {
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
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CheckMarkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SeriesPage() {
  return (
    <AreaGate>
      <SeriesDetail />
    </AreaGate>
  );
}

function SeriesDetail() {
  const { id = "" } = useRouteParams();
  const path = `/series/${encodeURIComponent(id)}`;
  const load = useLoad<{ series: SeriesRow }>(path);
  const candidates = useLoad<{ members: MemberCandidate[] }>("/series/captain-candidates");
  const toast = useToast();
  const [termName, setTermName] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [blocked, setBlocked] = useState<BlockedCap | null>(null);
  const [busy, setBusy] = useState(false);

  const loadedSeries = load.data?.series ?? null;
  const termId = loadedSeries?.termId ?? null;

  useEffect(() => {
    if (!termId) return;
    let cancelled = false;
    apiFetch<{ term?: { name?: string } }>(`/terms/${encodeURIComponent(termId)}`, {
      redirectOnUnauthorized: false,
    })
      .then((res) => {
        if (!cancelled && typeof res.term?.name === "string") {
          setTermName(res.term.name);
        }
      })
      .catch(() => {
        // Fallback label "Term" remains intact if term lookup is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [termId]);

  useBackTarget(
    loadedSeries
      ? { label: termName ?? "Term", fallback: `/admin/terms/${loadedSeries.termId}` }
      : null,
  );

  async function save(changes: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiFetch(path, { method: "PATCH", body: changes });
      setBlocked(null);
      setEditOpen(false);
      toast.show("Changes saved", "success");
      load.reload();
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as Record<string, unknown>) : null;
      if (body?.error === "cap_below_passes_sold") {
        setEditOpen(false);
        setBlocked({
          changes,
          passCap: Number(body.passCap),
          passesSold: Number(body.passesSold),
        });
        return;
      }
      toast.show(errorMessage(error), "danger");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bcq-page bcq-stack">
      <Loaded load={load}>
        {({ series }) => {
          const sharePath = `/s/${series.shareSlug}`;
          const shareFullUrl =
            typeof window !== "undefined" ? `${window.location.origin}${sharePath}` : sharePath;

          return (
            <>
              <div>
                <h1 className="bcq-page__title">{series.name}</h1>
                <p className="bcq-card__meta" style={{ marginTop: "0.3rem" }}>
                  {FORMAT_LABEL[series.format] ?? series.format} · {WEEKDAYS[series.weekday - 1]}{" "}
                  {series.startTime} · Pass Cap {series.passCap}
                </p>
              </div>

              <a
                className="bcq-sched-nav-card"
                href={`/admin/terms/series/${encodeURIComponent(series.id)}/schedule`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(`/admin/terms/series/${encodeURIComponent(series.id)}/schedule`);
                }}
              >
                <span className="bcq-sched-nav-card__left">
                  <span className="bcq-icon-badge bcq-icon-badge--amber" aria-hidden="true">
                    <CalendarIcon size={18} />
                  </span>
                  <span>
                    <span className="bcq-sched-nav-card__title">Schedule &amp; Occurrences</span>
                    <span className="bcq-card__meta">
                      {series.skipDatesLocked
                        ? "Skip-dates locked · Generate or edit sessions"
                        : "Generate events, skip-dates & edit sessions"}
                    </span>
                  </span>
                </span>
                <span className="bcq-series-row__chevron" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              </a>

              <div className="bcq-card bcq-share-card">
                <div className="bcq-share-card__info">
                  <span className="bcq-terms-sec-label" style={{ padding: 0 }}>
                    Share Link
                  </span>
                  <span className="bcq-share-card__path">{sharePath}</span>
                  {series.skipDatesLocked ? (
                    <div>
                      <StatusChip tone="warning">Skip-Dates Locked</StatusChip>
                    </div>
                  ) : null}
                </div>
                <CopyButton value={shareFullUrl} label="Copy" ariaLabel="Copy share link" />
              </div>

              <div className="bcq-card bcq-detail-card">
                <div className="bcq-card__row">
                  <h2 className="bcq-card__title">Details</h2>
                  <Button
                    variant="tonal"
                    className="bcq-btn--compact"
                    aria-label="Edit Details"
                    onClick={() => {
                      setEditOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                </div>
                <dl className="bcq-detail-grid">
                  <div className="bcq-detail-grid__item">
                    <dt>Format</dt>
                    <dd>{FORMAT_LABEL[series.format] ?? series.format}</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Schedule</dt>
                    <dd>
                      {WEEKDAYS[series.weekday - 1]} {series.startTime}
                    </dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Duration</dt>
                    <dd>{series.durationMin} min</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Location</dt>
                    <dd>{series.location || "Not set"}</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Capacity</dt>
                    <dd>{series.capacity} places</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Pass Cap</dt>
                    <dd>{series.passCap} passes</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Pass Price</dt>
                    <dd>{series.passPrice} kr</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Discounted Price</dt>
                    <dd>
                      {series.discountedPassPrice !== null
                        ? `${String(series.discountedPassPrice)} kr`
                        : "None"}
                    </dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Drop-In Fee</dt>
                    <dd>{series.adhocFee} kr</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>Guests Per Member</dt>
                    <dd>{series.maxGuestsDefault}</dd>
                  </div>
                  <div className="bcq-detail-grid__item">
                    <dt>RSVP Cutoff</dt>
                    <dd>{series.rsvpCloseOffsetMin} min before</dd>
                  </div>
                </dl>
              </div>

              {!candidates.error && candidates.data ? (
                <>
                  <MemberPickerCard
                    title="Captains"
                    sheetTitle="Manage Captains"
                    emptyText="No captains assigned"
                    initialIds={series.captains.map((c) => c.id)}
                    selectedNames={series.captains.map((c) => c.displayName)}
                    candidates={candidates.data.members}
                    endpoint={`/series/${encodeURIComponent(series.id)}/captains`}
                    successMessage="Captains saved"
                    onSaved={load.reload}
                  />
                  <MemberPickerCard
                    title="Discounted Rate Eligibility"
                    sheetTitle="Manage Discount Eligibility"
                    emptyText="No members selected for discounted pass rate"
                    initialIds={(series.discountEligible ?? []).map((m) => m.id)}
                    selectedNames={(series.discountEligible ?? []).map((m) => m.displayName)}
                    candidates={candidates.data.members}
                    endpoint={`/series/${encodeURIComponent(series.id)}/discount-eligible`}
                    successMessage="Discount eligibility saved"
                    onSaved={load.reload}
                  />
                </>
              ) : null}

              <SeriesFormSheet
                key={JSON.stringify(series)}
                open={editOpen}
                title="Edit Series Details"
                initial={series}
                submitLabel="Save Changes"
                onClose={() => {
                  setEditOpen(false);
                }}
                onSubmit={save}
              />

              <ConfirmDialog
                open={blocked !== null}
                title="Override Pass Cap?"
                description={
                  blocked
                    ? `That capacity puts the pass cap at ${String(blocked.passCap)}, below the ${String(blocked.passesSold)} passes already sold.`
                    : ""
                }
                confirmLabel={busy ? "Saving…" : "Save Anyway"}
                destructive
                onConfirm={() => {
                  if (blocked && !busy) {
                    void save({ ...blocked.changes, overrideCapBelowSold: true }).catch(
                      () => undefined,
                    );
                  }
                }}
                onCancel={() => {
                  if (!busy) setBlocked(null);
                }}
              />
            </>
          );
        }}
      </Loaded>
    </section>
  );
}

function MemberPickerCard({
  title,
  sheetTitle,
  emptyText,
  initialIds,
  selectedNames,
  candidates,
  endpoint,
  successMessage,
  onSaved,
}: {
  readonly title: string;
  readonly sheetTitle: string;
  readonly emptyText: string;
  readonly initialIds: readonly string[];
  readonly selectedNames: readonly string[];
  readonly candidates: readonly MemberCandidate[];
  readonly endpoint: string;
  readonly successMessage: string;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initialIds));
  const [busy, setBusy] = useState(false);

  const openPicker = () => {
    setPicked(new Set(initialIds));
    setSearch("");
    setOpen(true);
  };

  async function save() {
    setBusy(true);
    try {
      await apiFetch(endpoint, {
        method: "PUT",
        body: { memberIds: [...picked] },
      });
      toast.show(successMessage, "success");
      setOpen(false);
      onSaved();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  const query = search.trim().toLowerCase();
  const filteredCandidates = candidates.filter(
    (m) => query === "" || m.displayName.toLowerCase().includes(query),
  );

  return (
    <>
      <div className="bcq-card bcq-member-summary-card">
        <div className="bcq-member-summary-card__info">
          <h2 className="bcq-card__title">{title}</h2>
          <p className="bcq-card__meta">
            {selectedNames.length > 0 ? selectedNames.join(", ") : emptyText}
          </p>
        </div>
        <Button
          variant="tonal"
          className="bcq-btn--compact"
          aria-label={`Manage ${title}`}
          onClick={openPicker}
        >
          Manage
        </Button>
      </div>

      <BottomSheet
        open={open}
        title={sheetTitle}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        footer={
          <div className="bcq-terms-sheet-footer">
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="tonal"
              disabled={busy}
              onClick={() => {
                if (!busy) setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        }
      >
        <div className="bcq-form">
          <div className="bcq-search">
            <span className="bcq-search__icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="search"
              className="bcq-search__input"
              aria-label={`Search ${title}`}
              placeholder="Search members..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          </div>
          <div className="bcq-member-pick-list" role="group" aria-label={title}>
            {filteredCandidates.map((m) => {
              const selected = picked.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  className={cx("bcq-member-pick-row", selected && "is-selected")}
                  onClick={() => {
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    });
                  }}
                >
                  <span>{m.displayName}</span>
                  <span className="bcq-member-pick-row__check" aria-hidden="true">
                    {selected ? <CheckMarkIcon /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
