import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../api/client";
import type { SlotProps } from "../../routes/events/slots";
import { Button, ErrorState, Skeleton } from "../ui";
import "./roster-link.css";

interface RosterPlayerDto {
  readonly name: string;
  readonly short: string;
  readonly guest: boolean;
}

interface RosterLinkResponse {
  readonly rosterAppUrl: string | null;
  readonly url: string | null;
  readonly textList: string;
  readonly players: readonly RosterPlayerDto[];
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: RosterLinkResponse };

export function RosterLinkPanel({ event, viewer }: SlotProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const visible = viewer.canManage && event.status === "closed";

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    apiFetch<RosterLinkResponse>(`/events/${encodeURIComponent(event.id)}/roster-link`)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, visible, reloadKey]);

  if (!visible) return null;
  if (state.kind === "loading") return <Skeleton label="Loading roster link" />;
  if (state.kind === "error") {
    return <ErrorState onRetry={retry}>Could not load roster link.</ErrorState>;
  }

  const { data } = state;

  const handleCopy = async () => {
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(data.textList);
      setCopyStatus("Copied list");
    } catch {
      setCopyStatus("Could not copy list");
    }
  };

  return (
    <section className="bcq-roster-link" aria-labelledby="roster-link-heading">
      <div className="bcq-roster-link__head">
        <h2 id="roster-link-heading" className="bcq-roster-link__title">
          Roster
        </h2>
      </div>
      <p className="bcq-roster-link__note">
        {data.players.length === 0
          ? "No confirmed players yet."
          : `${String(data.players.length)} confirmed ${data.players.length === 1 ? "player" : "players"} ready for draw.`}
      </p>
      <div className="bcq-roster-link__actions">
        {data.url ? (
          <a
            className="bcq-btn bcq-btn--primary"
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in roster generator
          </a>
        ) : null}
        <Button variant={data.url ? "secondary" : "primary"} onClick={() => void handleCopy()}>
          Copy list
        </Button>
      </div>
      {copyStatus ? (
        <p role="status" className="bcq-roster-link__status">
          {copyStatus}
        </p>
      ) : null}
    </section>
  );
}
