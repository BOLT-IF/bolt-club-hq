import { useEffect } from "react";
import { SignIn, useAuth } from "@clerk/react";

import { useAuthEnabled } from "../../auth/AuthProvider";
import { detectClient, shouldShowGoogle } from "../../auth/google";
import { peekIntent, safeReturnTo } from "../../auth/intent";
import { EmptyState } from "../../components/ui/States";
import { navigate } from "../../lib/navigate";
import "../../auth/auth.css";

function returnTarget(): string {
  const param = new URLSearchParams(window.location.search).get("return_to");
  return param ? safeReturnTo(param) : (peekIntent()?.returnTo ?? "/");
}

function SignInForm() {
  const { isLoaded, isSignedIn } = useAuth();
  const returnTo = returnTarget();

  useEffect(() => {
    if (isLoaded && isSignedIn) navigate(returnTo);
  }, [isLoaded, isSignedIn, returnTo]);

  // Email code leads. Google sits below it, or is hidden in the installed iOS app
  // (provisional until the S0.6 device spike; see ../../auth/google.ts).
  const showGoogle = shouldShowGoogle(detectClient());
  const hidden = { display: "none" } as const;
  return (
    <main className="bcq-auth">
      <SignIn
        routing="hash"
        forceRedirectUrl={returnTo}
        appearance={{
          layout: { socialButtonsPlacement: "bottom" },
          ...(showGoogle ? {} : { elements: { socialButtonsRoot: hidden, dividerRow: hidden } }),
        }}
      />
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
