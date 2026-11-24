import "./broadcast.css";
import { useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { Button, ConfirmDialog } from "../../../components/ui";
import type { AppRoute } from "../../registry";

type Kind = "all" | "pass_holders" | "event_rsvps" | "captains";

const AUDIENCES: readonly { value: Kind; label: string }[] = [
  { value: "all", label: "All members" },
  { value: "pass_holders", label: "Pass holders" },
  { value: "event_rsvps", label: "An event's RSVPs" },
  { value: "captains", label: "Captains" },
];

const TITLE_MAX = 100;
const BODY_MAX = 1000;

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code === "event_not_found") return "That event was not found. Check the ID or share slug.";
  }
  return "Could not send the broadcast. Try again.";
}

function Broadcast() {
  const [kind, setKind] = useState<Kind>("all");
  const [eventRef, setEventRef] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [key, setKey] = useState("");

  const review = (e: SyntheticEvent) => {
    e.preventDefault();
    setSent(null);
    const problem = !title.trim()
      ? "Add a title."
      : !body.trim()
        ? "Write a message."
        : kind === "event_rsvps" && !eventRef.trim()
          ? "Enter the event."
          : null;
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setKey(newIdempotencyKey());
    setConfirming(true);
  };

  const send = () => {
    setSending(true);
    const audience = kind === "event_rsvps" ? { kind, eventId: eventRef.trim() } : { kind };
    apiFetch<{ recipientCount: number }>("/admin/broadcasts", {
      method: "POST",
      idempotencyKey: key,
      body: { title: title.trim(), body: body.trim(), audience },
    })
      .then(({ recipientCount }) => {
        setSent(
          `Sent to ${String(recipientCount)} ${recipientCount === 1 ? "member" : "members"}.`,
        );
        setTitle("");
        setBody("");
        setEventRef("");
      })
      .catch((e: unknown) => {
        setError(errorText(e));
      })
      .finally(() => {
        setSending(false);
        setConfirming(false);
      });
  };

  const audienceLabel = AUDIENCES.find((a) => a.value === kind)?.label ?? "";

  return (
    <section aria-labelledby="broadcast-title">
      <h1 id="broadcast-title" className="bcq-page__title">
        Broadcast
      </h1>
      <form className="bcq-broadcast" onSubmit={review} noValidate>
        <label className="bcq-broadcast__field">
          Send to
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
            }}
          >
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {kind === "event_rsvps" ? (
          <label className="bcq-broadcast__field">
            Event ID or share slug
            <input
              value={eventRef}
              autoComplete="off"
              onChange={(e) => {
                setEventRef(e.target.value);
              }}
            />
          </label>
        ) : null}
        <label className="bcq-broadcast__field">
          Title
          <input
            value={title}
            maxLength={TITLE_MAX}
            autoComplete="off"
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </label>
        <label className="bcq-broadcast__field">
          Message
          <textarea
            value={body}
            rows={5}
            maxLength={BODY_MAX}
            onChange={(e) => {
              setBody(e.target.value);
            }}
          />
        </label>
        <p className="bcq-broadcast__hint">
          Members who muted notifications still get it in their inbox, but no push.
        </p>
        {error ? (
          <p role="alert" className="bcq-broadcast__error">
            {error}
          </p>
        ) : null}
        {sent ? <p role="status">{sent}</p> : null}
        <Button type="submit" block>
          Review and send
        </Button>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Send broadcast?"
        description={`"${title.trim()}" goes to: ${audienceLabel}. This cannot be undone.`}
        confirmLabel={sending ? "Sending…" : "Send broadcast"}
        onConfirm={() => {
          if (!sending) send();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </section>
  );
}

const route: AppRoute = { path: "/admin/broadcast", component: Broadcast };
export default route;
