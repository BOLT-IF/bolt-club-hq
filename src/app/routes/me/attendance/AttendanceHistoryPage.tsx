import "./attendance.css";
import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { ApiError } from "../../../api/client";
import {
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  type StatusTone,
} from "../../../components/ui";
import { navigate } from "../../../lib/navigate";
import {
  fetchMyAttendanceHistory,
  type MemberAttendanceHistory,
  type MemberAttendanceItem,
} from "./api";

const TZ = "Europe/Stockholm";
const eventDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TZ,
});

const kr = (sek: number): string => `${sek < 0 ? "−" : ""}${String(Math.abs(sek))} kr`;

const REASON_LABEL: Record<string, string> = {
  adhoc: "Event fee",
  guest: "Guest fee",
  club_fee: "Club fee",
  manual: "Charge",
  waiver: "Waiver",
  pass: "Season pass",
  revocation: "Pass revoked",
  opening_balance: "Opening balance",
};

function statusBadge(item: MemberAttendanceItem): { tone: StatusTone; text: string } {
  if (item.eventStatus === "cancelled") {
    return { tone: "neutral", text: "Event cancelled" };
  }
  const r = item.rsvp;
  if (!r) {
    return { tone: "neutral", text: "Ledger entry" };
  }
  if (r.status === "confirmed") {
    if (r.effectiveAttendance === "no_show") {
      return { tone: "danger", text: "No-show" };
    }
    return {
      tone: "success",
      text: r.attendance === "attended" ? "Attended" : "Attended (default)",
    };
  }
  if (r.status === "late_cancelled") {
    return r.refilled
      ? { tone: "info", text: "Late-cancelled (refilled)" }
      : { tone: "warning", text: "Late-cancelled" };
  }
  if (r.status === "cancelled") {
    return { tone: "neutral", text: "Cancelled" };
  }
  if (r.status === "waitlisted") return { tone: "info", text: "Waitlisted" };
  if (r.status === "offered") return { tone: "info", text: "Spot offered" };
  return { tone: "neutral", text: "Requested" };
}

function spaLink(path: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
}

function HistoryCard({
  item,
  highlighted,
}: {
  readonly item: MemberAttendanceItem;
  readonly highlighted: boolean;
}) {
  const badge = statusBadge(item);
  const eventPath = `/events/${encodeURIComponent(item.shareSlug)}`;

  return (
    <li className="bcq-history__item" data-highlighted={highlighted ? "true" : undefined}>
      <div className="bcq-history__row">
        <a className="bcq-history__title" href={eventPath} onClick={spaLink(eventPath)}>
          {item.title}
        </a>
        <StatusChip tone={badge.tone}>{badge.text}</StatusChip>
      </div>

      <div className="bcq-history__meta">
        <time dateTime={item.startsAt}>{eventDate.format(new Date(item.startsAt))}</time>
        {item.location ? <span>{item.location}</span> : null}
        <span className="bcq-history__sum">Net: {kr(item.netChargedSek)}</span>
      </div>

      <p className="bcq-history__why">{item.why}</p>

      {item.guests.length > 0 ? (
        <ul className="bcq-history__guests" aria-label="Guests">
          {item.guests.map((g) => (
            <li key={g.id}>
              Guest: <strong>{g.name}</strong> —{" "}
              {g.status === "confirmed"
                ? g.effectiveAttendance === "no_show"
                  ? "No-show"
                  : "Attended"
                : g.status === "late_cancelled"
                  ? g.refilled
                    ? "Late-cancelled (refilled)"
                    : "Late-cancelled"
                  : g.status}
            </li>
          ))}
        </ul>
      ) : null}

      {item.ledgerEntries.length > 0 ? (
        <ul className="bcq-history__ledger" aria-label="Linked ledger entries">
          {item.ledgerEntries.map((entry) => {
            const label = REASON_LABEL[entry.reason] ?? entry.reason;
            return (
              <li key={entry.id} className="bcq-history__ledger-row">
                <span>
                  {entry.kind === "reversal" ? `Reversal: ${label.toLowerCase()}` : label}
                  {entry.note ? ` (${entry.note})` : ""}
                </span>
                <span className="bcq-history__sum">{kr(entry.amountSek)}</span>
              </li>
            );
          })}
          <li className="bcq-history__ledger-row">
            <a className="bcq-history__back" href="/money" onClick={spaLink("/money")}>
              View in Money
            </a>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/** Member attendance & "why" history screen (PLAN §9, S8.2). */
export function AttendanceHistoryPage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; forbidden: boolean }
    | { status: "ready"; history: MemberAttendanceHistory }
  >({ status: "loading" });

  const focusEventId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("eventId")
      : null;

  const load = useCallback((signal?: AbortSignal) => {
    fetchMyAttendanceHistory(signal)
      .then((history) => {
        setState({ status: "ready", history });
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        setState({
          status: "error",
          forbidden: error instanceof ApiError && error.status === 403,
        });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  return (
    <section aria-labelledby="history-title" className="bcq-history">
      <div className="bcq-history__header">
        <h1 id="history-title" className="bcq-page__title">
          Attendance history
        </h1>
        <a className="bcq-history__back" href="/money" onClick={spaLink("/money")}>
          Back to Money
        </a>
      </div>

      {state.status === "loading" ? <Skeleton label="Loading your attendance history" /> : null}

      {state.status === "error" ? (
        <ErrorState
          title="Couldn't load your attendance history"
          onRetry={() => {
            setState({ status: "loading" });
            load();
          }}
        >
          {state.forbidden
            ? "You can only view your own attendance history."
            : "Check your connection and try again."}
        </ErrorState>
      ) : null}

      {state.status === "ready" ? (
        state.history.items.length === 0 ? (
          <EmptyState title="No attendance history yet">
            Your past and upcoming event RSVPs, attendance, and charges will appear here.
          </EmptyState>
        ) : (
          <ul className="bcq-history__list" aria-label="Attendance and charge history">
            {state.history.items.map((item) => (
              <HistoryCard
                key={item.eventId}
                item={item}
                highlighted={focusEventId === item.eventId}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
