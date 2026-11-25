import { useEffect, useState } from "react";
import { SignIn, useAuth } from "@clerk/react";

import { useAuthEnabled } from "../../auth/AuthProvider";
import { detectClient, shouldShowGoogle } from "../../auth/google";
import { peekIntent, safeReturnTo } from "../../auth/intent";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/States";
import { navigate } from "../../lib/navigate";
import "../../auth/auth.css";

const SIGNIN_LOAD_TIMEOUT_MS = 8000;

function returnTarget(): string {
  const param = new URLSearchParams(window.location.search).get("return_to");
  return param ? safeReturnTo(param) : (peekIntent()?.returnTo ?? "/");
}

function SignInForm() {
  const { isLoaded, isSignedIn } = useAuth();
  const [timedOut, setTimedOut] = useState(false);
  const returnTo = returnTarget();

  useEffect(() => {
    if (isLoaded && isSignedIn) navigate(returnTo);
  }, [isLoaded, isSignedIn, returnTo]);

  useEffect(() => {
    if (isLoaded) return;
    const timer = setTimeout(() => {
      setTimedOut(true);
    }, SIGNIN_LOAD_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isLoaded]);

  // Email code leads. Google sits below it, or is hidden in the installed iOS app
  // (provisional until the S0.6 device spike; see ../../auth/google.ts).
  const showGoogle = shouldShowGoogle(detectClient());
  const hidden = { display: "none" } as const;
  return (
    <main className="bcq-auth">
      {!isLoaded && !timedOut ? <Skeleton lines={4} label="Loading sign-in" /> : null}
      {!isLoaded && timedOut ? (
        <ErrorState
          title="Sign-in couldn't load"
          onRetry={() => {
            window.location.reload();
          }}
        >
          Make sure you are opening BOLT HQ on its club domain and check your connection or content
          blockers, then try again.
        </ErrorState>
      ) : null}
      <SignIn
        routing="hash"
        forceRedirectUrl={returnTo}
        appearance={{
          options: { socialButtonsPlacement: "bottom" },
          ...(showGoogle ? {} : { elements: { socialButtonsRoot: hidden, dividerRow: hidden } }),
        }}
      />
      <p className="bcq-auth__privacy">
        <a
          href="/privacy"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate("/privacy");
          }}
        >
          Privacy policy
        </a>
      </p>
    </main>
  );
}

export function SignInPage() {
  if (!useAuthEnabled()) {
    return (
      <EmptyState title="Sign-in isn't set up here">
        This build has no sign-in configured, so you are browsing as a visitor.
      </EmptyState>
    );
  }
  return <SignInForm />;
}
