import { useEffect, useState } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { peekIntent, takeIntent } from "../../auth/intent";
import { ErrorState, Skeleton, StatusChip } from "../../components/ui";
import { useCurrentPath } from "../../lib/navigate";
import { matchPath } from "../registry";
import { completeJoinRsvpIntent, peekJoinRsvpIntent, saveJoinRsvpIntent } from "./joinIntent";
import type { CompleteResult } from "./joinIntent";

type Source =
  | { readonly via: "invite"; readonly token: string }
  | { readonly via: "event_link" | "series_link"; readonly slug: string };

/** The join source in the current path, or null for plain `/join`. */
function sourceOf(path: string): Source | null {
  const event = matchPath("/join/event/:slug", path);
  if (event?.slug) return { via: "event_link", slug: event.slug };
  const series = matchPath("/join/series/:slug", path);
  if (series?.slug) return { via: "series_link", slug: series.slug };
  const invite = matchPath("/join/:token", path);
  if (invite?.token) return { via: "invite", token: invite.token };
  return null;
}

const REFUSALS: Record<string, string> = {
  invite_expired: "This invite link has expired. Ask an admin for a new one.",
  invite_revoked: "This invite link has been withdrawn. Ask an admin for a new one.",
  invite_used_up: "This invite link has been used up. Ask an admin for a new one.",
  invite_not_found: "We don't recognise this invite link. Check that you copied all of it.",
  link_not_found: "We couldn't find that event or series. The link may be old.",
};

function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { error?: unknown } | null)?.error;
  if (typeof code === "string" && REFUSALS[code]) return REFUSALS[code];
  if (error.status === 403) return "This account can't join the club. Contact an admin.";
  return null;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "waiting"; readonly requested: boolean; readonly rsvpSaved: boolean }
  | { readonly kind: "member"; readonly rsvp: CompleteResult };

/** Moves an RSVP saved at sign-in into the long-lived join intent (approval can take days). */
function keepRsvpFromSignIn(source: Source | null): void {
  const rsvp = peekIntent()?.rsvp;
  if (!rsvp) return;
  if (source?.via === "event_link" && source.slug !== rsvp.eventSlug) return;
  saveJoinRsvpIntent(rsvp.eventSlug);
  takeIntent();
}

async function load(source: Source | null): Promise<State> {
  const me = await apiFetch<{ status: string }>("/me");
  if (me.status === "active") return { kind: "member", rsvp: await completeJoinRsvpIntent() };
  if (me.status !== "pending") {
    return { kind: "refused", message: "This account can't join the club. Contact an admin." };
  }
  keepRsvpFromSignIn(source);
  if (source) {
    const body =
      source.via === "invite"
        ? { via: source.via, token: source.token }
        : { via: source.via, slug: source.slug };
    try {
      await apiFetch("/join-requests", { method: "POST", body });
    } catch (error) {
      const message = refusalText(error);
      if (message) return { kind: "refused", message };
      throw error;
    }
  }
  const mine = await apiFetch<{ request: unknown }>("/join-requests/mine");
  return {
    kind: "waiting",
    requested: mine.request !== null,
    rsvpSaved: peekJoinRsvpIntent() !== null,
  };
}

/**
 * `/join`, `/join/:token` (invite), `/join/event/:slug`, `/join/series/:slug`. Files the join
 * request and shows the waiting screen. A pending member sees nothing else of the club here:
 * no member directory, no attendee names. After approval it completes the stored RSVP.
 */
export function JoinPage() {
  const path = useCurrentPath();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    load(sourceOf(path))
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state.kind === "loading") return <Skeleton label="Checking your membership" />;
  if (state.kind === "error") {
    return (
      <ErrorState title="Couldn't reach the club">
        Check your connection and open the link again.
      </ErrorState>
    );
  }
  if (state.kind === "refused") {
    return <ErrorState title="Can't use this link">{state.message}</ErrorState>;
  }
  if (state.kind === "member") return <Welcome rsvp={state.rsvp} />;

  return (
    <section className="bcq-page" aria-labelledby="join-title">
      <h1 id="join-title" className="bcq-page__title">
        {state.requested ? "Waiting for approval" : "Ask to join"}
      </h1>
      {state.requested ? (
        <>
          <p>
            <StatusChip tone="warning">Pending</StatusChip>
          </p>
          <p>
            An admin has been told about your request. You&apos;ll get full access as soon as they
            approve it. Until then you can&apos;t see events, members or payments.
          </p>
          {state.rsvpSaved ? (
            <p>Your RSVP will be sent automatically when you&apos;re approved.</p>
          ) : null}
        </>
      ) : (
        <p>
          BOLT IF is invite only. Open the invite link an admin sent you, or tap &quot;Request to
          join&quot; on an event or series link.
        </p>
      )}
    </section>
  );
}

function Welcome({ rsvp }: { readonly rsvp: CompleteResult }) {
  const eventHref =
    rsvp.kind === "done" || rsvp.kind === "dropped"
      ? `/events/${encodeURIComponent(rsvp.eventSlug)}`
      : null;
  return (
    <section className="bcq-page" aria-labelledby="join-title">
      <h1 id="join-title" className="bcq-page__title">
        You&apos;re in
      </h1>
      <p>Your membership is approved. Welcome to BOLT IF.</p>
      {rsvp.kind === "done" ? <p role="status">Your RSVP has been sent.</p> : null}
      {rsvp.kind === "dropped" ? (
        <p role="status">We couldn&apos;t send your saved RSVP: RSVPs may have closed.</p>
      ) : null}
      {rsvp.kind === "retry" ? (
        <p role="status">Your saved RSVP will be sent the next time you open the app.</p>
      ) : null}
      {eventHref ? (
        <a className="bcq-btn bcq-btn--primary" href={eventHref}>
          Open the event
        </a>
      ) : (
        <a className="bcq-btn bcq-btn--primary" href="/events">
          See events
        </a>
      )}
    </section>
  );
}
