import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import type { StatusTone } from "../../../components/ui";
import { describeError } from "../../members/memberApi";
import "../../members/members.css";

interface JoinRequestRow {
  readonly id: string;
  readonly memberId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly via: "invite" | "event_link" | "series_link";
  readonly source: string | null;
  readonly createdAt: string;
}

interface InviteRow {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly uses: number;
  readonly state: "active" | "revoked" | "expired" | "used_up";
}

const VIA: Record<JoinRequestRow["via"], string> = {
  invite: "Invite link",
  event_link: "Event link",
  series_link: "Series link",
};

const INVITE_STATE: Record<InviteRow["state"], { label: string; tone: StatusTone }> = {
  active: { label: "Active", tone: "success" },
  revoked: { label: "Revoked", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  used_up: { label: "Used up", tone: "neutral" },
};

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Stockholm",
});

const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly requests: readonly JoinRequestRow[];
      readonly invites: readonly InviteRow[];
    };

async function fetchAll() {
  const [{ requests }, { invites }] = await Promise.all([
    apiFetch<{ requests: JoinRequestRow[] }>("/admin/join-requests"),
    apiFetch<{ invites: InviteRow[] }>("/invites"),
  ]);
  return { requests, invites };
}

/** Admin approval queue (S1.3): approve or reject join requests, create and revoke invites. */
export function AdminApprovals() {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [rejecting, setRejecting] = useState<JoinRequestRow | null>(null);
  const [revoking, setRevoking] = useState<InviteRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchAll()
        .then((data) => {
          setState({ kind: "ready", ...data });
        })
        .catch(() => {
          setState({ kind: "error" });
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", ...data });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(id: string, path: string, method: "POST" | "DELETE", done: string) {
    setBusy(id);
    try {
      await apiFetch(path, { method });
      toast.show(done, "success");
      await load();
    } catch (error) {
      toast.show(describeError(error), "danger");
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading") return <Skeleton label="Loading join requests" />;
  if (state.kind === "error") {
    return (
      <ErrorState title="Couldn't load join requests" onRetry={() => void load()}>
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  return (
    <section className="bcq-page" aria-labelledby="approvals-title">
      <h1 id="approvals-title" className="bcq-page__title">
        Join requests
      </h1>
      {state.requests.length === 0 ? (
        <EmptyState title="No one is waiting">
          New requests show up here and in your inbox.
        </EmptyState>
      ) : (
        <ul className="bcq-members">
          {state.requests.map((r) => (
            <li key={r.id} className="bcq-member" aria-label={r.displayName}>
              <div className="bcq-member__head">
                <h2 className="bcq-member__name">{r.displayName}</h2>
                <StatusChip tone="warning">Pending</StatusChip>
              </div>
              <p className="bcq-member__meta">
                {VIA[r.via]}
                {r.source ? `: ${r.source}` : ""}
                {" · "}
                <time dateTime={r.createdAt}>{dateFormat.format(new Date(r.createdAt))}</time>
                {r.email ? ` · ${r.email}` : ""}
              </p>
              <div className="bcq-member__actions">
                <Button
                  aria-label={`Approve ${r.displayName}`}
                  disabled={busy === r.id}
                  onClick={() =>
                    void act(r.id, `/join-requests/${r.id}/approve`, "POST", "Member approved")
                  }
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  aria-label={`Reject ${r.displayName}`}
                  disabled={busy === r.id}
                  onClick={() => {
                    setRejecting(r);
                  }}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Invites
        invites={state.invites}
        onCreated={() => void load()}
        onRevoke={(invite) => {
          setRevoking(invite);
        }}
      />

      <ConfirmDialog
        open={rejecting !== null}
        title={`Reject ${rejecting?.displayName ?? "request"}?`}
        description="They stay signed in but get no access. They can ask again from a new link."
        confirmLabel="Reject request"
        destructive
        onCancel={() => {
          setRejecting(null);
        }}
        onConfirm={() => {
          const target = rejecting;
          setRejecting(null);
          if (target)
            void act(target.id, `/join-requests/${target.id}/reject`, "POST", "Request rejected");
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this invite link?"
        description="Nobody can use it to ask to join any more. Requests already made stay in the queue."
        confirmLabel="Revoke invite"
        destructive
        onCancel={() => {
          setRevoking(null);
        }}
        onConfirm={() => {
          const target = revoking;
          setRevoking(null);
          if (target) void act(target.id, `/invites/${target.id}`, "DELETE", "Invite revoked");
        }}
      />
    </section>
  );
}

function Invites({
  invites,
  onCreated,
  onRevoke,
}: {
  readonly invites: readonly InviteRow[];
  readonly onCreated: () => void;
  readonly onRevoke: (invite: InviteRow) => void;
}) {
  const toast = useToast();
  const [days, setDays] = useState("14");
  const [maxUses, setMaxUses] = useState("10");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch<{ invite: InviteRow }>("/invites", {
        method: "POST",
        body: { expiresInDays: Number(days), maxUses: Number(maxUses) },
      });
      setCreated(inviteUrl(res.invite.token));
      onCreated();
    } catch {
      toast.show("Use 1 to 90 days and 1 to 1000 uses.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="invites-title">
      <h2 id="invites-title" className="bcq-page__title">
        Invite links
      </h2>
      <form className="bcq-form" onSubmit={(e) => void submit(e)}>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="invite-days">
            Valid for (days)
          </label>
          <input
            id="invite-days"
            className="bcq-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
            }}
          />
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="invite-uses">
            Max uses
          </label>
          <input
            id="invite-uses"
            className="bcq-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => {
              setMaxUses(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={busy}>
          Create invite link
        </Button>
      </form>
      {created ? (
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="invite-link">
            New invite link
          </label>
          <input
            id="invite-link"
            className="bcq-input"
            readOnly
            value={created}
            onFocus={(e) => {
              e.target.select();
            }}
            aria-describedby="invite-link-hint"
          />
          <p id="invite-link-hint" className="bcq-field__hint">
            Copy it and send it to the person you&apos;re inviting.
          </p>
        </div>
      ) : null}
      {invites.length > 0 ? (
        <ul className="bcq-members">
          {invites.map((inv) => {
            const status = INVITE_STATE[inv.state];
            const label = `Invite used ${String(inv.uses)} of ${String(inv.maxUses)}`;
            return (
              <li key={inv.id} className="bcq-member" aria-label={label}>
                <div className="bcq-member__head">
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                  <span>{label}</span>
                </div>
                <p className="bcq-member__meta">
                  Expires{" "}
                  <time dateTime={inv.expiresAt}>{dateFormat.format(new Date(inv.expiresAt))}</time>
                </p>
                {inv.state === "active" ? (
                  <div className="bcq-member__actions">
                    <Button
                      variant="danger"
                      onClick={() => {
                        onRevoke(inv);
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
