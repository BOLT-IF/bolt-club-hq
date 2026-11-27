import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../../api/client";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { describeError, type MemberRow } from "../../members/memberApi";
import "../../members/members.css";
import "./approvals.css";

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
  readonly revokedAt?: string | null;
  readonly state: "active" | "revoked" | "expired" | "used_up";
}

const VIA: Record<JoinRequestRow["via"], string> = {
  invite: "Invite link",
  event_link: "Event link",
  series_link: "Series link",
};

const PAST_STATE_LABEL: Record<Exclude<InviteRow["state"], "active">, string> = {
  revoked: "Revoked",
  expired: "Expired",
  used_up: "Used Up",
};

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Stockholm",
});

const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;

function CheckCircleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function CopyIcon() {
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
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
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
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function BanIcon() {
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
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

function ChevronIcon({ open }: { readonly open: boolean }) {
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
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 140ms ease",
      }}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly requests: readonly JoinRequestRow[];
      readonly directPending: readonly MemberRow[];
      readonly invites: readonly InviteRow[];
    };

async function fetchAll() {
  const [{ requests }, { invites }, membersRes] = await Promise.all([
    apiFetch<{ requests: JoinRequestRow[] }>("/admin/join-requests"),
    apiFetch<{ invites: InviteRow[] }>("/invites"),
    apiFetch<{ members: MemberRow[] }>("/admin/members").catch(() => ({ members: [] })),
  ]);
  const requestedIds = new Set(requests.map((r) => r.memberId));
  const directPending = membersRes.members.filter(
    (m) => m.status === "pending" && !requestedIds.has(m.id),
  );
  return { requests, directPending, invites };
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
    <section className="bcq-page bcq-approvals" aria-labelledby="approvals-title">
      <div className="bcq-approvals__section">
        <h1 id="approvals-title" className="bcq-approvals__heading">
          Join Requests
        </h1>
        {state.requests.length === 0 && state.directPending.length === 0 ? (
          <div className="bcq-approvals__empty">
            <span className="bcq-approvals__empty-icon">
              <CheckCircleIcon />
            </span>
            <div className="bcq-approvals__empty-copy">
              <p className="bcq-approvals__empty-title">No Pending Requests</p>
              <p className="bcq-approvals__empty-sub">
                New requests appear here and in your inbox.
              </p>
            </div>
          </div>
        ) : null}
        {state.requests.length > 0 ? (
          <ul className="bcq-approvals__list">
            {state.requests.map((r) => (
              <li key={r.id} className="bcq-approvals__card" aria-label={r.displayName}>
                <div className="bcq-member__head">
                  <h2 className="bcq-member__name">{r.displayName}</h2>
                  <StatusChip tone="warning">Pending</StatusChip>
                </div>
                <p className="bcq-member__meta">
                  {VIA[r.via] ? (
                    <>
                      {VIA[r.via]}
                      {r.source ? `: ${r.source}` : ""}
                      {" · "}
                    </>
                  ) : null}
                  <time dateTime={r.createdAt}>{dateFormat.format(new Date(r.createdAt))}</time>
                  {r.email ? ` · ${r.email}` : ""}
                </p>
                <div className="bcq-approvals__actions">
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
                    variant="destructive-tonal"
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
        ) : null}
      </div>

      {state.directPending.length > 0 ? (
        <section className="bcq-approvals__section" aria-labelledby="direct-pending-title">
          <h2 id="direct-pending-title" className="bcq-approvals__heading">
            Signed In Without an Invite
          </h2>
          <ul className="bcq-approvals__list">
            {state.directPending.map((m) => (
              <li key={m.id} className="bcq-approvals__card" aria-label={m.displayName}>
                <div className="bcq-member__head">
                  <h3 className="bcq-member__name">{m.displayName}</h3>
                  <StatusChip tone="warning">Pending</StatusChip>
                </div>
                <p className="bcq-member__meta">
                  Signed in directly{m.email ? ` · ${m.email}` : ""}
                </p>
                <div className="bcq-approvals__actions">
                  <Button
                    aria-label={`Approve ${m.displayName}`}
                    disabled={busy === m.id}
                    onClick={() =>
                      void act(m.id, `/members/${m.id}/approve`, "POST", "Member approved")
                    }
                  >
                    Approve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
        confirmLabel="Reject Request"
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
        title="Revoke Invite Link?"
        description="People who haven't joined yet will no longer be able to use this link."
        confirmLabel="Revoke Link"
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

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

  async function copyLink(url: string, key: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      toast.show("Invite link copied", "success");
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      toast.show("Couldn't copy automatically — select the link to copy it.", "danger");
    }
  }

  const activeInvites = [...invites]
    .filter((i) => i.state === "active")
    .sort((a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime());
  const pastInvites = invites.filter((i) => i.state !== "active");

  return (
    <section className="bcq-approvals__section" aria-labelledby="invites-title">
      <h2 id="invites-title" className="bcq-approvals__heading">
        Invite Links
      </h2>

      <form className="bcq-approvals__card" onSubmit={(e) => void submit(e)}>
        <div className="bcq-approvals__grid2">
          <div>
            <label className="bcq-approvals__label" htmlFor="invite-days">
              Valid For (Days)
            </label>
            <input
              id="invite-days"
              className="bcq-approvals__input"
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
          <div>
            <label className="bcq-approvals__label" htmlFor="invite-uses">
              Max Uses
            </label>
            <input
              id="invite-uses"
              className="bcq-approvals__input"
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
        </div>
        <button
          type="submit"
          className="bcq-approvals__btn bcq-approvals__btn--primary"
          disabled={busy}
        >
          <PlusIcon />
          <span>Create Invite Link</span>
        </button>

        {created ? (
          <div className="bcq-field">
            <label className="bcq-approvals__label" htmlFor="invite-link">
              New Invite Link
            </label>
            <input
              id="invite-link"
              className="bcq-approvals__input"
              readOnly
              value={created}
              onFocus={(e) => {
                e.target.select();
              }}
              aria-describedby="invite-link-hint"
            />
            <div className="bcq-approvals__actions">
              <button
                type="button"
                className={
                  copiedKey === "created"
                    ? "bcq-approvals__btn bcq-approvals__btn--copied"
                    : "bcq-approvals__btn bcq-approvals__btn--tonal"
                }
                onClick={() => {
                  void copyLink(created, "created");
                }}
              >
                {copiedKey === "created" ? <CheckIcon /> : <CopyIcon />}
                <span>{copiedKey === "created" ? "Copied" : "Copy Invite Link"}</span>
              </button>
            </div>
            <p id="invite-link-hint" className="bcq-field__hint">
              Copy it and send it to the person you&apos;re inviting.
            </p>
          </div>
        ) : null}
      </form>

      {activeInvites.length > 0 ? (
        <div className="bcq-approvals__section">
          <h3 className="bcq-approvals__subhead">Active ({activeInvites.length})</h3>
          <ul className="bcq-approvals__list">
            {activeInvites.map((inv) => {
              const label = `Invite used ${String(inv.uses)} of ${String(inv.maxUses)}`;
              const pct = Math.min(100, Math.round((inv.uses / Math.max(1, inv.maxUses)) * 100));
              const copied = copiedKey === inv.id;
              return (
                <li key={inv.id} className="bcq-approvals__card" aria-label={label}>
                  <div className="bcq-approvals__row-top">
                    <p className="bcq-approvals__usage">
                      {inv.uses} of {inv.maxUses} used
                    </p>
                    <span className="bcq-approvals__pill bcq-approvals__pill--active">Active</span>
                  </div>
                  <div className="bcq-approvals__bar" aria-hidden="true">
                    <div className="bcq-approvals__bar-fill" style={{ width: `${String(pct)}%` }} />
                  </div>
                  <p className="bcq-approvals__meta">
                    Expires{" "}
                    <time dateTime={inv.expiresAt}>
                      {dateFormat.format(new Date(inv.expiresAt))}
                    </time>
                  </p>
                  <div className="bcq-approvals__actions">
                    <button
                      type="button"
                      className={
                        copied
                          ? "bcq-approvals__btn bcq-approvals__btn--copied"
                          : "bcq-approvals__btn bcq-approvals__btn--tonal"
                      }
                      onClick={() => {
                        void copyLink(inviteUrl(inv.token), inv.id);
                      }}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                      <span>{copied ? "Copied" : "Copy Link"}</span>
                    </button>
                    <button
                      type="button"
                      className="bcq-approvals__btn bcq-approvals__btn--danger-tonal"
                      onClick={() => {
                        onRevoke(inv);
                      }}
                    >
                      <BanIcon />
                      <span>Revoke</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {pastInvites.length > 0 ? (
        <div className="bcq-approvals__section">
          <button
            type="button"
            className="bcq-approvals__disclosure"
            aria-expanded={showPast}
            onClick={() => {
              setShowPast((v) => !v);
            }}
          >
            <span>Past Links ({pastInvites.length})</span>
            <ChevronIcon open={showPast} />
          </button>
          {showPast ? (
            <ul className="bcq-approvals__list">
              {pastInvites.map((inv) => {
                const label = `Invite used ${String(inv.uses)} of ${String(inv.maxUses)}`;
                const badge = PAST_STATE_LABEL[inv.state as Exclude<InviteRow["state"], "active">];
                return (
                  <li
                    key={inv.id}
                    className="bcq-approvals__card bcq-approvals__card--past"
                    aria-label={label}
                  >
                    <div className="bcq-approvals__row-top">
                      <p className="bcq-approvals__usage bcq-approvals__usage--past">
                        {inv.uses} of {inv.maxUses} used
                      </p>
                      <span className="bcq-approvals__pill bcq-approvals__pill--muted">
                        {badge}
                      </span>
                    </div>
                    <p className="bcq-approvals__meta bcq-approvals__meta--past">
                      {inv.state === "revoked" ? (
                        inv.revokedAt ? (
                          <>
                            Revoked on{" "}
                            <time dateTime={inv.revokedAt}>
                              {dateFormat.format(new Date(inv.revokedAt))}
                            </time>
                          </>
                        ) : (
                          "Link revoked"
                        )
                      ) : inv.state === "expired" ? (
                        <>
                          Expired{" "}
                          <time dateTime={inv.expiresAt}>
                            {dateFormat.format(new Date(inv.expiresAt))}
                          </time>
                        </>
                      ) : (
                        `All ${String(inv.maxUses)} uses claimed`
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
