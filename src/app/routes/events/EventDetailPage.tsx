import { useEffect, useState } from "react";

import { ApiError } from "../../api/client";
import { getEventBySlug, type EventWithViewer } from "../../api/events";
import { EmptyState, ErrorState, Skeleton, StatusChip } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import { useRouteParams } from "../registry";
import { formatWhen } from "./format";
import { Slot } from "./slots";
import "./events.css";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "blocked" }
  | { readonly kind: "error" }
  | ({ readonly kind: "ready" } & EventWithViewer);

export function EventDetailPage() {
  const { slug = "" } = useRouteParams();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getEventBySlug(slug)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", ...data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = error instanceof ApiError ? error.status : 0;
        setState({
          kind: status === 404 ? "missing" : status === 403 ? "blocked" : "error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.kind === "loading") return <Skeleton label="Loading event" />;
  if (state.kind === "missing") {
    return (
      <EmptyState title="We couldn't find that event">The link may be old or mistyped.</EmptyState>
    );
  }
  if (state.kind === "blocked") {
    const joinPath = `/join/event/${encodeURIComponent(slug)}`;
    return (
      <EmptyState
        title="Events are for approved members"
        action={
          <a
            className="bcq-btn bcq-btn--secondary"
            href={joinPath}
            onClick={(click) => {
              if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
              click.preventDefault();
              navigate(joinPath);
            }}
          >
            Request to join
          </a>
        }
      >
        You can see this event once an admin approves your membership.
      </EmptyState>
    );
  }
  if (state.kind === "error") return <ErrorState>We couldn&apos;t load this event.</ErrorState>;

  const { event, viewer } = state;
  return (
    <article aria-labelledby="event-title" className="bcq-event">
      <h1 id="event-title" className="bcq-page__title">
        {event.title}
      </h1>
      <p className="bcq-event__when">{formatWhen(event.startsAt, event.endsAt)}</p>
      {event.location ? <p className="bcq-event__where">{event.location}</p> : null}
      <p className="bcq-event__chips">
        <StatusChip>{event.format}</StatusChip>{" "}
        {event.status === "cancelled" ? <StatusChip tone="danger">Cancelled</StatusChip> : null}
        {event.readOnly && event.status !== "cancelled" ? (
          <StatusChip>Past event</StatusChip>
        ) : null}
      </p>

      <Slot name="RsvpSlot" event={event} viewer={viewer} />
      <Slot name="ShareSlot" event={event} viewer={viewer} />
      {viewer.canManage && !event.readOnly ? (
        <Slot name="OrganizerToolsSlot" event={event} viewer={viewer} />
      ) : null}
      {viewer.canSeeAttendees ? <Slot name="AttendeesSlot" event={event} viewer={viewer} /> : null}
    </article>
  );
}
