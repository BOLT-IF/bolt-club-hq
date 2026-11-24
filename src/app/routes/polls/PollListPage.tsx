import { useCallback, useEffect, useState } from "react";

import { EmptyState, ErrorState, Skeleton } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import { listPolls, type Poll } from "./api";
import { PollsGate, PollStatus } from "./shared";
import "./polls.css";

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

  return (
    <section aria-labelledby="polls-title">
      <h1 id="polls-title" className="bcq-page__title">
        Polls
      </h1>
      {state.kind === "loading" ? <Skeleton label="Loading polls" /> : null}
      {state.kind === "error" ? (
        <ErrorState onRetry={load}>Could not load polls.</ErrorState>
      ) : null}
      {state.kind === "ready" && state.polls.length === 0 ? (
        <EmptyState title="No polls yet">New polls from the club show up here.</EmptyState>
      ) : null}
      {state.kind === "ready" && state.polls.length > 0 ? (
        <ul className="bcq-polls">
          {state.polls.map((p) => (
            <li key={p.id}>
              <a
                className="bcq-polls__item"
                href={`/polls/${p.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/polls/${p.id}`);
                }}
              >
                <span className="bcq-polls__question">{p.question}</span>
                <span>
                  <PollStatus poll={p} />
                  {p.myVote.length > 0 ? " · You voted" : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
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
