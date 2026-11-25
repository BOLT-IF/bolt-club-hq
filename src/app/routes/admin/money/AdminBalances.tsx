import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { navigate } from "../../../lib/navigate";
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
  { value: "owes", label: "Owes money" },
  { value: "credit", label: "In credit" },
  { value: "inactive", label: "Inactive with balance" },
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
  const moneyOn = useFeatureFlag("money");
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pendingRevoke, setPendingRevoke] = useState<AdminPassRow | null>(null);
  const [revokeKey, setRevokeKey] = useState(newIdempotencyKey);
  const [revoking, setRevoking] = useState(false);

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
    <section className="bcq-page" aria-labelledby="admin-balances-title">
      <h1 id="admin-balances-title" className="bcq-page__title">
        Balances
      </h1>
      <p className="bcq-member__meta">Members owe {totalOwed} kr in total.</p>
      <p>
        <a
          className="bcq-btn bcq-btn--secondary"
          href="/admin/money/claims"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/money/claims");
          }}
        >
          Payment claims
        </a>
      </p>

      <div className="bcq-field">
        <label className="bcq-field__label" htmlFor="balances-search">
          Search name or payment reference
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

      <fieldset className="bcq-money-filters">
        <legend className="bcq-field__label">Show</legend>
        {FILTERS.map((f) => (
          <label key={f.value} className="bcq-money-filter">
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

      {isRevocableView ? (
        <>
          {revocablePasses.length === 0 ? (
            <EmptyState title="No revocable passes">
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
                    variant="danger"
                    onClick={() => {
                      setRevokeKey(newIdempotencyKey());
                      setPendingRevoke(p);
                    }}
                  >
                    Revoke pass
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyState title="No members match">Try another search or filter.</EmptyState>
          ) : null}
          <ul className="bcq-members" aria-label="Balances">
            {rows.map((r) => (
              <li key={r.id} className="bcq-member">
                <a
                  className="bcq-money-row"
                  href={`/admin/money/members/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/admin/money/members/${r.id}`);
                  }}
                >
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
    </section>
  );
}
