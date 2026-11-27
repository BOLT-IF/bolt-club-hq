import { useRef, useState } from "react";

import { apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  formatClubYear,
  inferClubYear,
  inferTermSeason,
  resolveTermMembershipPeriod,
  type TermSeason,
} from "../../../../domain/club-fee";
import {
  ActionSheet,
  BottomSheet,
  Button,
  ChevronRightIcon,
  CompactEmptyState,
  DisclosureSection,
  OverflowButton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { navigate } from "../../../lib/navigate";
import {
  AreaGate,
  CalendarIcon,
  Loaded,
  PlusIcon,
  SelectField,
  errorMessage,
  formatDateRange,
  toWhole,
  useLoad,
  type TermRow,
  type TermStatus,
} from "./shared";
import "./terms.css";

const CARD_STATUS_LABEL: Record<TermStatus, string> = {
  draft: "Draft",
  open_for_passes: "Passes Open",
  active: "Active",
  closed: "Closed",
};

/** Concise second-line term metadata: omits season if already in title, Title Case Series, no orphan middot. */
function formatTermMeta(t: TermRow): string {
  const { season, clubYear } = resolveTermMembershipPeriod({
    startsOn: t.startsOn,
    season: t.season ?? null,
    clubYear: t.clubYear ?? null,
  });
  const lowerName = t.name.toLowerCase();
  const hasSeasonInTitle =
    season === "fall"
      ? lowerName.includes("fall") || lowerName.includes("autumn")
      : lowerName.includes("spring");

  const parts: string[] = [];
  if (!hasSeasonInTitle) {
    parts.push(season === "fall" ? "Fall" : "Spring");
  }
  parts.push(formatClubYear(clubYear));
  parts.push(`${String(t.seriesCount ?? 0)} Series`);
  return parts.join(" · ");
}

function DateInputField({
  label,
  value,
  onChange,
  required = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly required?: boolean;
}) {
  return (
    <label className="bcq-terms-field">
      <span className="bcq-terms-field__label">{label}</span>
      <span className="bcq-date-wrap">
        <span className="bcq-date-wrap__icon" aria-hidden="true">
          <CalendarIcon size={16} />
        </span>
        <input
          className={cx("bcq-terms-input bcq-date-input", !value && "is-empty")}
          type="date"
          value={value}
          required={required}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </span>
    </label>
  );
}

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
      <label className="bcq-terms-field">
        <span className="bcq-terms-field__label">Name</span>
        <input
          className="bcq-terms-input"
          type="text"
          placeholder="e.g. Fall 2027"
          value={name}
          required
          onChange={(event) => {
            onName(event.target.value);
          }}
        />
      </label>
      <div className="bcq-form-grid-2">
        <DateInputField label="Starts On" value={starts} onChange={onStarts} required />
        <DateInputField label="Ends On" value={ends} onChange={onEnds} required />
      </div>
      <div className="bcq-form-grid-2">
        <SelectField
          label="Season"
          value={season}
          onChange={onSeason}
          options={[
            { value: "fall", label: "Fall" },
            { value: "spring", label: "Spring" },
          ]}
        />
        <label className="bcq-terms-field">
          <span className="bcq-terms-field__label">Membership Year</span>
          <span className="bcq-input-affix">
            <input
              className={cx(
                "bcq-terms-input bcq-terms-input--tabular",
                parsedYear !== null && "bcq-input--has-affix",
              )}
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="2026"
              value={clubYear}
              onChange={(event) => {
                onClubYear(event.target.value);
              }}
            />
            {parsedYear !== null ? (
              <span className="bcq-input-affix__suffix" aria-hidden="true">
                → {formatClubYear(parsedYear)}
              </span>
            ) : null}
          </span>
        </label>
      </div>
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

function CopyIcon() {
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
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function NewTermSheet({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
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

  async function runCreate() {
    if (formRef.current?.reportValidity() === false) return;
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
      onClose();
      onCreated();
    } catch (error) {
      toast.show(errorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      title="New Term"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="bcq-terms-sheet-footer">
          <Button type="button" disabled={busy} onClick={() => void runCreate()}>
            Create Term
          </Button>
          <Button type="button" variant="tonal" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <form
        ref={formRef}
        className="bcq-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runCreate();
        }}
      >
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
      </form>
    </BottomSheet>
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
  const formRef = useRef<HTMLFormElement>(null);
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

  async function runClone() {
    if (!source) return;
    if (formRef.current?.reportValidity() === false) return;
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
    <BottomSheet
      open={source !== null}
      title={`Clone ${source?.name ?? "Term"}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="bcq-terms-sheet-footer">
          <Button type="button" disabled={busy} onClick={() => void runClone()}>
            Clone Term
          </Button>
          <Button type="button" variant="tonal" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <form
        ref={formRef}
        className="bcq-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runClone();
        }}
      >
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
      </form>
    </BottomSheet>
  );
}

function tone(status: TermStatus): StatusTone {
  if (status === "active") return "success";
  if (status === "open_for_passes") return "sky";
  return "neutral";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTerm, setSelectedTerm] = useState<TermRow | null>(null);
  const [cloning, setCloning] = useState<TermRow | null>(null);

  const renderTermCard = (t: TermRow) => (
    <li key={t.id} className="bcq-card bcq-term-card">
      <div className="bcq-term-card__top">
        <a
          className="bcq-term-card__title"
          href={`/admin/terms/${t.id}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(`/admin/terms/${t.id}`);
          }}
        >
          {t.name}
        </a>
        <div className="bcq-term-card__controls">
          <StatusChip tone={tone(t.status)}>{CARD_STATUS_LABEL[t.status]}</StatusChip>
          <OverflowButton
            label={`Actions for ${t.name}`}
            className="bcq-term-card__overflow"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedTerm(t);
            }}
          />
        </div>
      </div>

      <p className="bcq-term-card__dates">
        <CalendarIcon size={15} />
        <span>{formatDateRange(t.startsOn, t.endsOn)}</span>
      </p>

      <div className="bcq-term-card__footer">
        <span className="bcq-term-card__meta">{formatTermMeta(t)}</span>
        <span className="bcq-term-card__chevron" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </div>
    </li>
  );

  return (
    <section className="bcq-page bcq-stack" aria-labelledby="terms-title">
      <div className="bcq-page-head">
        <h1 id="terms-title" className="bcq-page__title">
          Terms &amp; Series
        </h1>
        <Button
          variant="primary"
          className="bcq-btn--compact"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          <PlusIcon />
          <span>New Term</span>
        </Button>
      </div>

      <Loaded load={load}>
        {({ terms }) => {
          if (terms.length === 0) {
            return (
              <CompactEmptyState
                title="No Terms Yet"
                icon={<CalendarIcon size={18} />}
                action={
                  <Button
                    variant="tonal"
                    onClick={() => {
                      setCreateOpen(true);
                    }}
                  >
                    <PlusIcon />
                    <span>New Term</span>
                  </Button>
                }
              >
                Create your first term to schedule series and passes
              </CompactEmptyState>
            );
          }
          const activeTerms = terms.filter((t) => t.status !== "closed");
          const closedTerms = terms.filter((t) => t.status === "closed");
          return (
            <div className="bcq-stack">
              {activeTerms.length > 0 ? (
                <div className="bcq-terms-group">
                  <h2 className="bcq-section-subheader">Active &amp; Upcoming</h2>
                  <ul className="bcq-list">{activeTerms.map(renderTermCard)}</ul>
                </div>
              ) : null}
              {closedTerms.length > 0 ? (
                <DisclosureSection label={`Past Terms (${String(closedTerms.length)})`}>
                  <ul className="bcq-list">{closedTerms.map(renderTermCard)}</ul>
                </DisclosureSection>
              ) : null}
            </div>
          );
        }}
      </Loaded>

      <NewTermSheet
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={load.reload}
      />

      {selectedTerm ? (
        <ActionSheet.Root
          open
          title={selectedTerm.name}
          onClose={() => {
            setSelectedTerm(null);
          }}
        >
          <ActionSheet.Header
            title={formatDateRange(selectedTerm.startsOn, selectedTerm.endsOn)}
            subtitle={formatTermMeta(selectedTerm)}
          />
          <ActionSheet.Group>
            <ActionSheet.Item
              icon={<CopyIcon />}
              onClick={() => {
                const target = selectedTerm;
                setSelectedTerm(null);
                setCloning(target);
              }}
            >
              Clone Term
            </ActionSheet.Item>
            <ActionSheet.Cancel
              onClick={() => {
                setSelectedTerm(null);
              }}
            />
          </ActionSheet.Group>
        </ActionSheet.Root>
      ) : null}

      <CloneSheet
        source={cloning}
        onClose={() => {
          setCloning(null);
        }}
      />
    </section>
  );
}
