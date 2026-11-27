import { useCallback, useEffect, useState } from "react";

import { DisclosureSection, EmptyState, ErrorState, Skeleton } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import { listPolls, type Poll } from "./api";
import { PollsGate, PollStatus } from "./shared";
import "./polls.css";

function PollRow({ poll }: { readonly poll: Poll }) {
  return (
    <li>
      <a
        className="bcq-polls__item"
        href={`/polls/${poll.id}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(`/polls/${poll.id}`);
        }}
      >
        <span className="bcq-polls__question">{poll.question}</span>
        <span>
          <PollStatus poll={poll} />
          {poll.myVote.length > 0 ? " · You voted" : null}
        </span>
      </a>
    </li>
  );
}

function PollList() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error" } | { kind: "ready"; polls: Poll[] }
  >({ kind: "loading" });

  const load = useCallback(() => {
    listPolls()
      .then((polls) => {
        setState({ kind: "ready", polls });
      })
      .catch(() => {
        setState({ kind: "error" });
      });
  }, []);
  useEffect(load, [load]);

  const activePolls = state.kind === "ready" ? state.polls.filter((p) => !p.closed) : [];
  const pastPolls = state.kind === "ready" ? state.polls.filter((p) => p.closed) : [];

  return (
    <section aria-labelledby="polls-title" className="bcq-polls-page">
      <h1 id="polls-title" className="bcq-page__title">
        Polls
      </h1>
      {state.kind === "loading" ? <Skeleton label="Loading polls" /> : null}
      {state.kind === "error" ? (
        <ErrorState onRetry={load}>Could not load polls.</ErrorState>
      ) : null}
      {state.kind === "ready" && state.polls.length === 0 ? (
        <EmptyState title="No Polls Yet">New polls from the club show up here.</EmptyState>
      ) : null}
      {state.kind === "ready" && state.polls.length > 0 ? (
        <div className="bcq-polls-groups">
          {activePolls.length > 0 ? (
            <ul className="bcq-polls">
              {activePolls.map((p) => (
                <PollRow key={p.id} poll={p} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No Open Polls">All current polls have closed.</EmptyState>
          )}
          {pastPolls.length > 0 ? (
            <DisclosureSection label={`Past Polls (${String(pastPolls.length)})`}>
              <ul className="bcq-polls">
                {pastPolls.map((p) => (
                  <PollRow key={p.id} poll={p} />
                ))}
              </ul>
            </DisclosureSection>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function PollListPage() {
  return (
    <PollsGate>
      <PollList />
    </PollsGate>
  );
}
