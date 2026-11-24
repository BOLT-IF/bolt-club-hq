import { useEffect, useState } from "react";
import { useClerk } from "@clerk/react";

import { logout } from "../../auth/logout";
import { useAuthEnabled } from "../../auth/AuthProvider";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/States";
import { navigate } from "../../lib/navigate";
import { clearAppCaches } from "../../../sw/client";

async function clearCachesSafely(): Promise<void> {
  // No service worker support (or none registered yet): nothing to clear.
  if (!("serviceWorker" in navigator) && !("caches" in window)) return;
  await clearAppCaches();
}

function SigningOut() {
  const clerk = useClerk();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    logout({
      signOut: () => clerk.signOut(),
      clearCaches: clearCachesSafely,
      navigate,
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [clerk]);

  return failed ? (
    <ErrorState title="Couldn't sign you out">
      Check your connection and try again. Saved data on this phone has been cleared.
    </ErrorState>
  ) : (
    <Skeleton lines={1} label="Signing out" />
  );
}

export function SignOutPage() {
  if (!useAuthEnabled()) return <EmptyState title="You're not signed in" />;
  return <SigningOut />;
}
