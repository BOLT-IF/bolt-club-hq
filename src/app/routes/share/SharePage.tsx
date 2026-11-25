import { useEffect, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import type { EventWithViewer } from "../../api/events";
import { peekIntent, saveIntent, takeIntent } from "../../auth/intent";
import { noteRsvpSaved } from "../../components/install";
import { Button, ErrorState, Skeleton, StatusChip } from "../../components/ui";
import { navigate, useCurrentPath } from "../../lib/navigate";
import { formatWhen } from "../events/format";
import { Slot } from "../events/slots";
import { matchPath } from "../registry";
import "../events/events.css";

type Kind = "event" | "series";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "non_member" }
  | { readonly kind: "missing" }
  | { readonly kind: "error" }
  | ({ readonly kind: "ready" } & EventWithViewer);

function slugFromPath(kind: Kind, path: string): string {
  const pattern = kind === "event" ? "/e/:slug" : "/s/:slug";
  return matchPath(pattern, path)?.slug ?? "";
}

function ShareLanding({ kind }: { readonly kind: Kind }) {
  const path = useCurrentPath();
  const slug = slugFromPath(kind, path);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const isAborted = () => controller.signal.aborted;
    const apiPath =
      kind === "event"
        ? `/events/by-slug/${encodeURIComponent(slug)}`
        : `/series/by-slug/${encodeURIComponent(slug)}/next`;

    apiFetch<EventWithViewer>(apiPath, {
      redirectOnUnauthorized: false,
      signal: controller.signal,
    })
      .then(async (data) => {
        if (isAborted()) return;
        const intent = peekIntent();
        if (intent?.rsvp?.eventSlug === data.event.slug) {
          takeIntent();
          try {
            await apiFetch(`/events/${encodeURIComponent(data.event.id)}/rsvp`, {
              method: "PUT",
              body: { guests: [] },
              idempotencyKey: newIdempotencyKey(),
            });
            noteRsvpSaved();
          } catch {
            // If auto-RSVP fails (e.g. already closed), the event page still lets the member see why.
          }
        }
        if (!isAborted()) setState({ kind: "ready", ...data });
      })
      .catch((error: unknown) => {
        if (isAborted()) return;
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 401) setState({ kind: "signed_out" });
        else if (status === 403) setState({ kind: "non_member" });
        else if (status === 404) setState({ kind: "missing" });
        else setState({ kind: "error" });
      });

    return () => {
      controller.abort();
    };
  }, [kind, slug]);

  if (state.kind === "loading") return <Skeleton label="Loading event" />;

  if (state.kind === "signed_out") {
    const returnTo =
      kind === "event" ? `/e/${encodeURIComponent(slug)}` : `/s/${encodeURIComponent(slug)}`;
    const onSignIn = () => {
      saveIntent({
        returnTo,
        ...(kind === "event" ? { rsvp: { eventSlug: slug, response: "in" } } : {}),
      });
      navigate(`/sign-in?return_to=${encodeURIComponent(returnTo)}`);
    };
    return (
      <section className="bcq-page" aria-labelledby="share-signin-title">
        <h1 id="share-signin-title" className="bcq-page__title">
          Sign in to RSVP
        </h1>
        <p>Sign in with your email code to view this event and save your spot.</p>
        <p>
          <Button variant="primary" onClick={onSignIn}>
            I&apos;m in — sign in
          </Button>
        </p>
      </section>
    );
  }

  if (state.kind === "non_member") {
    const joinPath =
      kind === "event"
        ? `/join/event/${encodeURIComponent(slug)}`
        : `/join/series/${encodeURIComponent(slug)}`;
    return (
      <section className="bcq-page" aria-labelledby="share-join-title">
        <h1 id="share-join-title" className="bcq-page__title">
          Events are for approved members
        </h1>
        <p>Ask an admin to approve your membership. Your RSVP will be saved until then.</p>
        <p>
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
        </p>
      </section>
    );
  }

  if (state.kind === "missing") {
    return (
      <section className="bcq-page" aria-labelledby="share-missing-title">
        <h1 id="share-missing-title" className="bcq-page__title">
          {kind === "event" ? "We couldn't find that event" : "We couldn't find that series"}
        </h1>
        <p>The link may be old or mistyped.</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return <ErrorState>We couldn&apos;t load this event.</ErrorState>;
  }

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

export function ShareEventPage() {
  return <ShareLanding kind="event" />;
}

export function ShareSeriesPage() {
  return <ShareLanding kind="series" />;
}
