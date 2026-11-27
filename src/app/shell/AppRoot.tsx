import { useEffect, useState } from "react";

import { apiFetch } from "../api/client";
import { fetchNotifications } from "../api/notifications";
import { resolveRoute } from "../routes/registry";
import { completeJoinRsvpIntent, peekJoinRsvpIntent } from "../routes/join/joinIntent";
import { EmptyState, Skeleton } from "../components/ui/States";
import { ToastProvider } from "../components/ui/Toast";
import { FeatureFlagsProvider, type FeatureFlags } from "../lib/flags";
import { useCurrentPath } from "../lib/navigate";
import { AdminIndex } from "./AdminIndex";
import { AppShell } from "./AppShell";
import "../components/ui/ui.css";
import "./shell.css";

interface ConfigResponse {
  readonly flags?: FeatureFlags;
}

const FLAGS_CACHE_KEY = "bcq:flags";

function readCachedFlags(): { readonly flags: FeatureFlags; readonly cached: boolean } {
  try {
    const raw = window.localStorage.getItem(FLAGS_CACHE_KEY);
    if (!raw) return { flags: {}, cached: false };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { flags: {}, cached: false };
    }
    const flags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") flags[k] = v;
    }
    return { flags, cached: true };
  } catch {
    return { flags: {}, cached: false };
  }
}

function writeCachedFlags(flags: FeatureFlags): void {
  try {
    window.localStorage.setItem(FLAGS_CACHE_KEY, JSON.stringify(flags));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

/** Loads /api/v1/config, seeding from cached flags to prevent bottom-nav pop-in on reload. */
function useFlags(): { readonly flags: FeatureFlags; readonly loaded: boolean } {
  const [state, setState] = useState<{ flags: FeatureFlags; loaded: boolean }>(() => {
    const { flags, cached } = readCachedFlags();
    return { flags, loaded: cached };
  });
  useEffect(() => {
    let cancelled = false;
    apiFetch<ConfigResponse>("/config", { skipAuth: true })
      .then((config) => {
        const nextFlags = config.flags ?? {};
        writeCachedFlags(nextFlags);
        if (!cancelled) setState({ flags: nextFlags, loaded: true });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ flags: prev.flags, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function AppRoot() {
  const path = useCurrentPath();
  const { flags, loaded: flagsLoaded } = useFlags();
  const [inboxUnread, setInboxUnread] = useState(0);
  const [viewer, setViewer] = useState<{
    isAdmin: boolean;
    isSignedIn: boolean;
    loaded: boolean;
  }>({
    isAdmin: false,
    isSignedIn: false,
    loaded: false,
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
            loaded: true,
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewer({ isAdmin: false, isSignedIn: false, loaded: true });
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
    <FeatureFlagsProvider flags={flags} loaded={flagsLoaded}>
      <ToastProvider>
        <AppShell
          path={path}
          badges={badges}
          isAdmin={viewer.isAdmin}
          isSignedIn={viewer.isSignedIn}
        >
          {Page ? (
            <Page />
          ) : path === "/admin" ? (
            viewer.loaded ? (
              <AdminIndex isAdmin={viewer.isAdmin} />
            ) : (
              <Skeleton label="Loading admin" />
            )
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
