import { useEffect, useState } from "react";

import { apiFetch } from "../api/client";
import { resolveRoute } from "../routes/registry";
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
  const Page = resolveRoute(path)?.route.component;

  return (
    <FeatureFlagsProvider flags={flags}>
      <ToastProvider>
        <AppShell path={path}>
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
