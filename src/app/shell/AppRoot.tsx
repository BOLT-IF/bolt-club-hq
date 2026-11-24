import { useEffect, useState } from "react";

import { apiFetch } from "../api/client";
import { fetchNotifications } from "../api/notifications";
import { resolveRoute } from "../routes/registry";
import { completeJoinRsvpIntent, peekJoinRsvpIntent } from "../routes/join/joinIntent";
import { EmptyState } from "../components/ui/States";
import { ToastProvider } from "../components/ui/Toast";
import { FeatureFlagsProvider, type FeatureFlags } from "../lib/flags";
import { useCurrentPath } from "../lib/navigate";
import { AppShell } from "./AppShell";
import "../components/ui/ui.css";
import "./shell.css";

interface ConfigResponse {
  readonly flags?: FeatureFlags;
}

/** Loads /api/v1/config. Fails closed: on error every flag reads as off. */
function useFlags(): { readonly flags: FeatureFlags; readonly loaded: boolean } {
  const [state, setState] = useState<{ flags: FeatureFlags; loaded: boolean }>({
    flags: {},
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    apiFetch<ConfigResponse>("/config")
      .then((config) => {
        if (!cancelled) setState({ flags: config.flags ?? {}, loaded: true });
      })
      .catch(() => {
        if (!cancelled) setState({ flags: {}, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function AppRoot() {
  const path = useCurrentPath();
  const { flags } = useFlags();
  const [inboxUnread, setInboxUnread] = useState(0);
  const Page = resolveRoute(path)?.route.component;

  useEffect(() => {
    if (peekJoinRsvpIntent()) {
      void completeJoinRsvpIntent();
    }
  }, []);

  useEffect(() => {
    if (flags.inbox !== true) return;
    const controller = new AbortController();
    fetchNotifications(controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setInboxUnread(page.unreadCount);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [flags.inbox, path]);

  const badges = flags.inbox === true && inboxUnread > 0 ? { inbox: inboxUnread } : {};

  return (
    <FeatureFlagsProvider flags={flags}>
      <ToastProvider>
        <AppShell path={path} badges={badges}>
          {Page ? (
            <Page />
          ) : (
            <EmptyState title="Nothing here yet">
              This page isn&apos;t available. Use the menu below to find what you need.
            </EmptyState>
          )}
        </AppShell>
      </ToastProvider>
    </FeatureFlagsProvider>
  );
}
