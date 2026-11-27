import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { listEvents, type EventDetail } from "../../api/events";
import { fetchMyLedger, type MyLedger } from "../../api/ledger";
import {
  declineRsvp,
  getMyRsvp,
  putRsvp,
  type RsvpStatus,
  type RsvpView,
} from "../../components/rsvp/api";
import {
  Button,
  ChevronRightIcon,
  ErrorState,
  Skeleton,
  StatusChip,
  type StatusTone,
} from "../../components/ui";
import { useFeatureFlag } from "../../lib/flags";
import { navigate } from "../../lib/navigate";
import { formatWhen } from "../events/format";
import { fetchPassOffers, type MemberPass } from "../money/passes/passesApi";
import { listPolls, type Poll } from "../polls/api";
import "./home.css";

function CheckCircleIcon() {
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
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
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

function CalendarIcon() {
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
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function CalendarClockIcon() {
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
      <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h5" />
      <circle cx="16" cy="16" r="6" />
      <path d="M16 14v2.2l1.6 1" />
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

function XIcon() {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function WalletIcon({ size = 18 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
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

function BarChartIcon() {
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
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function HomeCardHeader({
  id,
  icon,
  iconTone,
  title,
  trailing,
}: {
  readonly id: string;
  readonly icon: ReactNode;
  readonly iconTone: "emerald" | "neutral" | "amber" | "slate";
  readonly title: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="bcq-home__card-head">
      <div className="bcq-home__card-title-group">
        <span className={`bcq-icon-badge bcq-icon-badge--${iconTone}`} aria-hidden="true">
          {icon}
        </span>
        <h2 id={id} className="bcq-home__card-title">
          {title}
        </h2>
      </div>
      {trailing}
    </div>
  );
}

function CompactSummaryCard({
  id,
  href,
  icon,
  iconTone,
  title,
  subtitle,
  actionLabel,
}: {
  readonly id: string;
  readonly href: string;
  readonly icon: ReactNode;
  readonly iconTone: "emerald" | "neutral" | "amber" | "slate";
  readonly title: string;
  readonly subtitle: string;
  readonly actionLabel: string;
}) {
  return (
    <section className="bcq-home__card bcq-home__card--compact" aria-labelledby={id}>
      <AppLink href={href} className="bcq-home__compact-link">
        <span className="bcq-home__compact-left">
          <span className={`bcq-icon-badge bcq-icon-badge--${iconTone}`} aria-hidden="true">
            {icon}
          </span>
          <span className="bcq-home__compact-copy">
            <h2 id={id} className="bcq-home__compact-title">
              {title}
            </h2>
            <span className="bcq-home__compact-sub">{subtitle}</span>
          </span>
        </span>
        <span className="bcq-chevron-link" aria-hidden="true">
          <span>{actionLabel}</span>
          <ChevronRightIcon />
        </span>
      </AppLink>
    </section>
  );
}

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
const MAX_HOME_RSVPS = 3;
const MAX_HOME_UNANSWERED = 2;

const RSVP_CHIP: Record<
  Exclude<RsvpStatus, "cancelled" | "late_cancelled" | "declined">,
  { readonly tone: StatusTone; readonly label: string }
> = {
  confirmed: { tone: "success", label: "Confirmed" },
  requested: { tone: "info", label: "Requested" },
  waitlisted: { tone: "warning", label: "Waitlisted" },
  offered: { tone: "warning", label: "Spot Offered" },
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
    if (
      rsvp &&
      rsvp.status !== "cancelled" &&
      rsvp.status !== "late_cancelled" &&
      rsvp.status !== "declined"
    ) {
      rsvps.push({ event, rsvp });
    } else if (event.status === "scheduled" && rsvp?.status !== "declined") {
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
            ? apiFetch<{ claims: PaymentClaimSummary[] }>("/me/payment-claims", {
                redirectOnUnauthorized: false,
              })
            : Promise.resolve({ claims: [] as PaymentClaimSummary[] }),
          moneyOn && isActive
            ? fetchPassOffers()
            : Promise.resolve({ offers: [], passes: [] as MemberPass[] }),
          pollsOn && isActive ? listPolls() : Promise.resolve([] as Poll[]),
          actor.role === "admin" && isActive
            ? apiFetch<{ requests: unknown[] }>("/admin/join-requests", {
                redirectOnUnauthorized: false,
              })
            : Promise.resolve(null),
          actor.role === "admin" && isActive && moneyOn
            ? apiFetch<{ claims: unknown[] }>("/admin/payment-claims", {
                redirectOnUnauthorized: false,
              })
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

  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);

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
          <AppLink href="/sign-in" className="bcq-btn bcq-btn--primary">
            Sign In
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
          <h2 className="bcq-home__card-title">Membership Pending</h2>
          <p className="bcq-home__muted">
            Your account is waiting for an admin to approve it. An admin can approve you directly,
            or you can open an invite link they send you.
          </p>
          <AppLink href="/join" className="bcq-btn bcq-btn--tonal">
            Check Join Status
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
          data.adminTasks.pendingJoinRequests === 0 &&
          (!moneyOn || data.adminTasks.pendingPaymentClaims === 0) ? (
            <CompactSummaryCard
              id="home-admin-title"
              href="/admin"
              icon={<CheckCircleIcon />}
              iconTone="emerald"
              title="Admin Tasks"
              subtitle="All caught up"
              actionLabel="Admin"
            />
          ) : (
            <section className="bcq-home__card" aria-labelledby="home-admin-title">
              <HomeCardHeader
                id="home-admin-title"
                icon={<ShieldIcon />}
                iconTone="amber"
                title="Admin Tasks"
                trailing={
                  <AppLink href="/admin" className="bcq-chevron-link">
                    <span>Admin</span>
                    <ChevronRightIcon />
                  </AppLink>
                }
              />
              <ul className="bcq-home__divided-list">
                {data.adminTasks.pendingJoinRequests > 0 ? (
                  <li>
                    <AppLink href="/admin/approvals" className="bcq-home__divided-row">
                      <span className="bcq-home__row-title">
                        {data.adminTasks.pendingJoinRequests} pending join{" "}
                        {data.adminTasks.pendingJoinRequests === 1 ? "request" : "requests"}
                      </span>
                      <span className="bcq-home__row-end">
                        <StatusChip tone="warning">Review</StatusChip>
                        <span className="bcq-home__row-chevron" aria-hidden="true">
                          <ChevronRightIcon />
                        </span>
                      </span>
                    </AppLink>
                  </li>
                ) : null}
                {moneyOn && data.adminTasks.pendingPaymentClaims > 0 ? (
                  <li>
                    <AppLink href="/admin/money/claims" className="bcq-home__divided-row">
                      <span className="bcq-home__row-title">
                        {data.adminTasks.pendingPaymentClaims} pending payment{" "}
                        {data.adminTasks.pendingPaymentClaims === 1 ? "claim" : "claims"}
                      </span>
                      <span className="bcq-home__row-end">
                        <StatusChip tone="warning">Review</StatusChip>
                        <span className="bcq-home__row-chevron" aria-hidden="true">
                          <ChevronRightIcon />
                        </span>
                      </span>
                    </AppLink>
                  </li>
                ) : null}
              </ul>
            </section>
          )
        ) : null}

        {eventsOn && isActive ? (
          data.rsvps.length === 0 ? (
            <CompactSummaryCard
              id="home-rsvps-title"
              href="/events"
              icon={<CalendarIcon />}
              iconTone="slate"
              title="Next RSVPs"
              subtitle={data.unanswered.length > 0 ? "None confirmed yet" : "No upcoming RSVPs"}
              actionLabel="All Events"
            />
          ) : (
            <section className="bcq-home__card" aria-labelledby="home-rsvps-title">
              <HomeCardHeader
                id="home-rsvps-title"
                icon={<CalendarIcon />}
                iconTone="slate"
                title="Next RSVPs"
                trailing={
                  <AppLink href="/events" className="bcq-chevron-link">
                    <span>All Events</span>
                    <ChevronRightIcon />
                  </AppLink>
                }
              />
              <ul className="bcq-home__divided-list">
                {data.rsvps.slice(0, MAX_HOME_RSVPS).map(({ event, rsvp }) => {
                  const chip =
                    rsvp &&
                    rsvp.status !== "cancelled" &&
                    rsvp.status !== "late_cancelled" &&
                    rsvp.status !== "declined"
                      ? RSVP_CHIP[rsvp.status]
                      : null;
                  return (
                    <li key={event.id}>
                      <AppLink href={`/events/${event.slug}`} className="bcq-home__divided-row">
                        <span className="bcq-home__row-main">
                          <span className="bcq-home__row-title">{event.title}</span>
                          <span className="bcq-home__row-meta">
                            {formatWhen(event.startsAt, event.endsAt)}
                            {event.location ? ` · ${event.location}` : ""}
                          </span>
                        </span>
                        <span className="bcq-home__row-end">
                          {chip ? <StatusChip tone={chip.tone}>{chip.label}</StatusChip> : null}
                          <span className="bcq-home__row-chevron" aria-hidden="true">
                            <ChevronRightIcon />
                          </span>
                        </span>
                      </AppLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          )
        ) : null}

        {eventsOn && isActive && data.unanswered.length > 0
          ? (() => {
              const visibleUnanswered = data.unanswered.slice(0, MAX_HOME_UNANSWERED);
              const remainingUnanswered = data.unanswered.length - visibleUnanswered.length;
              return (
                <section className="bcq-home__card" aria-labelledby="home-unanswered-title">
                  <HomeCardHeader
                    id="home-unanswered-title"
                    icon={<CalendarClockIcon />}
                    iconTone="amber"
                    title="Unanswered Events"
                    trailing={
                      <AppLink href="/events" className="bcq-chevron-link">
                        <span>All Events</span>
                        <ChevronRightIcon />
                      </AppLink>
                    }
                  />
                  {quickError ? (
                    <p role="alert" className="bcq-home__muted">
                      {quickError}
                    </p>
                  ) : null}
                  <ul className="bcq-home__divided-list">
                    {visibleUnanswered.map((event, index) => {
                      const isBusy = busyEventId === event.id;
                      const respond = (action: "going" | "decline") => {
                        if (busyEventId !== null) return;
                        setBusyEventId(event.id);
                        setQuickError(null);
                        const req =
                          action === "going" ? putRsvp(event.id, []) : declineRsvp(event.id);
                        void req
                          .then((saved) => {
                            setState((prev) => {
                              if (prev.kind !== "ready") return prev;
                              const remaining = prev.data.unanswered.filter(
                                (e) => e.id !== event.id,
                              );
                              const nextRsvps =
                                action === "going"
                                  ? [...prev.data.rsvps, { event, rsvp: saved }]
                                  : prev.data.rsvps;
                              return {
                                kind: "ready",
                                data: { ...prev.data, unanswered: remaining, rsvps: nextRsvps },
                              };
                            });
                          })
                          .catch(() => {
                            setQuickError("Couldn't save that RSVP. Open the event to try again.");
                          })
                          .finally(() => {
                            setBusyEventId(null);
                          });
                      };
                      return (
                        <li key={event.id} className="bcq-home__unanswered-item">
                          <AppLink
                            href={`/events/${event.slug}`}
                            className="bcq-home__unanswered-link"
                          >
                            <span className="bcq-home__row-main">
                              <span className="bcq-home__row-title-line">
                                <span className="bcq-home__row-title">{event.title}</span>
                                {index === 0 ? (
                                  <span className="bcq-home__next-pill">Next Up</span>
                                ) : null}
                              </span>
                              <span className="bcq-home__row-meta">
                                {formatWhen(event.startsAt, event.endsAt)}
                                {event.location ? ` · ${event.location}` : ""}
                              </span>
                            </span>
                            <span className="bcq-home__row-chevron" aria-hidden="true">
                              <ChevronRightIcon />
                            </span>
                          </AppLink>
                          <div className="bcq-home__quick-actions">
                            <Button
                              className="bcq-home__quick-btn"
                              disabled={isBusy}
                              aria-label={`RSVP to ${event.title}`}
                              onClick={() => {
                                respond("going");
                              }}
                            >
                              <CheckIcon />
                              <span>RSVP</span>
                            </Button>
                            <Button
                              variant="tonal"
                              className="bcq-home__quick-btn"
                              disabled={isBusy}
                              aria-label={`Not Going to ${event.title}`}
                              onClick={() => {
                                respond("decline");
                              }}
                            >
                              <XIcon />
                              <span>Not Going</span>
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {remainingUnanswered > 0 ? (
                    <AppLink href="/events" className="bcq-home__card-footer-link">
                      <span>+{remainingUnanswered} More in Events</span>
                      <ChevronRightIcon />
                    </AppLink>
                  ) : null}
                </section>
              );
            })()
          : null}

        {moneyOn ? (
          <section className="bcq-home__card" aria-labelledby="home-money-title">
            <HomeCardHeader
              id="home-money-title"
              icon={<WalletIcon />}
              iconTone="slate"
              title="Money & Passes"
              trailing={
                data.ledger ? (
                  <StatusChip tone={balanceSummary(data.ledger).tone}>
                    {balanceSummary(data.ledger).text}
                  </StatusChip>
                ) : null
              }
            />

            {data.pendingClaims.length > 0 ? (
              <AppLink href="/money/claims" className="bcq-home__soft-row">
                <span className="bcq-home__row-title">
                  {data.pendingClaims.length} pending{" "}
                  {data.pendingClaims.length === 1 ? "claim" : "claims"} ({pendingClaimTotal} kr)
                </span>
                <StatusChip tone="info">Pending Review</StatusChip>
              </AppLink>
            ) : null}

            {isActive ? (
              data.activePasses.length > 0 ? (
                <ul className="bcq-home__soft-list">
                  {data.activePasses.map((pass) => (
                    <li key={pass.id}>
                      <AppLink href="/money/passes" className="bcq-home__soft-row">
                        <span className="bcq-home__row-main">
                          <span className="bcq-home__row-title">{pass.seriesName}</span>
                          <span className="bcq-home__row-meta">{pass.termName}</span>
                        </span>
                        <StatusChip tone="success">Active Pass</StatusChip>
                      </AppLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="bcq-home__muted">No active pass</p>
              )
            ) : null}

            {(() => {
              const showOffers =
                isActive && (data.activePasses.length === 0 || data.offerCount > 0);
              return (
                <div
                  className={
                    showOffers ? "bcq-home__actions" : "bcq-home__actions bcq-home__actions--single"
                  }
                >
                  <AppLink href="/money" className="bcq-btn bcq-btn--tonal bcq-home__action-btn">
                    <WalletIcon size={16} />
                    <span>Balance &amp; Pay</span>
                  </AppLink>
                  {showOffers ? (
                    <AppLink
                      href="/money/passes"
                      className="bcq-btn bcq-btn--tonal bcq-home__action-btn"
                    >
                      <TicketIcon />
                      <span>Pass Offers</span>
                    </AppLink>
                  ) : null}
                </div>
              );
            })()}
          </section>
        ) : null}

        {pollsOn && isActive ? (
          data.openPolls.length === 0 ? (
            <CompactSummaryCard
              id="home-polls-title"
              href="/polls"
              icon={<BarChartIcon />}
              iconTone="slate"
              title="Open Polls"
              subtitle="No open polls"
              actionLabel="All Polls"
            />
          ) : (
            <section className="bcq-home__card" aria-labelledby="home-polls-title">
              <HomeCardHeader
                id="home-polls-title"
                icon={<BarChartIcon />}
                iconTone="slate"
                title="Open Polls"
                trailing={
                  <AppLink href="/polls" className="bcq-chevron-link">
                    <span>All Polls</span>
                    <ChevronRightIcon />
                  </AppLink>
                }
              />
              <ul className="bcq-home__divided-list">
                {data.openPolls.map((poll) => (
                  <li key={poll.id}>
                    <AppLink href={`/polls/${poll.id}`} className="bcq-home__divided-row">
                      <span className="bcq-home__row-title">{poll.question}</span>
                      <span className="bcq-home__row-end">
                        <StatusChip tone={poll.myVote.length === 0 ? "info" : "success"}>
                          {poll.myVote.length === 0 ? "Needs Your Vote" : "Voted"}
                        </StatusChip>
                        <span className="bcq-home__row-chevron" aria-hidden="true">
                          <ChevronRightIcon />
                        </span>
                      </span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            </section>
          )
        ) : null}
      </div>
    </section>
  );
}
