import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import { navigate } from "../../../lib/navigate";
import {
  BottomSheet,
  Button,
  CompactEmptyState,
  ErrorState,
  OverflowButton,
  Skeleton,
  StatusChip,
  useToast,
  type StatusTone,
} from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { describeError, type MemberRow } from "../../members/memberApi";
import "../../members/members.css";

const STATUS_LABEL: Record<MemberRow["status"], { label: string; tone: StatusTone }> = {
  pending: { label: "Pending", tone: "warning" },
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  erased: { label: "Erased", tone: "neutral" },
};

type FilterKey = "all" | "active" | "admins" | "inactive";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly members: readonly MemberRow[];
      readonly currentUserId: string | null;
    };

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
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
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ShieldIcon() {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function PencilIcon() {
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
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function UserXIcon() {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="17" y1="8" x2="22" y2="13" />
      <line x1="22" y1="8" x2="17" y2="13" />
    </svg>
  );
}

function UserCheckIcon() {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

/** Admin member list: search, filter chips, role/status management, self-protection guardrail. */
export function AdminMembers() {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<MemberRow | null>(null);
  const [editing, setEditing] = useState<MemberRow | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ members: MemberRow[] }>("/admin/members");
      setState((prev) => ({
        kind: "ready",
        members: data.members,
        currentUserId: prev.kind === "ready" ? prev.currentUserId : null,
      }));
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ members: MemberRow[] }>("/admin/members"),
      apiFetch<{ id?: string }>("/me", { redirectOnUnauthorized: false }).catch(() => null),
    ])
      .then(([data, me]) => {
        if (!cancelled) {
          setState({
            kind: "ready",
            members: data.members,
            currentUserId: typeof me?.id === "string" ? me.id : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function change(
    path: string,
    body: unknown,
    done: string,
    method: "PATCH" | "POST" = "PATCH",
  ): Promise<boolean> {
    try {
      await apiFetch(path, body === undefined ? { method } : { method, body });
      toast.show(done, "success");
      await load();
      return true;
    } catch (error) {
      toast.show(describeError(error), "danger");
      return false;
    }
  }

  const members = state.kind === "ready" ? state.members : [];
  const counts = useMemo(
    () => ({
      all: members.length,
      active: members.filter((m) => m.status === "active").length,
      admins: members.filter((m) => m.role === "admin").length,
      inactive: members.filter((m) => m.status === "inactive").length,
    }),
    [members],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      if (filter === "active" && m.status !== "active") return false;
      if (filter === "admins" && m.role !== "admin") return false;
      if (filter === "inactive" && m.status !== "inactive") return false;
      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        (m.email?.toLowerCase().includes(q) ?? false) ||
        m.paymentRef.toLowerCase().includes(q)
      );
    });
  }, [members, filter, query]);

  if (state.kind === "loading") return <Skeleton label="Loading members" />;
  if (state.kind === "error") {
    return (
      <ErrorState title="Couldn't load members" onRetry={() => void load()}>
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  const filterChips: ReadonlyArray<{ key: FilterKey; label: string }> = [
    { key: "all", label: `All (${String(counts.all)})` },
    { key: "active", label: `Active (${String(counts.active)})` },
    { key: "admins", label: `Admins (${String(counts.admins)})` },
    { key: "inactive", label: `Inactive (${String(counts.inactive)})` },
  ];

  const hasActiveFilters = query.trim().length > 0 || filter !== "all";

  return (
    <section className="bcq-page bcq-members-page" aria-labelledby="admin-members-title">
      <div className="bcq-page-head">
        <div className="bcq-page-head__title-group">
          <h1 id="admin-members-title" className="bcq-page__title">
            Members
          </h1>
          <span
            className="bcq-count-pill"
            aria-label={`${String(state.members.length)} total members`}
          >
            {state.members.length}
          </span>
        </div>
        <a
          href="/admin/approvals"
          className="bcq-btn bcq-btn--primary bcq-btn--compact"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/admin/approvals");
          }}
        >
          <PlusIcon />
          <span>Invite</span>
        </a>
      </div>

      {state.members.length > 0 ? (
        <div className="bcq-member-controls">
          <div className="bcq-search">
            <span className="bcq-search__icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="search"
              className="bcq-search__input"
              aria-label="Search members"
              placeholder="Search name, email, or ref"
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

          <div className="bcq-filter-row" role="group" aria-label="Filter members">
            {filterChips.map((chip) => {
              const active = filter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  className={cx("bcq-filter-chip", active && "is-active")}
                  aria-pressed={active}
                  onClick={() => {
                    setFilter(chip.key);
                  }}
                >
                  <span className="bcq-filter-chip__pill">{chip.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {state.members.length === 0 ? (
        <CompactEmptyState title="No Members Yet">
          Members appear here once they join
        </CompactEmptyState>
      ) : filtered.length === 0 ? (
        <CompactEmptyState
          title="No Matching Members"
          icon={<SearchIcon />}
          action={
            hasActiveFilters ? (
              <Button
                variant="tonal"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear Filters
              </Button>
            ) : undefined
          }
        >
          Try another search term or filter
        </CompactEmptyState>
      ) : (
        <ul className="bcq-members">
          {filtered.map((m) => {
            const status = STATUS_LABEL[m.status];
            const switchable = m.status === "active" || m.status === "inactive";
            const isSelf = state.currentUserId !== null && m.id === state.currentUserId;
            return (
              <li
                key={m.id}
                className={switchable ? "bcq-member bcq-member--interactive" : "bcq-member"}
                aria-label={m.displayName}
                onClick={
                  switchable
                    ? () => {
                        setSelected(m);
                      }
                    : undefined
                }
              >
                <div className="bcq-member__top">
                  <h2 className="bcq-member__name">
                    <span>{m.displayName}</span>
                    {isSelf ? <span className="bcq-member__you">You</span> : null}
                  </h2>
                  {switchable ? (
                    <OverflowButton
                      label={`Actions for ${m.displayName}`}
                      className="bcq-member__overflow-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(m);
                      }}
                    />
                  ) : null}
                </div>
                <div className="bcq-member__badges">
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                  <StatusChip tone={m.role === "admin" ? "info" : "neutral"}>
                    {m.role === "admin" ? "Admin" : "Member"}
                  </StatusChip>
                </div>
                <div className="bcq-member__meta-stack">
                  <p className="bcq-member__ref">
                    <span className="bcq-member__ref-label">Ref</span>{" "}
                    <code className="bcq-mono-code">{m.paymentRef}</code>
                  </p>
                  {m.email ? <p className="bcq-member__email">{m.email}</p> : null}
                </div>
                {m.status === "pending" ? (
                  <div className="bcq-member__actions">
                    <Button
                      aria-label={`Approve ${m.displayName}`}
                      onClick={() =>
                        void change(
                          `/members/${m.id}/approve`,
                          undefined,
                          "Member approved",
                          "POST",
                        )
                      }
                    >
                      Approve
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {selected ? (
        <MemberActionSheet
          member={selected}
          isSelf={state.currentUserId !== null && selected.id === state.currentUserId}
          onClose={() => {
            setSelected(null);
          }}
          onToggleRole={async () => {
            const ok = await change(
              `/members/${selected.id}/role`,
              { role: selected.role === "admin" ? "member" : "admin" },
              "Role updated",
            );
            if (ok) setSelected(null);
          }}
          onEditPaymentRef={() => {
            const target = selected;
            setSelected(null);
            setEditing(target);
          }}
          onDeactivate={async () => {
            const ok = await change(
              `/members/${selected.id}/status`,
              { status: "inactive" },
              "Member deactivated",
            );
            if (ok) setSelected(null);
          }}
          onReactivate={async () => {
            const ok = await change(
              `/members/${selected.id}/status`,
              { status: "active" },
              "Member reactivated",
            );
            if (ok) setSelected(null);
          }}
        />
      ) : null}

      {editing ? (
        <PaymentRefSheet
          member={editing}
          onClose={() => {
            setEditing(null);
          }}
          onSave={(paymentRef) =>
            change(`/members/${editing.id}`, { paymentRef }, "Payment reference saved")
          }
        />
      ) : null}
    </section>
  );
}

function MemberActionSheet({
  member,
  isSelf,
  onClose,
  onToggleRole,
  onEditPaymentRef,
  onDeactivate,
  onReactivate,
}: {
  readonly member: MemberRow;
  readonly isSelf: boolean;
  readonly onClose: () => void;
  readonly onToggleRole: () => Promise<void>;
  readonly onEditPaymentRef: () => void;
  readonly onDeactivate: () => Promise<void>;
  readonly onReactivate: () => Promise<void>;
}) {
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  if (confirmDeactivate) {
    return (
      <BottomSheet
        open
        title={`Deactivate ${member.displayName}?`}
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="bcq-action-sheet">
          <p className="bcq-action-sheet__confirm-copy">
            Their future RSVPs are cancelled (late-cancel rules apply). They keep access to Money
            and attendance only, and any balance stays due.
          </p>
          <div className="bcq-action-sheet__list">
            <button
              type="button"
              className="bcq-action-sheet__btn bcq-action-sheet__btn--danger-solid"
              disabled={busy}
              onClick={() => void run(onDeactivate)}
            >
              Deactivate
            </button>
            <button
              type="button"
              className="bcq-action-sheet__btn bcq-action-sheet__btn--tonal"
              style={{ justifyContent: "center" }}
              disabled={busy}
              onClick={() => {
                setConfirmDeactivate(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </BottomSheet>
    );
  }

  const blockRemoveAdmin = isSelf && member.role === "admin";
  const blockDeactivate = isSelf && member.status === "active";

  return (
    <BottomSheet
      open
      title={member.displayName}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="bcq-action-sheet">
        <div className="bcq-action-sheet__context">
          <p className="bcq-action-sheet__sub">
            {member.email ? `${member.email} · ` : ""}
            <code className="bcq-mono-code">{member.paymentRef}</code>
          </p>
        </div>

        <div className="bcq-action-sheet__list">
          <button
            type="button"
            className="bcq-action-sheet__btn bcq-action-sheet__btn--tonal"
            disabled={busy || blockRemoveAdmin}
            onClick={() => void run(onToggleRole)}
          >
            <ShieldIcon />
            <span>{member.role === "admin" ? "Remove Admin" : "Make Admin"}</span>
          </button>

          <button
            type="button"
            className="bcq-action-sheet__btn bcq-action-sheet__btn--tonal"
            disabled={busy}
            onClick={onEditPaymentRef}
          >
            <PencilIcon />
            <span>Edit Payment Reference</span>
          </button>

          {member.status === "inactive" ? (
            <button
              type="button"
              className="bcq-action-sheet__btn bcq-action-sheet__btn--tonal"
              disabled={busy}
              onClick={() => void run(onReactivate)}
            >
              <UserCheckIcon />
              <span>Reactivate</span>
            </button>
          ) : null}

          {member.status === "active" ? (
            <>
              <hr className="bcq-action-sheet__divider" />
              <button
                type="button"
                className="bcq-action-sheet__btn bcq-action-sheet__btn--danger-tonal"
                disabled={busy || blockDeactivate}
                onClick={() => {
                  setConfirmDeactivate(true);
                }}
              >
                <UserXIcon />
                <span>Deactivate Member</span>
              </button>
            </>
          ) : null}

          {isSelf ? (
            <p className="bcq-action-sheet__note">
              You can&apos;t remove your own admin role or deactivate your own account
            </p>
          ) : null}

          <button
            type="button"
            className="bcq-action-sheet__btn bcq-action-sheet__btn--cancel"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function PaymentRefSheet({
  member,
  onClose,
  onSave,
}: {
  readonly member: MemberRow;
  readonly onClose: () => void;
  readonly onSave: (paymentRef: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(member.paymentRef);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    const ok = await onSave(value);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <BottomSheet open title={`Payment reference for ${member.displayName}`} onClose={onClose}>
      <form className="bcq-form" onSubmit={(e) => void submit(e)}>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="payment-ref">
            Payment reference
          </label>
          <input
            id="payment-ref"
            className="bcq-input"
            value={value}
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value);
            }}
            aria-describedby="payment-ref-hint"
          />
          <p id="payment-ref-hint" className="bcq-field__hint">
            What the member writes on their bank transfer. Must be unique.
          </p>
        </div>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </form>
    </BottomSheet>
  );
}
