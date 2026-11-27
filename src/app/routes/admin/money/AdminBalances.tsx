import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  Button,
  ChevronRightIcon,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { useFeatureFlag, useFeatureFlagsLoaded } from "../../../lib/flags";
import { navigate } from "../../../lib/navigate";
import { AssignPassSheet } from "./AssignPassSheet";
import {
  balanceTone,
  describeBalance,
  describeError,
  type AdminPassRow,
  type BalanceRow,
} from "./moneyApi";
import "../../members/members.css";
import "./money.css";

type Filter = "all" | "owes" | "credit" | "inactive" | "revocable";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "owes", label: "Owes Money" },
  { value: "credit", label: "In Credit" },
  { value: "inactive", label: "Inactive With Balance" },
  { value: "revocable", label: "Revocable" },
];

function ReceiptIcon() {
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
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 17.5v-11" />
    </svg>
  );
}

function TicketIcon() {
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
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  );
}

function CoinsIcon() {
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
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
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

function compareBalanceRows(a: BalanceRow, b: BalanceRow): number {
  const rank = (row: BalanceRow) => (row.balanceSek > 0 ? 0 : row.balanceSek < 0 ? 1 : 2);
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  if (a.balanceSek > 0) {
    const oweDiff = b.balanceSek - a.balanceSek;
    if (oweDiff !== 0) return oweDiff;
  } else if (a.balanceSek < 0) {
    const creditDiff = a.balanceSek - b.balanceSek;
    if (creditDiff !== 0) return creditDiff;
  }
  return a.displayName.localeCompare(b.displayName);
}

const matchesFilter = (row: BalanceRow, filter: Filter) => {
  switch (filter) {
    case "all":
      return true;
    case "owes":
      return row.balanceSek > 0;
    case "credit":
      return row.balanceSek < 0;
    case "inactive":
      return row.status === "inactive" && row.balanceSek !== 0;
    case "revocable":
      return false;
  }
};

const matchesSearch = (row: BalanceRow, query: string) => {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    row.displayName.toLowerCase().includes(q) ||
    row.paymentRef.toLowerCase().includes(q)
  );
};

const matchesPassSearch = (pass: AdminPassRow, query: string) => {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    pass.memberName.toLowerCase().includes(q) ||
    pass.paymentRef.toLowerCase().includes(q) ||
    pass.seriesName.toLowerCase().includes(q)
  );
};

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly rows: readonly BalanceRow[];
      readonly passes: readonly AdminPassRow[];
      readonly pendingClaimsCount: number;
    };

/** Admin balances (PLAN §9): search by name or payment reference, filter, open a member. */
export function AdminBalances() {
  const flagsLoaded = useFeatureFlagsLoaded();
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pendingRevoke, setPendingRevoke] = useState<AdminPassRow | null>(null);
  const [revokeKey, setRevokeKey] = useState(newIdempotencyKey);
  const [revoking, setRevoking] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  const load = useCallback((isCancelled: () => boolean = () => false) => {
    Promise.all([
      apiFetch<{ members: BalanceRow[] }>("/admin/balances"),
      apiFetch<{ passes?: AdminPassRow[] }>("/admin/passes", {
        redirectOnUnauthorized: false,
      }).catch(() => null),
      apiFetch<{ claims?: unknown[] }>("/admin/payment-claims", {
        redirectOnUnauthorized: false,
      }).catch(() => null),
    ])
      .then(([balancesData, passesData, claimsData]) => {
        if (!isCancelled()) {
          const passes = Array.isArray(passesData?.passes) ? passesData.passes : [];
          const pendingClaimsCount = Array.isArray(claimsData?.claims)
            ? claimsData.claims.length
            : 0;
          setState({ kind: "ready", rows: balancesData.members, passes, pendingClaimsCount });
        }
      })
      .catch(() => {
        if (!isCancelled()) setState({ kind: "error" });
      });
  }, []);

  useEffect(() => {
    if (!moneyOn) return;
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [moneyOn, load]);

  if (!flagsLoaded) {
    return <Skeleton label="Loading balances" />;
  }
  if (!moneyOn) {
    return <EmptyState title="Money">Money is not switched on yet.</EmptyState>;
  }
  if (state.kind === "loading") return <Skeleton label="Loading balances" />;
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load balances"
        onRetry={() => {
          setState({ kind: "loading" });
          load();
        }}
      >
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  const isRevocableView = filter === "revocable";
  const rows = isRevocableView
    ? []
    : [...state.rows]
        .filter((r) => matchesFilter(r, filter) && matchesSearch(r, query))
        .sort(compareBalanceRows);
  const revocablePasses = isRevocableView
    ? state.passes.filter((p) => p.revocable && matchesPassSearch(p, query))
    : [];
  const totalOwed = state.rows.reduce((sum, r) => sum + r.owedSek, 0);
  const owesCount = state.rows.filter((r) => r.balanceSek > 0).length;

  const handleConfirmRevoke = () => {
    if (!pendingRevoke || revoking) return;
    setRevoking(true);
    apiFetch(`/admin/passes/${pendingRevoke.id}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
      idempotencyKey: revokeKey,
    })
      .then(() => {
        toast.show(`Revoked ${pendingRevoke.memberName}'s pass.`, "success");
        setPendingRevoke(null);
        setRevokeKey(newIdempotencyKey());
        load();
      })
      .catch((error: unknown) => {
        const code =
          error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined;
        if (code !== "idempotency_key_in_progress") {
          setRevokeKey(newIdempotencyKey());
        }
        toast.show(describeError(error), "danger");
      })
      .finally(() => {
        setRevoking(false);
      });
  };

  return (
    <section className="bcq-page bcq-money-page" aria-labelledby="admin-balances-title">
      <div>
        <h1 id="admin-balances-title" className="bcq-page__title">
          Balances
        </h1>
        <p className="bcq-money-subtitle">
          Members owe <span className="bcq-tabular-nums">{totalOwed}</span> kr in total
        </p>
      </div>
      <div className="bcq-money-strip" role="navigation" aria-label="Money quick actions">
        <a
          className="bcq-money-action-pill"
          href="/admin/money/claims"
          aria-label={
            state.pendingClaimsCount > 0
              ? `Payment Claims (${String(state.pendingClaimsCount)} pending)`
              : "Payment Claims"
          }
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/money/claims");
          }}
        >
          <span className="bcq-money-action-pill__icon" aria-hidden="true">
            <ReceiptIcon />
          </span>
          <span>Payment Claims</span>
          {state.pendingClaimsCount > 0 ? (
            <span className="bcq-money-action-pill__badge" aria-hidden="true">
              {state.pendingClaimsCount}
            </span>
          ) : null}
          <span className="bcq-money-action-pill__chevron" aria-hidden="true">
            <ChevronRightIcon />
          </span>
        </a>
        <button
          type="button"
          className="bcq-money-action-pill"
          onClick={() => {
            setAssignOpen(true);
          }}
        >
          <span className="bcq-money-action-pill__icon" aria-hidden="true">
            <TicketIcon />
          </span>
          <span>Assign Pass</span>
          <span className="bcq-money-action-pill__chevron" aria-hidden="true">
            <ChevronRightIcon />
          </span>
        </button>
        <a
          className="bcq-money-action-pill"
          href="/admin/money/club-fees"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/money/club-fees");
          }}
        >
          <span className="bcq-money-action-pill__icon" aria-hidden="true">
            <CoinsIcon />
          </span>
          <span>Club Fees</span>
          <span className="bcq-money-action-pill__chevron" aria-hidden="true">
            <ChevronRightIcon />
          </span>
        </a>
      </div>

      <div className="bcq-card bcq-money-search-card">
        <div>
          <label className="bcq-visually-hidden" htmlFor="balances-search">
            Search Name or Payment Reference
          </label>
          <div className="bcq-search">
            <span className="bcq-search__icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              id="balances-search"
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
          <div className="bcq-filter-row">
            {FILTERS.map((f) => {
              const active = filter === f.value;
              const label =
                f.value === "owes" && owesCount > 0 ? `${f.label} (${String(owesCount)})` : f.label;
              return (
                <label
                  key={f.value}
                  className={active ? "bcq-money-filter-chip is-active" : "bcq-money-filter-chip"}
                >
                  <input
                    type="radio"
                    name="balances-filter"
                    value={f.value}
                    checked={active}
                    onChange={() => {
                      setFilter(f.value);
                    }}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      {isRevocableView ? (
        <>
          {revocablePasses.length === 0 ? (
            <EmptyState title="No Revocable Passes">
              No unpaid passes are past the revocation window.
            </EmptyState>
          ) : null}
          <ul className="bcq-members" aria-label="Balances">
            {revocablePasses.map((p) => (
              <li key={p.id} className="bcq-member bcq-money-revocable-card">
                <a
                  className="bcq-money-row"
                  href={`/admin/money/members/${p.memberId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/admin/money/members/${p.memberId}`);
                  }}
                >
                  <span className="bcq-money-row__top">
                    <span className="bcq-money-row__name">{p.memberName}</span>
                    <StatusChip tone="warning">Unpaid {p.unpaidSek} kr</StatusChip>
                  </span>
                  <span className="bcq-money-row__meta">
                    Payment reference <span className="bcq-mono-code">{p.paymentRef}</span> ·{" "}
                    {p.seriesName} ({p.termName}) · {p.daysElapsed}d unpaid
                  </span>
                </a>
                <div>
                  <Button
                    variant="destructive-tonal"
                    onClick={() => {
                      setRevokeKey(newIdempotencyKey());
                      setPendingRevoke(p);
                    }}
                  >
                    Revoke Pass
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyState title="No Members Match">Try another search or filter.</EmptyState>
          ) : null}
          <ul className="bcq-members" aria-label="Balances">
            {rows.map((r) => (
              <li key={r.id} className="bcq-member bcq-money-member-card">
                <a
                  className="bcq-money-row bcq-money-row--nav"
                  href={`/admin/money/members/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/admin/money/members/${r.id}`);
                  }}
                >
                  <span className="bcq-money-row__main">
                    <span className="bcq-money-row__title-wrap">
                      <span className="bcq-money-row__name">{r.displayName}</span>
                      {r.status !== "active" ? (
                        <StatusChip tone="neutral">
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </StatusChip>
                      ) : null}
                    </span>
                    <span className="bcq-money-row__meta">
                      Payment reference <span className="bcq-mono-code">{r.paymentRef}</span>
                    </span>
                  </span>
                  <span className="bcq-money-row__trailing">
                    <StatusChip tone={balanceTone(r.balanceSek)}>
                      {describeBalance(r.balanceSek)}
                    </StatusChip>
                    <span className="bcq-grouped-row__chevron" aria-hidden="true">
                      <ChevronRightIcon />
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke pass?"
        description={
          pendingRevoke
            ? `Revoke ${pendingRevoke.memberName}'s ${pendingRevoke.seriesName} pass? This reverses the ${String(pendingRevoke.priceCharged)} kr charge, frees the seat, and downgrades their open RSVPs to tier 2.`
            : ""
        }
        confirmLabel={revoking ? "Revoking..." : "Confirm revocation"}
        destructive
        onCancel={() => {
          if (!revoking) setPendingRevoke(null);
        }}
        onConfirm={handleConfirmRevoke}
      />

      {assignOpen ? (
        <AssignPassSheet
          members={state.rows}
          onClose={() => {
            setAssignOpen(false);
          }}
          onAssigned={({ displayName }) => {
            toast.show(`Assigned pass to ${displayName}.`, "success");
            setAssignOpen(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}
