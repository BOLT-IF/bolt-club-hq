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
      apiFetch<{ passes?: AdminPassRow[] }>("/admin/passes").catch(() => null),
    ])
      .then(([balancesData, passesData]) => {
        if (!isCancelled()) {
          const passes = Array.isArray(passesData?.passes) ? passesData.passes : [];
          setState({ kind: "ready", rows: balancesData.members, passes });
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
    : state.rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query));
  const revocablePasses = isRevocableView
    ? state.passes.filter((p) => p.revocable && matchesPassSearch(p, query))
    : [];
  const totalOwed = state.rows.reduce((sum, r) => sum + r.owedSek, 0);

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
        <p className="bcq-member__meta">Members owe {totalOwed} kr in total.</p>
      </div>
      <div className="bcq-member__actions">
        <a
          className="bcq-btn bcq-btn--tonal"
          href="/admin/money/claims"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/money/claims");
          }}
        >
          Payment Claims
        </a>
        <Button
          variant="tonal"
          onClick={() => {
            setAssignOpen(true);
          }}
        >
          Assign Pass
        </Button>
        <a
          className="bcq-btn bcq-btn--tonal"
          href="/admin/money/club-fees"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/money/club-fees");
          }}
        >
          Club Fees
        </a>
      </div>

      <div className="bcq-card bcq-form">
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="balances-search">
            Search Name or Payment Reference
          </label>
          <input
            id="balances-search"
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
                name="balances-filter"
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

      {isRevocableView ? (
        <>
          {revocablePasses.length === 0 ? (
            <EmptyState title="No Revocable Passes">
              No unpaid passes are past the revocation window.
            </EmptyState>
          ) : null}
          <ul className="bcq-members" aria-label="Balances">
            {revocablePasses.map((p) => (
              <li key={p.id} className="bcq-member">
                <a
                  className="bcq-money-row"
                  href={`/admin/money/members/${p.memberId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/admin/money/members/${p.memberId}`);
                  }}
                >
                  <span className="bcq-member__head">
                    <span className="bcq-member__name">{p.memberName}</span>
                    <StatusChip tone="warning">Unpaid {p.unpaidSek} kr</StatusChip>
                  </span>
                  <span className="bcq-member__meta">
                    Payment reference {p.paymentRef} · {p.seriesName} ({p.termName}) ·{" "}
                    {p.daysElapsed}d unpaid
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
              <li key={r.id} className="bcq-member">
                <a
                  className="bcq-money-row bcq-money-row--nav"
                  href={`/admin/money/members/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/admin/money/members/${r.id}`);
                  }}
                >
                  <span className="bcq-money-row__main">
                    <span className="bcq-member__head">
                      <span className="bcq-member__name">{r.displayName}</span>
                      <StatusChip tone={balanceTone(r.balanceSek)}>
                        {describeBalance(r.balanceSek)}
                      </StatusChip>
                      {r.status !== "active" ? (
                        <StatusChip tone="neutral">
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </StatusChip>
                      ) : null}
                    </span>
                    <span className="bcq-member__meta">Payment reference {r.paymentRef}</span>
                  </span>
                  <span className="bcq-grouped-row__chevron" aria-hidden="true">
                    <ChevronRightIcon />
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
