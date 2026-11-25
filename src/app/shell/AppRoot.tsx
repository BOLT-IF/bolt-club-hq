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
    apiFetch<ConfigResponse>("/config", { skipAuth: true })
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
  const [viewer, setViewer] = useState<{ isAdmin: boolean; isSignedIn: boolean }>({
    isAdmin: false,
    isSignedIn: false,
  });
  const Page = resolveRoute(path)?.route.component;

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ role?: string; status?: string }>("/me", {
      signal: controller.signal,
      redirectOnUnauthorized: false,
    })
      .then((me) => {
        if (!controller.signal.aborted) {
          setViewer({
            isAdmin: me.role === "admin" && me.status === "active",
            isSignedIn: true,
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewer({ isAdmin: false, isSignedIn: false });
        }
      });
    return () => {
      controller.abort();
    };
  }, [path]);

  useEffect(() => {
    if (peekJoinRsvpIntent()) {
      void completeJoinRsvpIntent();
    }
  }, []);

  useEffect(() => {
    if (flags.inbox !== true || !viewer.isSignedIn) return;
    const controller = new AbortController();
    fetchNotifications(controller.signal, { redirectOnUnauthorized: false })
      .then((page) => {
        if (!controller.signal.aborted) setInboxUnread(page.unreadCount);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [flags.inbox, path, viewer.isSignedIn]);

  const badges = flags.inbox === true && inboxUnread > 0 ? { inbox: inboxUnread } : {};

  return (
    <FeatureFlagsProvider flags={flags}>
      <ToastProvider>
        <AppShell
          path={path}
          badges={badges}
          isAdmin={viewer.isAdmin}
          isSignedIn={viewer.isSignedIn}
        >
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
