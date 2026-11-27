import { useCallback, useEffect, useState } from "react";

import { listEvents, type EventDetail } from "../../api/events";
import {
  ChevronRightIcon,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
} from "../../components/ui";
import { navigate } from "../../lib/navigate";
import { formatWhen } from "./format";
import "./events.css";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly events: EventDetail[] };

export function EventListPage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listEvents()
      .then((events) => {
        if (!cancelled) setState({ kind: "ready", events });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section aria-labelledby="events-title">
      <div className="bcq-events__head">
        <h1 id="events-title" className="bcq-page__title">
          Events
        </h1>
        <a
          className="bcq-btn bcq-btn--tonal"
          href="/events/new"
          onClick={(click) => {
            if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
            click.preventDefault();
            navigate("/events/new");
          }}
        >
          New Event
        </a>
      </div>
      {state.kind === "loading" ? <Skeleton label="Loading events" /> : null}
      {state.kind === "error" ? (
        <ErrorState onRetry={retry}>We couldn&apos;t load the events.</ErrorState>
      ) : null}
      {state.kind === "ready" && state.events.length === 0 ? (
        <EmptyState title="No Upcoming Events">New sessions will show up here.</EmptyState>
      ) : null}
      {state.kind === "ready" && state.events.length > 0 ? (
        <ul className="bcq-events">
          {state.events.map((e) => (
            <li key={e.id}>
              <a
                className="bcq-events__item"
                href={`/events/${e.slug}`}
                onClick={(click) => {
                  if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0)
                    return;
                  click.preventDefault();
                  navigate(`/events/${e.slug}`);
                }}
              >
                <span className="bcq-events__main">
                  <span className="bcq-events__title">{e.title}</span>
                  <span className="bcq-events__meta">
                    {formatWhen(e.startsAt, e.endsAt)}
                    {e.location ? ` · ${e.location}` : ""}
                  </span>
                  {e.status === "cancelled" ? (
                    <span className="bcq-events__badge">
                      <StatusChip tone="danger">Cancelled</StatusChip>
                    </span>
                  ) : null}
                </span>
                <span className="bcq-events__chevron" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
