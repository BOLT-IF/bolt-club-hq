import "./notifications.css";
import { useCallback, useEffect, useState } from "react";

import { usePush } from "../../../components/install/hooks";
import { browserPush } from "../../../components/install/pushPort";
import { Button, ErrorState, GroupedList, Skeleton } from "../../../components/ui";
import type { AppRoute } from "../../registry";
import { fetchPrefs, savePrefs, type NotificationPrefs, type PrefsUpdate } from "./prefsApi";

const LABELS: Record<string, { title: string; hint: string }> = {
  rsvp_status: { title: "RSVP Updates", hint: "You're in, moved to the waitlist, spot offered" },
  event_changes: { title: "Event Changes", hint: "Time, place, or cancellations" },
  new_events: { title: "New Events", hint: "When a session is opened for sign-up" },
  payment_due: { title: "Payment Due", hint: "Reminders about your balance" },
  payment_status: { title: "Payment Status", hint: "Payments received and passes" },
  polls: { title: "Polls", hint: "New polls and results" },
  announcements: { title: "Announcements", hint: "Messages from the club" },
  admin_tasks: { title: "Admin Tasks", hint: "Approvals and alerts for admins" },
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
    <section className="bcq-prefs-page" aria-labelledby="prefs-title">
      <h1 id="prefs-title" className="bcq-page__title">
        Notifications
      </h1>
      <section className="bcq-card bcq-prefs__device" aria-labelledby="prefs-device-title">
        <h2 id="prefs-device-title" className="bcq-prefs__device-title">
          Push on This Device
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
            block
            onClick={() => {
              void enable();
            }}
          >
            Turn On Notifications
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
        <div className="bcq-prefs-groups">
          <p className="bcq-prefs__intro">
            Switch off what you do not want pushed to your phone. Everything still lands in your
            inbox.
          </p>
          <GroupedList.Section title="Global">
            <GroupedList.Row
              asLabel
              label="Mute All Notifications"
              subtitle="Overrides the switches below."
              trailing={
                <input
                  type="checkbox"
                  role="switch"
                  className="bcq-switch"
                  checked={state.prefs.globalMute}
                  onChange={(e) => {
                    change({ globalMute: e.currentTarget.checked });
                  }}
                />
              }
            />
          </GroupedList.Section>
          <GroupedList.Section title="Categories">
            {state.prefs.categories.map(({ category, muted }) => (
              <GroupedList.Row
                key={category}
                asLabel
                label={LABELS[category]?.title ?? category}
                subtitle={LABELS[category]?.hint ?? ""}
                trailing={
                  <input
                    type="checkbox"
                    role="switch"
                    className="bcq-switch"
                    checked={!muted}
                    onChange={(e) => {
                      change({ categories: { [category]: !e.currentTarget.checked } });
                    }}
                  />
                }
              />
            ))}
          </GroupedList.Section>
          {saveError ? (
            <p role="alert" className="bcq-prefs__error">
              Could not save that change. Check your connection and try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const route: AppRoute = { path: "/settings/notifications", component: Settings };
export default route;
