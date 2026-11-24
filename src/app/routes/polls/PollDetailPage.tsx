import { useEffect, useState, type SyntheticEvent } from "react";

import { ApiError } from "../../api/client";
import { Button, EmptyState, ErrorState, Skeleton } from "../../components/ui";
import { useRouteParams } from "../registry";
import { getPoll, vote, type Poll, type ResultsVisibility } from "./api";
import { PollsGate, PollStatus } from "./shared";
import "./polls.css";

const HIDDEN_RESULTS: Record<ResultsVisibility, string> = {
  always: "",
  after_vote: "Results are shown after you vote.",
  after_close: "Results are shown when the poll closes.",
  admins: "Results are only shown to admins.",
};

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

function Results({ poll }: { readonly poll: Poll }) {
  if (!poll.results) {
    return <p className="bcq-poll__note">{HIDDEN_RESULTS[poll.resultsVisibility]}</p>;
  }
  const { totalVoters, options } = poll.results;
  return (
    <section aria-labelledby="poll-results" className="bcq-poll__results">
      <h2 id="poll-results" className="bcq-poll__subtitle">
        Results · {plural(totalVoters, "voter")}
      </h2>
      <ul className="bcq-poll__bars">
        {poll.options.map((o) => {
          const r = options.find((x) => x.optionId === o.id);
          const votes = r?.votes ?? 0;
          const pct = totalVoters === 0 ? 0 : Math.round((votes / totalVoters) * 100);
          return (
            <li key={o.id}>
              <span className="bcq-poll__bar-head">
                <span>{o.label}</span>
                <span>{plural(votes, "vote")}</span>
              </span>
              <span className="bcq-poll__bar" aria-hidden="true">
                <span style={{ width: `${String(pct)}%` }} />
              </span>
              {r?.voters && r.voters.length > 0 ? (
                <span className="bcq-poll__voters">
                  {r.voters.map((v) => v.displayName).join(", ")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Detail() {
  const { id = "" } = useRouteParams();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; poll: Poll }
  >({ kind: "loading" });
  const [choice, setChoice] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPoll(id)
      .then((poll) => {
        if (cancelled) return;
        setState({ kind: "ready", poll });
        setChoice([...poll.myVote]);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: error instanceof ApiError && error.status === 404 ? "missing" : "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") return <Skeleton label="Loading poll" />;
  if (state.kind === "missing") {
    return <EmptyState title="We couldn't find that poll">It may have been removed.</EmptyState>;
  }
  if (state.kind === "error") return <ErrorState>We couldn&apos;t load this poll.</ErrorState>;

  const { poll } = state;
  const toggle = (optionId: string, checked: boolean) => {
    setMessage(null);
    setChoice((c) =>
      poll.multiChoice
        ? checked
          ? poll.options.map((o) => o.id).filter((x) => x === optionId || c.includes(x))
          : c.filter((x) => x !== optionId)
        : [optionId],
    );
  };

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    vote(poll.id, choice)
      .then((updated) => {
        setState({ kind: "ready", poll: updated });
        setMessage({ tone: "ok", text: "Your vote is saved." });
      })
      .catch((error: unknown) => {
        const closed =
          error instanceof ApiError &&
          (error.body as { error?: string } | null)?.error === "poll_closed";
        setMessage({
          tone: "error",
          text: closed
            ? "This poll has closed, so your vote wasn't counted."
            : "Your vote wasn't saved. Try again.",
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <article aria-labelledby="poll-title" className="bcq-poll">
      <h1 id="poll-title" className="bcq-page__title">
        {poll.question}
      </h1>
      <p className="bcq-poll__meta">
        <PollStatus poll={poll} />
      </p>
      {poll.anonymous ? (
        <p className="bcq-poll__note">Anonymous poll: votes are counted, names are never shown.</p>
      ) : null}

      {poll.closed ? null : (
        <form onSubmit={submit} className="bcq-poll__form">
          <fieldset>
            <legend className="bcq-poll__subtitle">
              {poll.multiChoice ? "Choose one or more" : "Choose one"}
            </legend>
            {poll.options.map((o) => (
              <label key={o.id} className="bcq-poll__option">
                <input
                  type={poll.multiChoice ? "checkbox" : "radio"}
                  name="poll-option"
                  value={o.id}
                  checked={choice.includes(o.id)}
                  onChange={(e) => {
                    toggle(o.id, e.target.checked);
                  }}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" block disabled={busy || choice.length === 0}>
            {poll.myVote.length > 0 ? "Update vote" : "Vote"}
          </Button>
        </form>
      )}
      <p role="status" className={message?.tone === "error" ? "bcq-poll__error" : "bcq-poll__ok"}>
        {message?.text}
      </p>
      <Results poll={poll} />
    </article>
  );
}

export function PollDetailPage() {
  return (
    <PollsGate>
      <Detail />
    </PollsGate>
  );
}
