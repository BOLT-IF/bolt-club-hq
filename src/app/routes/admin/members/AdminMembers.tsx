import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import {
  BottomSheet,
  Button,
  ConfirmDialog,
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

/** Admin member list: roles (last-admin protected), deactivate/reactivate, payment reference. */
export function AdminMembers() {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [confirming, setConfirming] = useState<MemberRow | null>(null);
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

  async function change(path: string, body: unknown, done: string): Promise<boolean> {
    try {
      await apiFetch(path, { method: "PATCH", body });
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
      {state.members.length === 0 ? (
        <EmptyState title="No members yet">Members appear here once they join.</EmptyState>
      ) : (
        <ul className="bcq-members">
          {state.members.map((m) => {
            const status = STATUS_LABEL[m.status];
            const switchable = m.status === "active" || m.status === "inactive";
            return (
              <li key={m.id} className="bcq-member" aria-label={m.displayName}>
                <div className="bcq-member__head">
                  <h2 className="bcq-member__name">{m.displayName}</h2>
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                  <StatusChip tone={m.role === "admin" ? "info" : "neutral"}>
                    {m.role === "admin" ? "Admin" : "Member"}
                  </StatusChip>
                </div>
                <p className="bcq-member__meta">
                  Payment reference <strong>{m.paymentRef}</strong>
                  {m.email ? ` · ${m.email}` : ""}
                </p>
                {switchable ? (
                  <div className="bcq-member__actions">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void change(
                          `/members/${m.id}/role`,
                          { role: m.role === "admin" ? "member" : "admin" },
                          "Role updated",
                        )
                      }
                    >
                      {m.role === "admin" ? "Make member" : "Make admin"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing(m);
                      }}
                    >
                      Edit payment reference
                    </Button>
                    {m.status === "active" ? (
                      <Button
                        variant="danger"
                        onClick={() => {
                          setConfirming(m);
                        }}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void change(
                            `/members/${m.id}/status`,
                            { status: "active" },
                            "Member reactivated",
                          )
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={`Deactivate ${confirming?.displayName ?? "member"}?`}
        description="Their future RSVPs are cancelled (late-cancel rules apply). They keep access to Money and attendance only, and any balance stays due."
        confirmLabel="Deactivate member"
        destructive
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target)
            void change(
              `/members/${target.id}/status`,
              { status: "inactive" },
              "Member deactivated",
            );
        }}
      />

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
