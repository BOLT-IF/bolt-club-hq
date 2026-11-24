import { createContext, useContext, useEffect, type ReactNode } from "react";
import { ClerkProvider, getToken } from "@clerk/react";

import { configureApiClient } from "../api/client";

const AuthEnabledContext = createContext(false);

/** Whether Clerk is configured. False in dev, CI and e2e builds without the key. */
export function useAuthEnabled(): boolean {
  return useContext(AuthEnabledContext);
}

/** The Clerk publishable key is `pk_test_…` or `pk_live_…`; anything else counts as unset. */
export function validPublishableKey(key: string | undefined): string | null {
  const trimmed = key?.trim();
  return trimmed && /^pk_(test|live)_/.test(trimmed) ? trimmed : null;
}

function ClerkApiBridge() {
  useEffect(() => {
    configureApiClient({
      // Clerk throws while offline or if its script fails to load. The API call then goes
      // out without a token and the server answers 401, which is the honest result.
      getToken: () => getToken().catch(() => null),
    });
    return () => {
      configureApiClient({});
    };
  }, []);
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
