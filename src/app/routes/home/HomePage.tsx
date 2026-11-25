import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { listEvents, type EventDetail } from "../../api/events";
import { fetchMyLedger, type MyLedger } from "../../api/ledger";
import { getMyRsvp, type RsvpStatus, type RsvpView } from "../../components/rsvp/api";
import { ErrorState, Skeleton, StatusChip, type StatusTone } from "../../components/ui";
import { useFeatureFlag } from "../../lib/flags";
import { navigate } from "../../lib/navigate";
import { formatWhen } from "../events/format";
import { fetchPassOffers, type MemberPass } from "../money/passes/passesApi";
import { listPolls, type Poll } from "../polls/api";
import "./home.css";

interface ActorSummary {
  readonly id: string;
  readonly role: "member" | "admin";
  readonly status: "pending" | "active" | "inactive" | "erased";
}

interface PaymentClaimSummary {
  readonly id: string;
  readonly amountSek: number;
  readonly status: "pending" | "confirmed" | "rejected";
}

interface EventWithRsvp {
  readonly event: EventDetail;
  readonly rsvp: RsvpView | null;
}

interface HomeData {
  readonly actor: ActorSummary;
  readonly rsvps: readonly EventWithRsvp[];
  readonly unanswered: readonly EventDetail[];
  readonly ledger: MyLedger | null;
  readonly pendingClaims: readonly PaymentClaimSummary[];
  readonly activePasses: readonly MemberPass[];
  readonly offerCount: number;
  readonly openPolls: readonly Poll[];
  readonly adminTasks: {
    readonly pendingJoinRequests: number;
    readonly pendingPaymentClaims: number;
  } | null;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: HomeData };

const MAX_EVENT_LOOKUPS = 6;

const RSVP_CHIP: Record<
  Exclude<RsvpStatus, "cancelled" | "late_cancelled">,
  { readonly tone: StatusTone; readonly label: string }
> = {
  confirmed: { tone: "success", label: "Confirmed" },
  requested: { tone: "info", label: "Requested" },
  waitlisted: { tone: "warning", label: "Waitlisted" },
  offered: { tone: "warning", label: "Spot offered" },
};

function AppLink({
  href,
  className,
  children,
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

async function loadEventsSection(): Promise<{
  rsvps: EventWithRsvp[];
  unanswered: EventDetail[];
}> {
  const all = await listEvents("upcoming");
  const upcoming = all
    .filter((e) => !e.readOnly && e.status !== "cancelled")
    .slice(0, MAX_EVENT_LOOKUPS);
  const rsvpResults = await Promise.allSettled(upcoming.map((e) => getMyRsvp(e.id)));

  const rsvps: EventWithRsvp[] = [];
  const unanswered: EventDetail[] = [];

  for (const [i, event] of upcoming.entries()) {
    const res = rsvpResults[i];
    const rsvp = res && res.status === "fulfilled" ? res.value : null;
    if (rsvp && rsvp.status !== "cancelled" && rsvp.status !== "late_cancelled") {
      rsvps.push({ event, rsvp });
    } else if (event.status === "scheduled") {
      unanswered.push(event);
    }
  }
  return { rsvps, unanswered };
}

function balanceSummary(ledger: MyLedger): { tone: StatusTone; text: string } {
  if (ledger.balanceSek > 0) {
    return { tone: "warning", text: `Owes ${String(ledger.balanceSek)} kr` };
  }
  if (ledger.balanceSek < 0) {
    return { tone: "success", text: `Credit ${String(Math.abs(ledger.balanceSek))} kr` };
  }
  return { tone: "success", text: "0 kr · Settled" };
}

export function HomePage() {
  const eventsOn = useFeatureFlag("events");
  const moneyOn = useFeatureFlag("money");
  const pollsOn = useFeatureFlag("polls");

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<LoadState> {
      let actor: ActorSummary;
      try {
        actor = await apiFetch<ActorSummary>("/me", { redirectOnUnauthorized: false });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return { kind: "signed_out" };
        }
        throw err;
      }
      if (actor.status === "pending" || actor.status === "erased") {
        return {
          kind: "ready",
          data: {
            actor,
            rsvps: [],
            unanswered: [],
            ledger: null,
            pendingClaims: [],
            activePasses: [],
            offerCount: 0,
            openPolls: [],
            adminTasks: null,
          },
        };
      }

      const isActive = actor.status === "active";
      const [eventsRes, ledgerRes, claimsRes, passesRes, pollsRes, joinRes, adminClaimsRes] =
        await Promise.allSettled([
          eventsOn && isActive
            ? loadEventsSection()
            : Promise.resolve({ rsvps: [] as EventWithRsvp[], unanswered: [] as EventDetail[] }),
          moneyOn ? fetchMyLedger() : Promise.resolve(null),
          moneyOn
            ? apiFetch<{ claims: PaymentClaimSummary[] }>("/me/payment-claims")
            : Promise.resolve({ claims: [] as PaymentClaimSummary[] }),
          moneyOn && isActive
            ? fetchPassOffers()
            : Promise.resolve({ offers: [], passes: [] as MemberPass[] }),
          pollsOn && isActive ? listPolls() : Promise.resolve([] as Poll[]),
          actor.role === "admin" && isActive
            ? apiFetch<{ requests: unknown[] }>("/admin/join-requests")
            : Promise.resolve(null),
          actor.role === "admin" && isActive && moneyOn
            ? apiFetch<{ claims: unknown[] }>("/admin/payment-claims")
            : Promise.resolve(null),
        ]);

      const eventsData = settledValue(eventsRes, { rsvps: [], unanswered: [] });
      const claims = settledValue(claimsRes, { claims: [] }).claims;
      const passesData = settledValue(passesRes, { offers: [], passes: [] });
      const polls = settledValue(pollsRes, []);
      const joinRequests = settledValue(joinRes, null);
      const adminClaims = settledValue(adminClaimsRes, null);

      return {
        kind: "ready",
        data: {
          actor,
          rsvps: eventsData.rsvps,
          unanswered: eventsData.unanswered,
          ledger: settledValue(ledgerRes, null),
          pendingClaims: claims.filter((c) => c.status === "pending"),
          activePasses: passesData.passes.filter((p) => p.status === "active"),
          offerCount: passesData.offers.length,
          openPolls: polls.filter((p) => !p.closed),
          adminTasks:
            actor.role === "admin" && isActive
              ? {
                  pendingJoinRequests: joinRequests?.requests.length ?? 0,
                  pendingPaymentClaims: adminClaims?.claims.length ?? 0,
                }
              : null,
        },
      };
    }

    load()
      .then((nextState) => {
        if (!cancelled) setState(nextState);
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, eventsOn, moneyOn, pollsOn]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <section className="bcq-home" aria-labelledby="home-title">
        <h1 id="home-title" className="bcq-page__title">
          Home
        </h1>
        <Skeleton lines={4} label="Loading home dashboard" />
      </section>
    );
  }

  if (state.kind === "signed_out") {
    return (
      <section className="bcq-home" aria-labelledby="home-title">
        <h1 id="home-title" className="bcq-page__title">
          Home
        </h1>
        <div className="bcq-home__card">
          <h2 className="bcq-home__card-title">Welcome to BOLT HQ</h2>
          <p className="bcq-home__muted">
            Sign in to see upcoming events, your balance, passes, and open polls.
          </p>
          <AppLink href="/sign-in" className="bcq-home__link">
            Sign in
          </AppLink>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="bcq-home" aria-labelledby="home-title">
        <h1 id="home-title" className="bcq-page__title">
          Home
        </h1>
        <ErrorState onRetry={retry}>We couldn&apos;t load your home dashboard.</ErrorState>
      </section>
    );
  }

  const { data } = state;

  if (data.actor.status === "pending") {
    return (
      <section className="bcq-home" aria-labelledby="home-title">
        <h1 id="home-title" className="bcq-page__title">
          Home
        </h1>
        <div className="bcq-home__card">
          <h2 className="bcq-home__card-title">Membership pending</h2>
          <p className="bcq-home__muted">
            Your account is waiting for an admin to approve it. An admin can approve you directly,
            or you can open an invite link they send you.
          </p>
          <AppLink href="/join" className="bcq-home__link">
            Check join status
          </AppLink>
        </div>
      </section>
    );
  }

  const isActive = data.actor.status === "active";
  const pendingClaimTotal = data.pendingClaims.reduce((sum, c) => sum + c.amountSek, 0);

  return (
    <section className="bcq-home" aria-labelledby="home-title">
      <h1 id="home-title" className="bcq-page__title">
        Home
      </h1>

      <div className="bcq-home__grid">
        {data.adminTasks ? (
          <section className="bcq-home__card" aria-labelledby="home-admin-title">
            <div className="bcq-home__card-head">
              <h2 id="home-admin-title" className="bcq-home__card-title">
                Admin tasks
              </h2>
              <AppLink href="/admin" className="bcq-home__link">
                Admin
              </AppLink>
            </div>
            {data.adminTasks.pendingJoinRequests === 0 &&
            data.adminTasks.pendingPaymentClaims === 0 ? (
              <p className="bcq-home__muted">All caught up — no pending admin tasks.</p>
            ) : (
              <ul className="bcq-home__list">
                {data.adminTasks.pendingJoinRequests > 0 ? (
                  <li>
                    <AppLink href="/admin/approvals" className="bcq-home__row">
                      <span className="bcq-home__row-title">
                        {data.adminTasks.pendingJoinRequests} pending join{" "}
                        {data.adminTasks.pendingJoinRequests === 1 ? "request" : "requests"}
                      </span>
                      <StatusChip tone="warning">Review</StatusChip>
                    </AppLink>
                  </li>
                ) : null}
                {moneyOn && data.adminTasks.pendingPaymentClaims > 0 ? (
                  <li>
                    <AppLink href="/admin/money/claims" className="bcq-home__row">
                      <span className="bcq-home__row-title">
                        {data.adminTasks.pendingPaymentClaims} pending payment{" "}
                        {data.adminTasks.pendingPaymentClaims === 1 ? "claim" : "claims"}
                      </span>
                      <StatusChip tone="warning">Review</StatusChip>
                    </AppLink>
                  </li>
                ) : null}
              </ul>
            )}
          </section>
        ) : null}

        {eventsOn && isActive ? (
          <section className="bcq-home__card" aria-labelledby="home-rsvps-title">
            <div className="bcq-home__card-head">
              <h2 id="home-rsvps-title" className="bcq-home__card-title">
                Next RSVPs
              </h2>
              <AppLink href="/events" className="bcq-home__link">
                All events
              </AppLink>
            </div>
            {data.rsvps.length === 0 ? (
              <p className="bcq-home__muted">No upcoming RSVPs</p>
            ) : (
              <ul className="bcq-home__list">
                {data.rsvps.map(({ event, rsvp }) => {
                  const chip =
                    rsvp && rsvp.status !== "cancelled" && rsvp.status !== "late_cancelled"
                      ? RSVP_CHIP[rsvp.status]
                      : null;
                  return (
                    <li key={event.id}>
                      <AppLink href={`/events/${event.slug}`} className="bcq-home__row">
                        <span className="bcq-home__row-main">
                          <span className="bcq-home__row-title">{event.title}</span>
                          <span className="bcq-home__row-meta">
                            {formatWhen(event.startsAt, event.endsAt)}
                            {event.location ? ` · ${event.location}` : ""}
                          </span>
                        </span>
                        {chip ? <StatusChip tone={chip.tone}>{chip.label}</StatusChip> : null}
                      </AppLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {eventsOn && isActive && data.unanswered.length > 0 ? (
          <section className="bcq-home__card" aria-labelledby="home-unanswered-title">
            <h2 id="home-unanswered-title" className="bcq-home__card-title">
              Unanswered events
            </h2>
            <ul className="bcq-home__list">
              {data.unanswered.map((event) => (
                <li key={event.id}>
                  <AppLink href={`/events/${event.slug}`} className="bcq-home__row">
                    <span className="bcq-home__row-main">
                      <span className="bcq-home__row-title">{event.title}</span>
                      <span className="bcq-home__row-meta">
                        {formatWhen(event.startsAt, event.endsAt)}
                      </span>
                    </span>
                    <StatusChip tone="info">RSVP open</StatusChip>
                  </AppLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {moneyOn ? (
          <section className="bcq-home__card" aria-labelledby="home-money-title">
            <div className="bcq-home__card-head">
              <h2 id="home-money-title" className="bcq-home__card-title">
                Money &amp; passes
              </h2>
              {data.ledger ? (
                <StatusChip tone={balanceSummary(data.ledger).tone}>
                  {balanceSummary(data.ledger).text}
                </StatusChip>
              ) : null}
            </div>

            {data.pendingClaims.length > 0 ? (
              <AppLink href="/money/claims" className="bcq-home__row">
                <span className="bcq-home__row-title">
                  {data.pendingClaims.length} pending{" "}
                  {data.pendingClaims.length === 1 ? "claim" : "claims"} ({pendingClaimTotal} kr)
                </span>
                <StatusChip tone="info">Pending review</StatusChip>
              </AppLink>
            ) : null}

            {isActive ? (
              data.activePasses.length > 0 ? (
                <ul className="bcq-home__list">
                  {data.activePasses.map((pass) => (
                    <li key={pass.id}>
                      <AppLink href="/money/passes" className="bcq-home__row">
                        <span className="bcq-home__row-main">
                          <span className="bcq-home__row-title">{pass.seriesName}</span>
                          <span className="bcq-home__row-meta">{pass.termName}</span>
                        </span>
                        <StatusChip tone="success">Active pass</StatusChip>
                      </AppLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="bcq-home__muted">No active pass</p>
              )
            ) : null}

            <div className="bcq-home__actions">
              <AppLink href="/money" className="bcq-home__link">
                View balance &amp; pay
              </AppLink>
              {isActive && (data.activePasses.length === 0 || data.offerCount > 0) ? (
                <AppLink href="/money/passes" className="bcq-home__link">
                  View pass offers
                </AppLink>
              ) : null}
            </div>
          </section>
        ) : null}

        {pollsOn && isActive ? (
          <section className="bcq-home__card" aria-labelledby="home-polls-title">
            <div className="bcq-home__card-head">
              <h2 id="home-polls-title" className="bcq-home__card-title">
                Open polls
              </h2>
              <AppLink href="/polls" className="bcq-home__link">
                All polls
              </AppLink>
            </div>
            {data.openPolls.length === 0 ? (
              <p className="bcq-home__muted">No open polls</p>
            ) : (
              <ul className="bcq-home__list">
                {data.openPolls.map((poll) => (
                  <li key={poll.id}>
                    <AppLink href={`/polls/${poll.id}`} className="bcq-home__row">
                      <span className="bcq-home__row-title">{poll.question}</span>
                      <StatusChip tone={poll.myVote.length === 0 ? "info" : "success"}>
                        {poll.myVote.length === 0 ? "Needs your vote" : "Voted"}
                      </StatusChip>
                    </AppLink>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </section>
  );
}
