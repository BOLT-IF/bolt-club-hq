import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { formatClubYear, type TermSeason } from "../../../../domain/club-fee";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { goBack, navigate } from "../../../lib/navigate";
import { describeError } from "./moneyApi";
import "../../members/members.css";
import "./money.css";

export type ClubFeeStatus =
  | "paid_fall"
  | "paid_fall_external"
  | "charged_fall_unpaid"
  | "paid_spring"
  | "charged_spring_unpaid"
  | "exempt"
  | "not_charged";

export interface ClubFeeMemberRow {
  readonly memberId: string;
  readonly displayName: string;
  readonly paymentRef: string;
  readonly memberStatus: "pending" | "active" | "inactive" | "erased";
  readonly status: ClubFeeStatus;
  readonly season: TermSeason | null;
  readonly kind: "charged" | "external_fall_paid" | "exempt" | null;
  readonly paidInFall: boolean;
  readonly ledgerEntryId: string | null;
  readonly clubFeeId: string | null;
  readonly amountSek: number;
  readonly oweAmountSek: number;
  readonly note: string;
  readonly recordedAt: string | null;
}

export interface ClubFeesSummary {
  readonly totalMembers: number;
  readonly paidFallCount: number;
  readonly paidFallInAppCount: number;
  readonly paidFallExternalCount: number;
  readonly owesFallCount: number;
  readonly springCount: number;
  readonly paidSpringCount: number;
  readonly owesSpringCount: number;
  readonly exemptCount: number;
  readonly notChargedCount: number;
}

export interface ClubFeesResponse {
  readonly clubYear: number;
  readonly label: string;
  readonly fallFeeSek: number;
  readonly springFeeSek: number;
  readonly availableYears: readonly number[];
  readonly summary: ClubFeesSummary;
  readonly members: readonly ClubFeeMemberRow[];
}

type Filter = "all" | "paid_fall" | "owes" | "spring" | "not_charged";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "paid_fall", label: "Paid in Fall" },
  { value: "owes", label: "Owes Club Fee" },
  { value: "spring", label: "Spring" },
  { value: "not_charged", label: "Not Charged" },
];

function matchesFilter(row: ClubFeeMemberRow, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "paid_fall":
      return row.paidInFall;
    case "owes":
      return row.status === "charged_fall_unpaid" || row.status === "charged_spring_unpaid";
    case "spring":
      return row.status === "paid_spring" || row.status === "charged_spring_unpaid";
    case "not_charged":
      return row.status === "not_charged";
  }
}

function matchesSearch(row: ClubFeeMemberRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    row.displayName.toLowerCase().includes(q) ||
    row.paymentRef.toLowerCase().includes(q)
  );
}

function feeStatusBadge(row: ClubFeeMemberRow): { label: string; tone: StatusTone } {
  switch (row.status) {
    case "paid_fall":
      return { label: "Paid in Fall", tone: "success" };
    case "paid_fall_external":
      return { label: "Paid in Fall (outside app)", tone: "success" };
    case "charged_fall_unpaid":
      return { label: `Owes Fall (${String(row.oweAmountSek)} kr)`, tone: "warning" };
    case "paid_spring":
      return { label: "Paid Spring", tone: "info" };
    case "charged_spring_unpaid":
      return { label: `Owes Spring (${String(row.oweAmountSek)} kr)`, tone: "warning" };
    case "exempt":
      return { label: "Exempt", tone: "neutral" };
    case "not_charged":
      return { label: "Not charged", tone: "neutral" };
  }
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: ClubFeesResponse };

/** Admin annual club fees management: Fall/Spring status, batch charges, and external Fall tracking. */
export function AdminClubFees() {
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmBatchSeason, setConfirmBatchSeason] = useState<TermSeason | null>(null);

  const load = useCallback((year: number | null, isCancelled: () => boolean = () => false) => {
    const path = year === null ? "/admin/club-fees" : `/admin/club-fees?clubYear=${String(year)}`;
    apiFetch<ClubFeesResponse>(path)
      .then((data) => {
        if (!isCancelled()) {
          setState({ kind: "ready", data });
          setSelectedIds(new Set());
        }
      })
      .catch(() => {
        if (!isCancelled()) setState({ kind: "error" });
      });
  }, []);

  useEffect(() => {
    if (!moneyOn) return;
    let cancelled = false;
    load(selectedYear, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [moneyOn, selectedYear, load]);

  if (!moneyOn) {
    return <EmptyState title="Money">Money is not switched on yet.</EmptyState>;
  }
  if (state.kind === "loading") return <Skeleton label="Loading club fees" />;
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load club fees"
        onRetry={() => {
          setState({ kind: "loading" });
          load(selectedYear);
        }}
      >
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  const { data } = state;
  const visible = data.members.filter((m) => matchesFilter(m, filter) && matchesSearch(m, query));
  const selectedList = [...selectedIds];

  function toggleMember(memberId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function selectNotCharged() {
    setSelectedIds(
      new Set(visible.filter((m) => m.status === "not_charged").map((m) => m.memberId)),
    );
  }

  async function runCharge(season: TermSeason, memberIds?: string[]) {
    if (busy) return;
    setBusy(true);
    try {
      const body =
        memberIds && memberIds.length > 0
          ? { clubYear: data.clubYear, season, memberIds }
          : { clubYear: data.clubYear, season };
      const res = await apiFetch<{ chargedCount: number; skippedCount: number }>(
        "/admin/club-fees/charge",
        {
          method: "POST",
          body,
          idempotencyKey: newIdempotencyKey(),
        },
      );
      toast.show(
        `Charged ${String(res.chargedCount)} member(s); skipped ${String(res.skippedCount)}.`,
        "success",
      );
      load(data.clubYear);
    } catch (error) {
      toast.show(describeError(error), "danger");
    } finally {
      setBusy(false);
      setConfirmBatchSeason(null);
    }
  }

  async function runMarkExternalFall(memberIds: string[]) {
    if (busy || memberIds.length === 0) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ markedCount: number; skippedCount: number }>(
        "/admin/club-fees/mark-external-fall",
        {
          method: "POST",
          body: { clubYear: data.clubYear, memberIds },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      toast.show(
        `Marked ${String(res.markedCount)} as paid in Fall; skipped ${String(res.skippedCount)}.`,
        "success",
      );
      load(data.clubYear);
    } catch (error) {
      toast.show(describeError(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function runClearExternal(clubFeeId: string, displayName: string) {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/club-fees/${encodeURIComponent(clubFeeId)}/clear`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(),
      });
      toast.show(`Cleared external mark for ${displayName}.`, "success");
      load(data.clubYear);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.body as { error?: unknown } | null)?.error === "reverse_in_ledger"
      ) {
        toast.show("Reverse in-app charges from the member's ledger.", "danger");
      } else {
        toast.show(describeError(error), "danger");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bcq-page bcq-money-page" aria-labelledby="admin-club-fees-title">
      <div>
        <a
          className="bcq-btn bcq-btn--tonal"
          href="/admin/money"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            goBack("/admin/money");
          }}
        >
          Back to Balances
        </a>
      </div>
      <h1 id="admin-club-fees-title" className="bcq-page__title">
        Club Fees ({data.label})
      </h1>

      <div className="bcq-card bcq-form">
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="club-fees-year">
            Membership Year
          </label>
          <select
            id="club-fees-year"
            className="bcq-input"
            value={String(data.clubYear)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setSelectedYear(next);
              setState({ kind: "loading" });
            }}
          >
            {data.availableYears.map((y) => (
              <option key={y} value={String(y)}>
                {formatClubYear(y)}
              </option>
            ))}
          </select>
        </div>

        <dl className="bcq-club-fees__summary" aria-label="Club fee summary">
          <div className="bcq-club-fees__stat">
            <dt>Paid in Fall</dt>
            <dd>{data.summary.paidFallCount}</dd>
          </div>
          <div className="bcq-club-fees__stat">
            <dt>Owes Fall</dt>
            <dd>{data.summary.owesFallCount}</dd>
          </div>
          <div className="bcq-club-fees__stat">
            <dt>Spring</dt>
            <dd>{data.summary.springCount}</dd>
          </div>
          <div className="bcq-club-fees__stat">
            <dt>Not Charged</dt>
            <dd>{data.summary.notChargedCount}</dd>
          </div>
        </dl>

        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="club-fees-search">
            Search Name or Payment Reference
          </label>
          <input
            id="club-fees-search"
            className="bcq-input"
            type="search"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>

        <fieldset className="bcq-filter-pills">
          <legend>Show</legend>
          {FILTERS.map((f) => (
            <label key={f.value} className="bcq-filter-pill">
              <input
                type="radio"
                name="club-fees-filter"
                value={f.value}
                checked={filter === f.value}
                onChange={() => {
                  setFilter(f.value);
                }}
              />
              {f.label}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="bcq-member__actions" role="group" aria-label="Batch club fee actions">
        <Button type="button" variant="tonal" disabled={busy} onClick={selectNotCharged}>
          Select Not Charged
        </Button>
        {selectedList.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setSelectedIds(new Set());
            }}
          >
            Clear Selection ({selectedList.length})
          </Button>
        ) : null}
        <Button
          type="button"
          variant="tonal"
          disabled={busy}
          onClick={() => {
            if (selectedList.length > 0) void runCharge("fall", selectedList);
            else setConfirmBatchSeason("fall");
          }}
        >
          {`Charge Fall Fee (${String(data.fallFeeSek)} kr)`}
        </Button>
        <Button
          type="button"
          variant="tonal"
          disabled={busy}
          onClick={() => {
            if (selectedList.length > 0) void runCharge("spring", selectedList);
            else setConfirmBatchSeason("spring");
          }}
        >
          {`Charge Spring Fee (${String(data.springFeeSek)} kr)`}
        </Button>
        <Button
          type="button"
          variant="tonal"
          disabled={busy || selectedList.length === 0}
          onClick={() => {
            void runMarkExternalFall(selectedList);
          }}
        >
          Mark Paid in Fall (Outside App)
        </Button>
      </div>
      <p className="bcq-member__meta">
        Fall payers and already-covered members are skipped automatically when charging Spring.
      </p>

      {visible.length === 0 ? (
        <EmptyState title="No members match">Try another search or filter.</EmptyState>
      ) : (
        <ul className="bcq-members" aria-label="Club fee members">
          {visible.map((m) => {
            const badge = feeStatusBadge(m);
            const checked = selectedIds.has(m.memberId);
            return (
              <li key={m.memberId} className="bcq-member">
                <div className="bcq-club-fees__row-head">
                  <input
                    type="checkbox"
                    className="bcq-club-fees__checkbox"
                    aria-label={`Select ${m.displayName}`}
                    checked={checked}
                    onChange={() => {
                      toggleMember(m.memberId);
                    }}
                  />
                  <a
                    className="bcq-money-row"
                    href={`/admin/money/members/${m.memberId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/admin/money/members/${m.memberId}`);
                    }}
                  >
                    <span className="bcq-member__head">
                      <span className="bcq-member__name">{m.displayName}</span>
                      <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
                      {m.memberStatus !== "active" ? (
                        <StatusChip tone="neutral">
                          {m.memberStatus.charAt(0).toUpperCase() + m.memberStatus.slice(1)}
                        </StatusChip>
                      ) : null}
                    </span>
                    <span className="bcq-member__meta">
                      Payment reference {m.paymentRef}
                      {m.note ? ` · ${m.note}` : ""}
                    </span>
                  </a>
                </div>
                <div className="bcq-member__actions">
                  {m.status === "not_charged" ? (
                    <>
                      <Button
                        type="button"
                        variant="tonal"
                        disabled={busy}
                        onClick={() => {
                          void runMarkExternalFall([m.memberId]);
                        }}
                      >
                        Mark Fall Paid
                      </Button>
                      <Button
                        type="button"
                        variant="tonal"
                        disabled={busy}
                        onClick={() => {
                          void runCharge("fall", [m.memberId]);
                        }}
                      >
                        Charge Fall
                      </Button>
                      <Button
                        type="button"
                        variant="tonal"
                        disabled={busy}
                        onClick={() => {
                          void runCharge("spring", [m.memberId]);
                        }}
                      >
                        Charge Spring
                      </Button>
                    </>
                  ) : null}
                  {(m.status === "paid_fall_external" || m.status === "exempt") && m.clubFeeId ? (
                    <Button
                      type="button"
                      variant="destructive-tonal"
                      disabled={busy}
                      onClick={() => {
                        if (m.clubFeeId) void runClearExternal(m.clubFeeId, m.displayName);
                      }}
                    >
                      Clear External Mark
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmBatchSeason !== null}
        title={
          confirmBatchSeason === "fall"
            ? `Charge Fall fee (${String(data.fallFeeSek)} kr) to all active members?`
            : `Charge Spring fee (${String(data.springFeeSek)} kr) to all active members?`
        }
        description={
          confirmBatchSeason === "spring"
            ? `Members who already paid or were charged in Fall ${data.label} are skipped automatically.`
            : `Already-covered members for ${data.label} are skipped automatically.`
        }
        confirmLabel={busy ? "Charging…" : "Confirm charge"}
        onCancel={() => {
          if (!busy) setConfirmBatchSeason(null);
        }}
        onConfirm={() => {
          if (confirmBatchSeason) void runCharge(confirmBatchSeason);
        }}
      />
    </section>
  );
}
