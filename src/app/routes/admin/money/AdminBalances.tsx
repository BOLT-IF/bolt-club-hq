import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../api/client";
import { EmptyState, ErrorState, Skeleton, StatusChip } from "../../../components/ui";
import { useFeatureFlag } from "../../../lib/flags";
import { navigate } from "../../../lib/navigate";
import { balanceTone, describeBalance, type BalanceRow } from "./moneyApi";
import "../../members/members.css";
import "./money.css";

type Filter = "all" | "owes" | "credit" | "inactive";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "owes", label: "Owes money" },
  { value: "credit", label: "In credit" },
  { value: "inactive", label: "Inactive with balance" },
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

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly rows: readonly BalanceRow[] };

/** Admin balances (PLAN §9): search by name or payment reference, filter, open a member. */
export function AdminBalances() {
  const moneyOn = useFeatureFlag("money");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback((isCancelled: () => boolean = () => false) => {
    apiFetch<{ members: BalanceRow[] }>("/admin/balances")
      .then((data) => {
        if (!isCancelled()) setState({ kind: "ready", rows: data.members });
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

  const rows = state.rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query));
  const totalOwed = state.rows.reduce((sum, r) => sum + r.owedSek, 0);

  return (
    <section className="bcq-page" aria-labelledby="admin-balances-title">
      <h1 id="admin-balances-title" className="bcq-page__title">
        Balances
      </h1>
      <p className="bcq-member__meta">Members owe {totalOwed} kr in total.</p>

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
    </section>
  );
}
