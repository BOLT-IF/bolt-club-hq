import "./notifications.css";
import { useCallback, useEffect, useState } from "react";

import { usePush } from "../../../components/install/hooks";
import { browserPush } from "../../../components/install/pushPort";
import { Button, ErrorState, Skeleton } from "../../../components/ui";
import type { AppRoute } from "../../registry";
import { fetchPrefs, savePrefs, type NotificationPrefs, type PrefsUpdate } from "./prefsApi";

const LABELS: Record<string, { title: string; hint: string }> = {
  rsvp_status: { title: "RSVP updates", hint: "You're in, moved to the waitlist, spot offered" },
  event_changes: { title: "Event changes", hint: "Time, place or cancellations" },
  new_events: { title: "New events", hint: "When a session is opened for sign-up" },
  payment_due: { title: "Payment due", hint: "Reminders about your balance" },
  payment_status: { title: "Payment status", hint: "Payments received and passes" },
  polls: { title: "Polls", hint: "New polls and results" },
  announcements: { title: "Announcements", hint: "Messages from the club" },
  admin_tasks: { title: "Admin tasks", hint: "Approvals and alerts for admins" },
};

function Settings() {
  const { permission, enable } = usePush(browserPush);
  const [state, setState] = useState<
    { status: "loading" } | { status: "error" } | { status: "ready"; prefs: NotificationPrefs }
  >({ status: "loading" });
  const [saveError, setSaveError] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    fetchPrefs(signal)
      .then((prefs) => {
        setState({ status: "ready", prefs });
      })
      .catch(() => {
        if (!signal?.aborted) setState({ status: "error" });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  /** Optimistic: apply, save, and put the previous value back if the save fails. */
  const change = (update: PrefsUpdate) => {
    if (state.status !== "ready") return;
    const before = state.prefs;
    setSaveError(false);
    setState({
      status: "ready",
      prefs: {
        globalMute: update.globalMute ?? before.globalMute,
        categories: before.categories.map((c) => ({
          ...c,
          muted: update.categories?.[c.category] ?? c.muted,
        })),
      },
    });
    savePrefs(update).catch(() => {
      setSaveError(true);
      setState({ status: "ready", prefs: before });
    });
  };

  return (
    <section aria-labelledby="prefs-title">
      <h1 id="prefs-title" className="bcq-page__title">
        Notifications
      </h1>
      <section className="bcq-prefs__device" aria-labelledby="prefs-device-title">
        <h2 id="prefs-device-title" className="bcq-prefs__device-title">
          Push on this device
        </h2>
        {permission === "granted" ? (
          <p className="bcq-prefs__hint" role="status">
            Push notifications are on for this device.
          </p>
        ) : permission === "denied" ? (
          <p className="bcq-prefs__hint">
            Push notifications are blocked. Allow them for this site in your browser or phone
            settings.
          </p>
        ) : permission === null ? (
          <p className="bcq-prefs__hint">
            This browser can&apos;t show push notifications. On iPhone, add BOLT HQ to your home
            screen first.
          </p>
        ) : (
          <Button
            onClick={() => {
              void enable();
            }}
          >
            Turn on notifications
          </Button>
        )}
      </section>
      {state.status === "loading" ? <Skeleton label="Loading your settings" /> : null}
      {state.status === "error" ? (
        <ErrorState
          onRetry={() => {
            setState({ status: "loading" });
            load();
          }}
        >
          Could not load your notification settings.
        </ErrorState>
      ) : null}
      {state.status === "ready" ? (
        <>
          <p>
            Switch off what you do not want pushed to your phone. Everything still lands in your
            inbox.
          </p>
          <ul className="bcq-prefs">
            <li>
              <label className="bcq-prefs__row">
                <span className="bcq-prefs__text">
                  <strong>Mute all notifications</strong>
                  <span className="bcq-prefs__hint">Overrides the switches below</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="bcq-prefs__switch"
                  checked={state.prefs.globalMute}
                  onChange={(e) => {
                    change({ globalMute: e.currentTarget.checked });
                  }}
                />
              </label>
            </li>
            {state.prefs.categories.map(({ category, muted }) => (
              <li key={category}>
                <label className="bcq-prefs__row">
                  <span className="bcq-prefs__text">
                    <strong>{LABELS[category]?.title ?? category}</strong>
                    <span className="bcq-prefs__hint">{LABELS[category]?.hint ?? ""}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="bcq-prefs__switch"
                    checked={!muted}
                    onChange={(e) => {
                      change({ categories: { [category]: !e.currentTarget.checked } });
                    }}
                  />
                </label>
              </li>
            ))}
          </ul>
          {saveError ? (
            <p role="alert" className="bcq-prefs__error">
              Could not save that change. Check your connection and try again.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const route: AppRoute = { path: "/settings/notifications", component: Settings };
export default route;
