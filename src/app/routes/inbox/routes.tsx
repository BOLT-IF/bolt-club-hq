import "./inbox.css";
import { useCallback, useEffect, useState } from "react";

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

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Stockholm",
});

function Inbox() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: readonly InboxItem[]; unreadCount: number }
  >({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [responded, setResponded] = useState<Record<string, string>>({});
  const [quickError, setQuickError] = useState<Record<string, string>>({});

  const load = useCallback((signal?: AbortSignal) => {
    fetchNotifications(signal)
      .then((page: InboxPage) => {
        setState({ status: "ready", ...page });
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
    setState((s) =>
      s.status !== "ready"
        ? s
        : {
            status: "ready",
            items: s.items.map((i) =>
              (all || ids.includes(i.id)) && i.readAt === null
                ? { ...i, readAt: new Date().toISOString() }
                : i,
            ),
            unreadCount: all ? 0 : Math.max(0, s.unreadCount - ids.length),
          },
    );
    // Best effort: the inbox is re-read on the next open, so a failure here self-heals.
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
        setResponded((prev) => ({ ...prev, [item.id]: label }));
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

  return (
    <section aria-labelledby="inbox-title">
      <h1 id="inbox-title" className="bcq-page__title">
        Inbox
      </h1>
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
        <EmptyState title="Nothing here yet">
          Updates about your RSVPs, payments and events will show up here.
        </EmptyState>
      ) : null}
      {state.status === "ready" && state.items.length > 0 ? (
        <>
          {state.unreadCount > 0 ? (
            <Button
              variant="secondary"
              onClick={() => {
                markRead([], true);
              }}
            >
              Mark All Read
            </Button>
          ) : null}
          <ul className="bcq-inbox">
            {state.items.map((item) => {
              const eventSlug =
                item.category === "new_events" ? eventSlugFromLink(item.link) : null;
              const outcome = responded[item.id];
              const err = quickError[item.id];
              const isBusy = busyId === item.id;
              return (
                <li key={item.id} className="bcq-inbox__card">
                  <button
                    type="button"
                    className="bcq-inbox__item"
                    onClick={() => {
                      open(item);
                    }}
                  >
                    <span className="bcq-inbox__head">
                      <strong>{item.title}</strong>
                      {item.readAt === null ? <StatusChip tone="info">Unread</StatusChip> : null}
                    </span>
                    <span className="bcq-inbox__body">{item.body}</span>
                    <time className="bcq-inbox__time" dateTime={item.createdAt}>
                      {dateFormat.format(new Date(item.createdAt))}
                    </time>
                  </button>
                  {eventSlug ? (
                    <div className="bcq-inbox__actions">
                      {outcome ? (
                        <StatusChip tone={outcome === "Not Going" ? "neutral" : "success"}>
                          {outcome}
                        </StatusChip>
                      ) : (
                        <>
                          <Button
                            disabled={isBusy}
                            onClick={() => {
                              quickRespond(item, eventSlug, "going");
                            }}
                          >
                            RSVP
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={isBusy}
                            onClick={() => {
                              quickRespond(item, eventSlug, "decline");
                            }}
                          >
                            Not Going
                          </Button>
                        </>
                      )}
                      {err ? (
                        <p role="alert" className="bcq-inbox__error">
                          {err}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

const route: AppRoute = { path: "/inbox", component: Inbox };
export default route;
