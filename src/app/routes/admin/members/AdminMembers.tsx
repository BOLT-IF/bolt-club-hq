import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import { navigate } from "../../../lib/navigate";
import {
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import type { StatusTone } from "../../../components/ui";
import { describeError, type MemberRow } from "../../members/memberApi";
import "../../members/members.css";

const STATUS_LABEL: Record<MemberRow["status"], { label: string; tone: StatusTone }> = {
  pending: { label: "Pending", tone: "warning" },
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  erased: { label: "Erased", tone: "neutral" },
};

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly members: readonly MemberRow[] };

function MoreHorizontalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
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

/** Admin member list: roles (last-admin protected), deactivate/reactivate, payment reference. */
export function AdminMembers() {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selected, setSelected] = useState<MemberRow | null>(null);
  const [editing, setEditing] = useState<MemberRow | null>(null);

  const load = useCallback(
    () =>
      apiFetch<{ members: MemberRow[] }>("/admin/members")
        .then((data) => {
          setState({ kind: "ready", members: data.members });
        })
        .catch(() => {
          setState({ kind: "error" });
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ members: MemberRow[] }>("/admin/members")
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", members: data.members });
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

  if (state.kind === "loading") return <Skeleton label="Loading members" />;
  if (state.kind === "error") {
    return (
      <ErrorState title="Couldn't load members" onRetry={() => void load()}>
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  return (
    <section className="bcq-page" aria-labelledby="admin-members-title">
      <h1 id="admin-members-title" className="bcq-page__title">
        Members
      </h1>
      <p className="bcq-field__hint bcq-member__invite-banner">
        Need to invite someone?{" "}
        <a
          className="bcq-member__invite-link"
          href="/admin/approvals"
          onClick={(e) => {
            e.preventDefault();
            navigate("/admin/approvals");
          }}
        >
          Create an Invite Link
        </a>
        .
      </p>
      {state.members.length === 0 ? (
        <EmptyState title="No members yet">Members appear here once they join.</EmptyState>
      ) : (
        <ul className="bcq-members">
          {state.members.map((m) => {
            const status = STATUS_LABEL[m.status];
            const switchable = m.status === "active" || m.status === "inactive";
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
                  <h2 className="bcq-member__name">{m.displayName}</h2>
                  {switchable ? (
                    <button
                      type="button"
                      className="bcq-member__overflow"
                      aria-label={`Actions for ${m.displayName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(m);
                      }}
                    >
                      <MoreHorizontalIcon />
                    </button>
                  ) : null}
                </div>
                <div className="bcq-member__badges">
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                  <StatusChip tone={m.role === "admin" ? "info" : "neutral"}>
                    {m.role === "admin" ? "Admin" : "Member"}
                  </StatusChip>
                </div>
                <div className="bcq-member__meta-stack">
                  <p className="bcq-member__meta">
                    Payment reference: <strong>{m.paymentRef}</strong>
                  </p>
                  {m.email ? <p className="bcq-member__meta">{m.email}</p> : null}
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
  onClose,
  onToggleRole,
  onEditPaymentRef,
  onDeactivate,
  onReactivate,
}: {
  readonly member: MemberRow;
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
            {member.paymentRef}
          </p>
        </div>

        <div className="bcq-action-sheet__list">
          <button
            type="button"
            className="bcq-action-sheet__btn bcq-action-sheet__btn--tonal"
            disabled={busy}
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
                disabled={busy}
                onClick={() => {
                  setConfirmDeactivate(true);
                }}
              >
                <UserXIcon />
                <span>Deactivate Member</span>
              </button>
            </>
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
