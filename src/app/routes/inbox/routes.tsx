import "./inbox.css";
import { useCallback, useEffect, useState } from "react";

import {
  fetchNotifications,
  markNotificationsRead,
  type InboxItem,
  type InboxPage,
} from "../../api/notifications";
import { Button, EmptyState, ErrorState, Skeleton, StatusChip } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import type { AppRoute } from "../registry";

/** Only in-app paths are followed; the server enforces this too (defence in depth). */
const isInAppPath = (link: string): boolean => /^\/(?![/\\])/.test(link);

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
              Mark all read
            </Button>
          ) : null}
          <ul className="bcq-inbox">
            {state.items.map((item) => (
              <li key={item.id}>
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
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

const route: AppRoute = { path: "/inbox", component: Inbox };
export default route;
