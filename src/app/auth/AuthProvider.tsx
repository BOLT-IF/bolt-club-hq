import { createContext, useContext, useEffect, type ReactNode } from "react";
import { ClerkProvider, getToken as clerkGetToken, useAuth } from "@clerk/react";

import { configureApiClient } from "../api/client";

const AuthEnabledContext = createContext(false);

/** Bound how long API calls wait for Clerk JS to load (e.g. slow/blocked iOS PWA). */
const TOKEN_TIMEOUT_MS = 2500;

/** Whether Clerk is configured. False in dev, CI and e2e builds without the key. */
export function useAuthEnabled(): boolean {
  return useContext(AuthEnabledContext);
}

/** The Clerk publishable key is `pk_test_…` or `pk_live_…`; anything else counts as unset. */
export function validPublishableKey(key: string | undefined): string | null {
  const trimmed = key?.trim();
  return trimmed && /^pk_(test|live)_/.test(trimmed) ? trimmed : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function ClerkApiBridge() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  useEffect(() => {
    configureApiClient({
      getToken: () => {
        if (isLoaded && !isSignedIn) return Promise.resolve(null);
        const raw = isLoaded ? getToken() : clerkGetToken();
        return withTimeout(raw, TOKEN_TIMEOUT_MS, null);
      },
    });
    return () => {
      configureApiClient({});
    };
  }, [isLoaded, isSignedIn, getToken]);
  return null;
}

/**
 * Wraps the app in Clerk and points `apiFetch` at the Clerk session token. The key comes
 * from `VITE_CLERK_PUBLISHABLE_KEY` at build time. Without a valid key nothing Clerk runs
 * and the app boots as signed out, so dev, CI and e2e builds never crash.
 */
export function AuthProvider({
  children,
  publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
}: {
  readonly children: ReactNode;
  readonly publishableKey?: string | undefined;
}) {
  const key = validPublishableKey(publishableKey);
  if (!key) {
    return <AuthEnabledContext.Provider value={false}>{children}</AuthEnabledContext.Provider>;
  }
  return (
    <ClerkProvider publishableKey={key} afterSignOutUrl="/">
      <AuthEnabledContext.Provider value={true}>
        <ClerkApiBridge />
        {children}
      </AuthEnabledContext.Provider>
    </ClerkProvider>
  );
}
