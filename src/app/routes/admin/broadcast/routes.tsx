import "./broadcast.css";
import { useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../../api/client";
import { Button, ConfirmDialog } from "../../../components/ui";
import type { AppRoute } from "../../registry";

type Kind = "all" | "pass_holders" | "event_rsvps" | "captains";

const AUDIENCES: readonly { value: Kind; label: string }[] = [
  { value: "all", label: "All Members" },
  { value: "pass_holders", label: "Pass Holders" },
  { value: "event_rsvps", label: "Event RSVPs" },
  { value: "captains", label: "Captains" },
];

const TITLE_MAX = 100;
const BODY_MAX = 1000;

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

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
    <section className="bcq-page bcq-broadcast-page" aria-labelledby="broadcast-title">
      <h1 id="broadcast-title" className="bcq-page__title">
        Broadcast
      </h1>

      <div className="bcq-broadcast-section">
        <p className="bcq-broadcast-section__label">Compose Message</p>
        <form className="bcq-card bcq-broadcast" onSubmit={review} noValidate>
          <div className="bcq-broadcast__field">
            <label htmlFor="broadcast-audience" className="bcq-broadcast__label">
              Send To
            </label>
            <select
              id="broadcast-audience"
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
          </div>

          {kind === "event_rsvps" ? (
            <div className="bcq-broadcast__field">
              <label htmlFor="broadcast-event" className="bcq-broadcast__label">
                Event ID or Share Slug
              </label>
              <input
                id="broadcast-event"
                className="bcq-broadcast__input--mono"
                placeholder="e.g. sunday-social-jan-17"
                value={eventRef}
                autoComplete="off"
                onChange={(e) => {
                  setEventRef(e.target.value);
                }}
              />
            </div>
          ) : null}

          <div className="bcq-broadcast__field">
            <div className="bcq-broadcast__label-row">
              <label htmlFor="broadcast-heading" className="bcq-broadcast__label">
                Title
              </label>
              <span className="bcq-broadcast__counter">
                {title.length} / {TITLE_MAX}
              </span>
            </div>
            <input
              id="broadcast-heading"
              placeholder="e.g. Court change for Sunday Social"
              value={title}
              maxLength={TITLE_MAX}
              autoComplete="off"
              onChange={(e) => {
                setTitle(e.target.value);
              }}
            />
          </div>

          <div className="bcq-broadcast__field">
            <div className="bcq-broadcast__label-row">
              <label htmlFor="broadcast-body" className="bcq-broadcast__label">
                Message
              </label>
              <span className="bcq-broadcast__counter">
                {body.length} / {BODY_MAX}
              </span>
            </div>
            <textarea
              id="broadcast-body"
              placeholder="Write a clear announcement for members..."
              value={body}
              rows={5}
              maxLength={BODY_MAX}
              onChange={(e) => {
                setBody(e.target.value);
              }}
            />
          </div>

          <div className="bcq-broadcast__note">
            <span className="bcq-broadcast__note-icon" aria-hidden="true">
              <BellIcon />
            </span>
            <p className="bcq-broadcast__hint">
              Members who muted notifications still receive this in their inbox without a push
              alert.
            </p>
          </div>

          {error ? (
            <p role="alert" className="bcq-broadcast__error">
              {error}
            </p>
          ) : null}
          {sent ? (
            <p role="status" className="bcq-broadcast__status">
              <CheckCircleIcon />
              <span>{sent}</span>
            </p>
          ) : null}

          <Button type="submit" block>
            <SendIcon />
            <span>Review &amp; Send</span>
          </Button>
        </form>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Send Broadcast?"
        description={`"${title.trim()}" will be sent to ${audienceLabel}. This cannot be undone.`}
        confirmLabel={sending ? "Sending…" : "Send Broadcast"}
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
