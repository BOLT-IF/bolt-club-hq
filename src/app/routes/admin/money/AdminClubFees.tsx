import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { formatClubYear, type TermSeason } from "../../../../domain/club-fee";
import {
  ActionSheet,
  BottomSheet,
  Button,
  ChevronRightIcon,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MoreHorizontalIcon,
  Skeleton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { navigate } from "../../../lib/navigate";
import { useBackTarget } from "../../../shell/AppShell";
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

type Filter = "all" | "not_charged" | "owes" | "paid_fall" | "spring";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "not_charged", label: "Not Charged" },
  { value: "owes", label: "Owes Club Fee" },
  { value: "paid_fall", label: "Paid in Fall" },
  { value: "spring", label: "Paid in Spring" },
];

function CoinsIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
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

function ClearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

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

function statusSortRank(status: ClubFeeStatus): number {
  if (status === "charged_fall_unpaid" || status === "charged_spring_unpaid") return 0;
  if (status === "not_charged") return 1;
  return 2;
}

function compareClubFeeRows(a: ClubFeeMemberRow, b: ClubFeeMemberRow): number {
  const rankDiff = statusSortRank(a.status) - statusSortRank(b.status);
  if (rankDiff !== 0) return rankDiff;
  return a.displayName.localeCompare(b.displayName);
}

function feeStatusBadge(row: ClubFeeMemberRow): { label: string; tone: StatusTone } {
  switch (row.status) {
    case "paid_fall":
      return { label: "Paid in Fall", tone: "success" };
    case "paid_fall_external":
      return { label: "Paid Externally", tone: "success" };
    case "charged_fall_unpaid":
      return { label: `Owes Fall (${String(row.oweAmountSek)} kr)`, tone: "warning" };
    case "paid_spring":
      return { label: "Paid Spring", tone: "info" };
    case "charged_spring_unpaid":
      return { label: `Owes Spring (${String(row.oweAmountSek)} kr)`, tone: "warning" };
    case "exempt":
      return { label: "Exempt", tone: "neutral" };
    case "not_charged":
      return { label: "Not Charged", tone: "neutral" };
  }
}

function filterCount(summary: ClubFeesSummary, filter: Filter): number {
  switch (filter) {
    case "all":
      return summary.totalMembers;
    case "not_charged":
      return summary.notChargedCount;
    case "owes":
      return summary.owesFallCount + summary.owesSpringCount;
    case "paid_fall":
      return summary.paidFallCount;
    case "spring":
      return summary.springCount;
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
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  const [confirmBulkSeason, setConfirmBulkSeason] = useState<TermSeason | null>(null);
  const [memberActionRow, setMemberActionRow] = useState<ClubFeeMemberRow | null>(null);
  const [pendingClear, setPendingClear] = useState<ClubFeeMemberRow | null>(null);

  useBackTarget({ label: "Balances", fallback: "/admin/money" });

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
        title="Couldn't Load Club Fees"
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
  const visible = [...data.members]
    .filter((m) => matchesFilter(m, filter) && matchesSearch(m, query))
    .sort(compareClubFeeRows);
  const notChargedVisible = visible.filter(
    (m) => m.status === "not_charged" && m.memberStatus === "active",
  );
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
    setSelectedIds(new Set(notChargedVisible.map((m) => m.memberId)));
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
      setBulkSheetOpen(false);
      load(data.clubYear);
    } catch (error) {
      toast.show(describeError(error), "danger");
    } finally {
      setBusy(false);
      setConfirmBulkSeason(null);
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
      setBulkSheetOpen(false);
      load(data.clubYear);
    } catch (error) {
      toast.show(describeError(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function runClearExternal(row: ClubFeeMemberRow) {
    if (busy || !row.clubFeeId) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/club-fees/${encodeURIComponent(row.clubFeeId)}/clear`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(),
      });
      toast.show(
        row.status === "exempt"
          ? `Cleared exempt mark for ${row.displayName}.`
          : `Cleared external mark for ${row.displayName}.`,
        "success",
      );
      setPendingClear(null);
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
    <section
      className={
        selectedList.length > 0
          ? "bcq-page bcq-money-page bcq-club-fees-page has-selection"
          : "bcq-page bcq-money-page bcq-club-fees-page"
      }
      aria-labelledby="admin-club-fees-title"
    >
      <div className="bcq-page-head">
        <h1 id="admin-club-fees-title" className="bcq-page__title">
          Club Fees
        </h1>
      </div>

      <div className="bcq-card bcq-money-search-card">
        <div className="bcq-field">
          <label className="bcq-club-fees-label" htmlFor="club-fees-year">
            Membership Year
          </label>
          <select
            id="club-fees-year"
            className="bcq-input bcq-tabular-nums"
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

        <div>
          <label className="bcq-visually-hidden" htmlFor="club-fees-search">
            Search Name or Payment Reference
          </label>
          <div className="bcq-search">
            <span className="bcq-search__icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              id="club-fees-search"
              className="bcq-search__input"
              type="search"
              autoComplete="off"
              placeholder="Search name or reference..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
            {query.length > 0 ? (
              <button
                type="button"
                className="bcq-search__clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                }}
              >
                <ClearIcon />
              </button>
            ) : null}
          </div>
        </div>

        <fieldset className="bcq-money-filterset">
          <legend className="bcq-money-filterset__legend">Show</legend>
          <div className="bcq-filter-row bcq-club-fees-filter-row">
            {FILTERS.map((f) => {
              const active = filter === f.value;
              const count = filterCount(data.summary, f.value);
              return (
                <label
                  key={f.value}
                  className={active ? "bcq-money-filter-chip is-active" : "bcq-money-filter-chip"}
                >
                  <input
                    type="radio"
                    name="club-fees-filter"
                    value={f.value}
                    checked={active}
                    onChange={() => {
                      setFilter(f.value);
                    }}
                  />
                  <span>{`${f.label} (${String(count)})`}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="bcq-club-fees-toolbar">
        <span className="bcq-club-fees-toolbar__label">
          {selectedList.length > 0
            ? `${String(selectedList.length)} Selected`
            : `Members (${String(visible.length)})`}
        </span>
        {selectedList.length > 0 ? (
          <button
            type="button"
            className="bcq-club-fees-toolbar__btn"
            disabled={busy}
            onClick={() => {
              setSelectedIds(new Set());
            }}
          >
            Clear Selection
          </button>
        ) : (
          <button
            type="button"
            className="bcq-club-fees-toolbar__btn"
            disabled={busy || notChargedVisible.length === 0}
            onClick={selectNotCharged}
          >
            {`Select Not Charged (${String(notChargedVisible.length)})`}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No Members Match">Try another search or filter.</EmptyState>
      ) : (
        <ul className="bcq-members" aria-label="Club fee members">
          {visible.map((m) => {
            const badge = feeStatusBadge(m);
            const checked = selectedIds.has(m.memberId);
            const canClearMark =
              (m.status === "paid_fall_external" || m.status === "exempt") && m.clubFeeId !== null;
            return (
              <li key={m.memberId} className="bcq-member bcq-club-fees-card">
                <div className="bcq-club-fees__row-head">
                  <label className="bcq-club-fees__check-wrap">
                    <input
                      type="checkbox"
                      className="bcq-club-fees__checkbox"
                      aria-label={`Select ${m.displayName}`}
                      checked={checked}
                      onChange={() => {
                        toggleMember(m.memberId);
                      }}
                    />
                  </label>
                  <a
                    className="bcq-money-row bcq-money-row--nav bcq-club-fees-member-link"
                    href={`/admin/money/members/${m.memberId}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(`/admin/money/members/${m.memberId}`);
                    }}
                  >
                    <span className="bcq-money-row__main">
                      <span className="bcq-money-row__title-wrap">
                        <span className="bcq-money-row__name">{m.displayName}</span>
                        {m.memberStatus !== "active" ? (
                          <StatusChip tone="neutral">
                            {m.memberStatus.charAt(0).toUpperCase() + m.memberStatus.slice(1)}
                          </StatusChip>
                        ) : null}
                      </span>
                      <span className="bcq-money-row__meta">
                        Ref <span className="bcq-mono-code">{m.paymentRef}</span>
                      </span>
                    </span>
                    <span className="bcq-money-row__trailing">
                      <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
                      <span className="bcq-grouped-row__chevron" aria-hidden="true">
                        <ChevronRightIcon />
                      </span>
                    </span>
                  </a>
                  {canClearMark ? (
                    <button
                      type="button"
                      className="bcq-club-fees-overflow-btn"
                      aria-label={`More actions for ${m.displayName}`}
                      disabled={busy}
                      onClick={() => {
                        setMemberActionRow(m);
                      }}
                    >
                      <MoreHorizontalIcon />
                    </button>
                  ) : null}
                </div>

                {m.status === "not_charged" ? (
                  <div className="bcq-club-fees-card__actions">
                    <button
                      type="button"
                      className="bcq-club-fees-charge-fall-btn"
                      disabled={busy}
                      onClick={() => {
                        void runCharge("fall", [m.memberId]);
                      }}
                    >
                      {`Charge Fall (${String(data.fallFeeSek)} kr)`}
                    </button>
                    <button
                      type="button"
                      className="bcq-club-fees-overflow-btn"
                      aria-label={`More actions for ${m.displayName}`}
                      disabled={busy}
                      onClick={() => {
                        setMemberActionRow(m);
                      }}
                    >
                      <MoreHorizontalIcon />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {selectedList.length > 0 ? (
        <div className="bcq-club-fees-sticky-bar" role="region" aria-label="Selected actions">
          <div className="bcq-club-fees-sticky-bar__inner">
            <span className="bcq-club-fees-sticky-bar__count">
              {String(selectedList.length)}{" "}
              {selectedList.length === 1 ? "Member Selected" : "Members Selected"}
            </span>
            <Button
              type="button"
              className="bcq-btn--compact"
              disabled={busy}
              onClick={() => {
                setBulkSheetOpen(true);
              }}
            >
              Bulk Actions
            </Button>
          </div>
        </div>
      ) : null}

      <BottomSheet
        open={bulkSheetOpen && selectedList.length > 0}
        title={`Selected (${String(selectedList.length)} ${selectedList.length === 1 ? "Member" : "Members"})`}
        onClose={() => {
          if (!busy) setBulkSheetOpen(false);
        }}
        footer={
          <div className="bcq-club-fees-sheet-footer">
            <Button
              type="button"
              variant="tonal"
              block
              disabled={busy}
              onClick={() => {
                if (!busy) setBulkSheetOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        }
      >
        <div className="bcq-club-fees-sheet">
          <div className="bcq-club-fees-card__pair">
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setBulkSheetOpen(false);
                setConfirmBulkSeason("fall");
              }}
            >
              {`Charge Fall (${String(data.fallFeeSek)} kr)`}
            </Button>
            <Button
              type="button"
              variant="tonal"
              disabled={busy}
              onClick={() => {
                setBulkSheetOpen(false);
                setConfirmBulkSeason("spring");
              }}
            >
              {`Charge Spring (${String(data.springFeeSek)} kr)`}
            </Button>
          </div>
          <Button
            type="button"
            variant="tonal"
            block
            disabled={busy}
            onClick={() => {
              void runMarkExternalFall(selectedList);
            }}
          >
            Mark Paid in Fall (Outside App)
          </Button>
          <p className="bcq-club-fees-sheet__note">
            Fall payers and already-covered members are skipped automatically when charging Spring.
          </p>
        </div>
      </BottomSheet>

      <ActionSheet.Root
        open={memberActionRow !== null}
        title="Member Club Fee Actions"
        onClose={() => {
          setMemberActionRow(null);
        }}
      >
        {memberActionRow ? (
          <div className="bcq-club-fees-actionsheet">
            <ActionSheet.Header
              title={memberActionRow.displayName}
              subtitle={`Ref ${memberActionRow.paymentRef}`}
            />
            {memberActionRow.status === "not_charged" ? (
              <ActionSheet.Group>
                <ActionSheet.Item
                  icon={<CoinsIcon size={18} />}
                  disabled={busy}
                  onClick={() => {
                    const id = memberActionRow.memberId;
                    setMemberActionRow(null);
                    void runCharge("spring", [id]);
                  }}
                >
                  {`Charge Spring (${String(data.springFeeSek)} kr)`}
                </ActionSheet.Item>
                <ActionSheet.Item
                  icon={<CheckCircleIcon />}
                  disabled={busy}
                  onClick={() => {
                    const id = memberActionRow.memberId;
                    setMemberActionRow(null);
                    void runMarkExternalFall([id]);
                  }}
                >
                  Mark Fall Paid
                </ActionSheet.Item>
              </ActionSheet.Group>
            ) : (
              <ActionSheet.Group>
                <ActionSheet.Item
                  icon={<TrashIcon />}
                  tone="destructive-tonal"
                  disabled={busy}
                  onClick={() => {
                    const row = memberActionRow;
                    setMemberActionRow(null);
                    setPendingClear(row);
                  }}
                >
                  {memberActionRow.status === "exempt"
                    ? "Clear Exempt Mark"
                    : "Clear External Mark"}
                </ActionSheet.Item>
              </ActionSheet.Group>
            )}
            <ActionSheet.Cancel
              onClick={() => {
                setMemberActionRow(null);
              }}
            />
          </div>
        ) : null}
      </ActionSheet.Root>

      <ConfirmDialog
        open={confirmBulkSeason !== null && selectedList.length > 0}
        title={
          confirmBulkSeason === "fall"
            ? `Charge Fall Fee (${String(data.fallFeeSek)} kr) to ${String(selectedList.length)} Selected ${selectedList.length === 1 ? "Member" : "Members"}?`
            : `Charge Spring Fee (${String(data.springFeeSek)} kr) to ${String(selectedList.length)} Selected ${selectedList.length === 1 ? "Member" : "Members"}?`
        }
        description={
          confirmBulkSeason === "spring"
            ? `Members who already paid or were charged in Fall ${data.label} are skipped automatically.`
            : `Already-covered members for ${data.label} are skipped automatically.`
        }
        confirmLabel={
          busy
            ? "Charging…"
            : confirmBulkSeason === "fall"
              ? `Confirm & Charge (${String(data.fallFeeSek)} kr)`
              : `Confirm & Charge (${String(data.springFeeSek)} kr)`
        }
        onCancel={() => {
          if (!busy) setConfirmBulkSeason(null);
        }}
        onConfirm={() => {
          if (confirmBulkSeason) void runCharge(confirmBulkSeason, selectedList);
        }}
      />

      <ConfirmDialog
        open={pendingClear !== null}
        title={pendingClear?.status === "exempt" ? "Clear Exempt Mark?" : "Clear External Mark?"}
        description={
          pendingClear
            ? `Remove the ${pendingClear.status === "exempt" ? "exempt" : "external Fall payment"} status for ${pendingClear.displayName} (${data.label})? Their club fee status will revert to Not Charged.`
            : ""
        }
        confirmLabel={busy ? "Clearing…" : "Clear Mark"}
        destructive
        onCancel={() => {
          if (!busy) setPendingClear(null);
        }}
        onConfirm={() => {
          if (pendingClear) void runClearExternal(pendingClear);
        }}
      />
    </section>
  );
}
