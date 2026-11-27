import { useEffect, useState } from "react";
import { SignIn, useAuth } from "@clerk/react";

import { useAuthEnabled } from "../../auth/AuthProvider";
import { detectClient, shouldShowGoogle } from "../../auth/google";
import { peekIntent, safeReturnTo } from "../../auth/intent";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/States";
import { navigate } from "../../lib/navigate";
import "../../auth/auth.css";

const SIGNIN_LOAD_TIMEOUT_MS = 8000;
const BOUNCE_KEY = "bcq.signin-bounce";
const BOUNCE_WINDOW_MS = 10_000;

function wasRecentBounce(target: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(BOUNCE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { at?: unknown; to?: unknown };
    return (
      typeof parsed.at === "number" &&
      parsed.to === target &&
      Date.now() - parsed.at < BOUNCE_WINDOW_MS
    );
  } catch {
    return false;
  }
}

function recordBounce(target: string): void {
  try {
    window.sessionStorage.setItem(BOUNCE_KEY, JSON.stringify({ at: Date.now(), to: target }));
  } catch {
    // Storage blocked (private mode); skip recording.
  }
}

function returnTarget(): string {
  const param = new URLSearchParams(window.location.search).get("return_to");
  return param ? safeReturnTo(param) : (peekIntent()?.returnTo ?? "/");
}

function SignInForm() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [timedOut, setTimedOut] = useState(false);
  const [tokenFailed, setTokenFailed] = useState(false);
  const returnTo = returnTarget();
  const [bounced] = useState(() => wasRecentBounce(returnTo));
  const sessionError = tokenFailed || (isLoaded && isSignedIn && bounced);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || bounced) return;
    let cancelled = false;
    void Promise.resolve(getToken())
      .catch(() => null)
      .then((token) => {
        if (cancelled) return;
        if (!token) {
          setTokenFailed(true);
          return;
        }
        recordBounce(returnTo);
        navigate(returnTo);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken, returnTo, bounced]);

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
      {sessionError ? (
        <ErrorState
          title="Your session couldn't be verified"
          onRetry={() => {
            window.location.reload();
          }}
        >
          Please sign out and sign in again to refresh your session.{" "}
          <Button
            variant="secondary"
            onClick={() => {
              navigate("/sign-out");
            }}
          >
            Sign out
          </Button>
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
