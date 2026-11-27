import "./inbox.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { apiFetch } from "../../api/client";
import { getEventBySlug } from "../../api/events";
import {
  fetchNotifications,
  markNotificationsRead,
  type InboxItem,
  type InboxPage,
} from "../../api/notifications";
import { declineRsvp, putRsvp, type RsvpStatus } from "../../components/rsvp/api";
import { Button, EmptyState, ErrorState, Skeleton, StatusChip } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import type { AppRoute } from "../registry";

interface PendingJoinRequest {
  readonly id: string;
  readonly displayName: string;
}

/** Only in-app paths are followed; the server enforces this too (defence in depth). */
const isInAppPath = (link: string): boolean => /^\/(?![/\\])/.test(link);

function eventSlugFromLink(link: string | null): string | null {
  if (!link) return null;
  const match = /^\/events\/([^/?#]+)/.exec(link);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const QUICK_STATUS_LABEL: Partial<Record<RsvpStatus, string>> = {
  confirmed: "Confirmed",
  requested: "Requested",
  waitlisted: "Waitlisted",
  declined: "Not Going",
};

const TZ = "Europe/Stockholm";

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TZ,
});

const datePartFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: TZ,
});

const timePartFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: TZ,
});

function formatInboxTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const todayKey = dayKeyFormat.format(now);
  const yesterdayKey = dayKeyFormat.format(new Date(now.getTime() - 86_400_000));
  const itemKey = dayKeyFormat.format(date);
  const time = timePartFormat.format(date);

  if (itemKey === todayKey) return `Today • ${time}`;
  if (itemKey === yesterdayKey) return `Yesterday • ${time}`;
  return `${datePartFormat.format(date)} • ${time}`;
}

const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function toTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word, index) => {
      if (!word) return word;
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && MINOR_WORDS.has(lower)) return lower;
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
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

function UserPlusIcon() {
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
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}

function CalendarPlusIcon() {
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
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
      <path d="M3 10h18" />
      <path d="M19 16v6" />
      <path d="M16 19h6" />
    </svg>
  );
}

function CalendarXIcon() {
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
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="m14 14-4 4" />
      <path d="m10 14 4 4" />
    </svg>
  );
}

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

function BellIcon() {
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
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
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

function UserCheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
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

function categoryVisual(item: InboxItem): {
  readonly tone: "amber" | "blue" | "emerald" | "red" | "slate";
  readonly icon: ReactNode;
} {
  const title = item.title.toLowerCase();
  if (title.includes("attendance")) {
    return { tone: "amber", icon: <CalendarClockIcon /> };
  }
  if (item.category === "admin_tasks" && title.includes("join")) {
    return { tone: "blue", icon: <UserPlusIcon /> };
  }
  if (item.category === "new_events" || title.includes("new event")) {
    return { tone: "emerald", icon: <CalendarPlusIcon /> };
  }
  if (title.includes("cancelled") || title.includes("canceled")) {
    return { tone: "red", icon: <CalendarXIcon /> };
  }
  if (item.category === "payment_status" || title.includes("payment")) {
    return { tone: "slate", icon: <CheckCircleIcon /> };
  }
  if (item.category === "rsvp_status") {
    return { tone: "emerald", icon: <CheckCircleIcon /> };
  }
  if (item.category === "event_changes") {
    return { tone: "amber", icon: <CalendarClockIcon /> };
  }
  return { tone: "slate", icon: <BellIcon /> };
}

function isJoinRequestNotification(item: InboxItem): boolean {
  return item.category === "admin_tasks" && item.title.toLowerCase().includes("join request");
}

function matchPendingJoinRequest(
  item: InboxItem,
  requests: readonly PendingJoinRequest[],
): PendingJoinRequest | null {
  if (requests.length === 0) return null;
  const matched = requests.find((r) => item.body.startsWith(`${r.displayName} `));
  if (matched) return matched;
  return requests.length === 1 ? (requests[0] ?? null) : null;
}

function Inbox() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: readonly InboxItem[]; unreadCount: number }
  >({ status: "loading" });
  const [joinRequests, setJoinRequests] = useState<readonly PendingJoinRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [responded, setResponded] = useState<Record<string, { label: string; positive: boolean }>>(
    {},
  );
  const [quickError, setQuickError] = useState<Record<string, string>>({});

  const load = useCallback((signal?: AbortSignal) => {
    fetchNotifications(signal)
      .then((page: InboxPage) => {
        setState({ status: "ready", ...page });
        if (page.items.some(isJoinRequestNotification)) {
          apiFetch<{ requests: PendingJoinRequest[] }>("/admin/join-requests", {
            ...(signal ? { signal } : {}),
            redirectOnUnauthorized: false,
          })
            .then((res) => {
              if (!signal?.aborted) setJoinRequests(res.requests);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        if (!signal?.aborted) setState({ status: "error" });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const markRead = (ids: readonly string[], all = false) => {
    setState((s) => {
      if (s.status !== "ready") return s;
      const newlyRead = all
        ? s.unreadCount
        : s.items.filter((i) => ids.includes(i.id) && i.readAt === null).length;
      return {
        status: "ready",
        items: s.items.map((i) =>
          (all || ids.includes(i.id)) && i.readAt === null
            ? { ...i, readAt: new Date().toISOString() }
            : i,
        ),
        unreadCount: all ? 0 : Math.max(0, s.unreadCount - newlyRead),
      };
    });
    markNotificationsRead(all ? { all: true } : { ids }).catch(() => undefined);
  };

  const open = (item: InboxItem) => {
    if (item.readAt === null) markRead([item.id]);
    if (item.link !== null && isInAppPath(item.link)) navigate(item.link);
  };

  const quickRespond = (item: InboxItem, slug: string, action: "going" | "decline") => {
    if (busyId !== null) return;
    if (item.readAt === null) markRead([item.id]);
    setBusyId(item.id);
    setQuickError((prev) => ({ ...prev, [item.id]: "" }));
    void getEventBySlug(slug)
      .then((detail) =>
        action === "going" ? putRsvp(detail.event.id, []) : declineRsvp(detail.event.id),
      )
      .then((rsvp) => {
        const label = QUICK_STATUS_LABEL[rsvp.status] ?? rsvp.status;
        setResponded((prev) => ({
          ...prev,
          [item.id]: { label, positive: label !== "Not Going" },
        }));
      })
      .catch(() => {
        setQuickError((prev) => ({
          ...prev,
          [item.id]: "Couldn't update RSVP. Open the event to try again.",
        }));
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  const quickJoinDecision = (
    item: InboxItem,
    request: PendingJoinRequest,
    action: "approve" | "reject",
  ) => {
    if (busyId !== null) return;
    if (item.readAt === null) markRead([item.id]);
    setBusyId(item.id);
    setQuickError((prev) => ({ ...prev, [item.id]: "" }));
    void apiFetch(`/join-requests/${request.id}/${action}`, { method: "POST" })
      .then(() => {
        setJoinRequests((prev) => prev.filter((r) => r.id !== request.id));
        setResponded((prev) => ({
          ...prev,
          [item.id]: {
            label: action === "approve" ? "Approved" : "Declined",
            positive: action === "approve",
          },
        }));
      })
      .catch(() => {
        setQuickError((prev) => ({
          ...prev,
          [item.id]: "Couldn't update join request. Open Approvals to try again.",
        }));
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  const renderItem = (item: InboxItem) => {
    const eventSlug = item.category === "new_events" ? eventSlugFromLink(item.link) : null;
    const pendingJoin = isJoinRequestNotification(item)
      ? matchPendingJoinRequest(item, joinRequests)
      : null;
    const outcome = responded[item.id];
    const err = quickError[item.id];
    const isBusy = busyId === item.id;
    const isUnread = item.readAt === null;
    const visual = categoryVisual(item);
    const hasActions = Boolean(eventSlug || pendingJoin || outcome);

    return (
      <li
        key={item.id}
        className={isUnread ? "bcq-inbox__card bcq-inbox__card--unread" : "bcq-inbox__card"}
      >
        {isUnread ? (
          <span className="bcq-inbox__unread-dot" role="img" aria-label="Unread" />
        ) : null}
        <button
          type="button"
          className="bcq-inbox__trigger"
          onClick={() => {
            open(item);
          }}
        >
          <span className={`bcq-inbox__icon bcq-inbox__icon--${visual.tone}`} aria-hidden="true">
            {visual.icon}
          </span>
          <span className="bcq-inbox__content">
            <span className="bcq-inbox__head">
              <strong className="bcq-inbox__title">{toTitleCase(item.title)}</strong>
            </span>
            <span className="bcq-inbox__body">{item.body}</span>
            <time className="bcq-inbox__time" dateTime={item.createdAt}>
              {formatInboxTime(item.createdAt)}
            </time>
          </span>
        </button>

        {hasActions ? (
          outcome ? (
            <div className="bcq-inbox__outcome">
              <StatusChip tone={outcome.positive ? "success" : "neutral"}>
                {outcome.label}
              </StatusChip>
            </div>
          ) : eventSlug ? (
            <div className="bcq-inbox__actions">
              <Button
                className="bcq-inbox__action-btn"
                disabled={isBusy}
                onClick={() => {
                  quickRespond(item, eventSlug, "going");
                }}
              >
                <CheckIcon />
                <span>RSVP</span>
              </Button>
              <Button
                variant="tonal"
                className="bcq-inbox__action-btn"
                disabled={isBusy}
                onClick={() => {
                  quickRespond(item, eventSlug, "decline");
                }}
              >
                <XIcon />
                <span>Not Going</span>
              </Button>
              {err ? (
                <p role="alert" className="bcq-inbox__error">
                  {err}
                </p>
              ) : null}
            </div>
          ) : pendingJoin ? (
            <div className="bcq-inbox__actions">
              <Button
                className="bcq-inbox__action-btn"
                disabled={isBusy}
                onClick={() => {
                  quickJoinDecision(item, pendingJoin, "approve");
                }}
              >
                <UserCheckIcon />
                <span>Approve</span>
              </Button>
              <Button
                variant="tonal"
                className="bcq-inbox__action-btn"
                disabled={isBusy}
                onClick={() => {
                  quickJoinDecision(item, pendingJoin, "reject");
                }}
              >
                <XIcon />
                <span>Decline</span>
              </Button>
              {err ? (
                <p role="alert" className="bcq-inbox__error">
                  {err}
                </p>
              ) : null}
            </div>
          ) : null
        ) : null}
      </li>
    );
  };

  const newItems = state.status === "ready" ? state.items.filter((i) => i.readAt === null) : [];
  const earlierItems = state.status === "ready" ? state.items.filter((i) => i.readAt !== null) : [];

  return (
    <section className="bcq-inbox-page" aria-labelledby="inbox-title">
      <div className="bcq-inbox-page__head">
        <div className="bcq-inbox-page__title-group">
          <h1 id="inbox-title" className="bcq-page__title">
            Inbox
          </h1>
          {state.status === "ready" && state.unreadCount > 0 ? (
            <span className="bcq-count-pill" aria-label={`${String(state.unreadCount)} unread`}>
              {state.unreadCount}
            </span>
          ) : null}
        </div>
        {state.status === "ready" && state.unreadCount > 0 ? (
          <button
            type="button"
            className="bcq-inbox-page__mark-all"
            onClick={() => {
              markRead([], true);
            }}
          >
            <CheckIcon />
            <span>Mark All Read</span>
          </button>
        ) : null}
      </div>

      {state.status === "loading" ? <Skeleton label="Loading notifications" /> : null}
      {state.status === "error" ? (
        <ErrorState
          onRetry={() => {
            load();
          }}
        >
          Could not load your notifications.
        </ErrorState>
      ) : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState title="Nothing Here Yet">
          Updates about your RSVPs, payments, and events will show up here.
        </EmptyState>
      ) : null}
      {state.status === "ready" && state.items.length > 0 ? (
        <>
          {newItems.length > 0 ? (
            <div className="bcq-inbox-section">
              <h2 className="bcq-inbox-section__subhead">NEW ({newItems.length})</h2>
              <ul className="bcq-inbox">{newItems.map(renderItem)}</ul>
            </div>
          ) : null}
          {earlierItems.length > 0 ? (
            <div className="bcq-inbox-section">
              <h2 className="bcq-inbox-section__subhead">EARLIER</h2>
              <ul className="bcq-inbox">{earlierItems.map(renderItem)}</ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const route: AppRoute = { path: "/inbox", component: Inbox };
export default route;
