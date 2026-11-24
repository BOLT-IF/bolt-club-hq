import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { ApiError } from "../../api/client";
import { Button, ConfirmDialog, ErrorState, Skeleton } from "../../components/ui";
import { navigate } from "../../lib/navigate";
import {
  closePoll,
  createPoll,
  deletePoll,
  listPolls,
  type Poll,
  type ResultsVisibility,
} from "./api";
import { PollsGate, PollStatus } from "./shared";
import "./polls.css";

const MAX_OPTIONS = 20;

const VISIBILITY_LABELS: Record<ResultsVisibility, string> = {
  always: "Everyone, at any time",
  after_vote: "Members after they vote",
  after_close: "Everyone once the poll closes",
  admins: "Admins only",
};

/** `<input type="datetime-local">` gives local wall time; send it as a UTC instant. */
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

function CreateForm({ onCreated }: { readonly onCreated: (p: Poll) => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiChoice, setMultiChoice] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [visibility, setVisibility] = useState<ResultsVisibility>("always");
  const [closesAt, setClosesAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    createPoll({
      question: question.trim(),
      options: options.map((o) => o.trim()).filter((o) => o !== ""),
      multiChoice,
      anonymous,
      resultsVisibility: visibility,
      closesAt: toIso(closesAt),
    })
      .then((p) => {
        setQuestion("");
        setOptions(["", ""]);
        setMultiChoice(false);
        setAnonymous(false);
        setVisibility("always");
        setClosesAt("");
        onCreated(p);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 403
            ? "Only admins can create polls."
            : "The poll wasn't created. Check the question, at least two different options and a future closing time.",
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form onSubmit={submit} className="bcq-poll__form" aria-labelledby="new-poll-title">
      <h2 id="new-poll-title" className="bcq-poll__subtitle">
        New poll
      </h2>
      <label className="bcq-field">
        <span>Question</span>
        <input
          required
          maxLength={300}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
        />
      </label>
      {options.map((value, i) => (
        <label key={i} className="bcq-field">
          <span>{`Option ${String(i + 1)}`}</span>
          <input
            required={i < 2}
            maxLength={120}
            value={value}
            onChange={(e) => {
              const next = [...options];
              next[i] = e.target.value;
              setOptions(next);
            }}
          />
        </label>
      ))}
      {options.length < MAX_OPTIONS ? (
        <Button
          variant="secondary"
          onClick={() => {
            setOptions([...options, ""]);
          }}
        >
          Add option
        </Button>
      ) : null}
      <label className="bcq-poll__option">
        <input
          type="checkbox"
          checked={multiChoice}
          onChange={(e) => {
            setMultiChoice(e.target.checked);
          }}
        />
        <span>Allow several choices</span>
      </label>
      <label className="bcq-poll__option">
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(e) => {
            setAnonymous(e.target.checked);
          }}
        />
        <span>Anonymous (names are never shown, not even to admins; cannot be changed later)</span>
      </label>
      <label className="bcq-field">
        <span>Who sees results</span>
        <select
          value={visibility}
          onChange={(e) => {
            setVisibility(e.target.value as ResultsVisibility);
          }}
        >
          {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="bcq-field">
        <span>Closes (optional)</span>
        <input
          type="datetime-local"
          value={closesAt}
          onChange={(e) => {
            setClosesAt(e.target.value);
          }}
        />
      </label>
      <p role="status" className="bcq-poll__error">
        {error}
      </p>
      <Button type="submit" block disabled={busy}>
        Create poll
      </Button>
    </form>
  );
}

function AdminPolls() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error" } | { kind: "ready"; polls: Poll[] }
  >({ kind: "loading" });
  const [confirm, setConfirm] = useState<{ action: "close" | "delete"; poll: Poll } | null>(null);

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

  const act = () => {
    if (!confirm) return;
    const { action, poll } = confirm;
    setConfirm(null);
    (action === "close" ? closePoll(poll.id) : deletePoll(poll.id)).then(load).catch(load);
  };

  return (
    <section aria-labelledby="admin-polls-title">
      <h1 id="admin-polls-title" className="bcq-page__title">
        Polls
      </h1>
      <CreateForm onCreated={load} />
      <h2 className="bcq-poll__subtitle">All polls</h2>
      {state.kind === "loading" ? <Skeleton label="Loading polls" /> : null}
      {state.kind === "error" ? (
        <ErrorState onRetry={load}>Could not load polls.</ErrorState>
      ) : null}
      {state.kind === "ready" ? (
        <ul className="bcq-polls">
          {state.polls.map((p) => (
            <li key={p.id} className="bcq-polls__item">
              <a
                className="bcq-polls__question"
                href={`/polls/${p.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/polls/${p.id}`);
                }}
              >
                {p.question}
              </a>
              <span>
                <PollStatus poll={p} />
                {p.results ? ` · ${String(p.results.totalVoters)} voted` : null}
              </span>
              <span className="bcq-polls__actions">
                {p.closed ? null : (
                  <Button
                    variant="secondary"
                    aria-label={`Close now: ${p.question}`}
                    onClick={() => {
                      setConfirm({ action: "close", poll: p });
                    }}
                  >
                    Close now
                  </Button>
                )}
                <Button
                  variant="ghost"
                  aria-label={`Delete: ${p.question}`}
                  onClick={() => {
                    setConfirm({ action: "delete", poll: p });
                  }}
                >
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.action === "delete" ? "Delete poll?" : "Close poll?"}
        description={
          confirm?.action === "delete"
            ? "The poll, its options and all votes are removed for good."
            : "Members can no longer vote. This can't be undone."
        }
        confirmLabel={confirm?.action === "delete" ? "Delete poll" : "Close poll"}
        destructive={confirm?.action === "delete"}
        onConfirm={act}
        onCancel={() => {
          setConfirm(null);
        }}
      />
    </section>
  );
}

export function AdminPollsPage() {
  return (
    <PollsGate>
      <AdminPolls />
    </PollsGate>
  );
}
