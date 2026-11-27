import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
  getToken: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
}));
const captured = vi.hoisted(() => ({ signIn: null as null | Record<string, unknown> }));
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getToken: () => authState.getToken(),
  useAuth: () => authState,
  SignIn: (props: Record<string, unknown>) => {
    captured.signIn = props;
    return <div data-testid="clerk-sign-in" />;
  },
}));

import { AuthProvider } from "../../auth/AuthProvider";
import { registeredFrontendRoutes } from "../registry";
import { SignInPage } from "./SignInPage";

function elementsOf(props: Record<string, unknown> | null): Record<string, unknown> {
  const appearance = props?.appearance as { elements?: Record<string, unknown> } | undefined;
  return appearance?.elements ?? {};
}

function setClient({ ios, standalone }: { ios: boolean; standalone: boolean }) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" : "Mozilla/5.0 (Macintosh)",
    configurable: true,
  });
  Object.defineProperty(window.navigator, "standalone", { value: standalone, configurable: true });
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  captured.signIn = null;
  authState.isLoaded = true;
  authState.isSignedIn = false;
  authState.getToken.mockReset();
  authState.getToken.mockResolvedValue(null);
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/sign-in");
  setClient({ ios: false, standalone: false });
});
afterEach(cleanup);

describe("auth routes", () => {
  it("registers /sign-in and /sign-out", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/sign-in");
    expect(paths).toContain("/sign-out");
  });
});

describe("SignInPage", () => {
  it("explains that sign-in is off when Clerk is not configured, instead of crashing", () => {
    render(
      <AuthProvider publishableKey={undefined}>
        <SignInPage />
      </AuthProvider>,
    );
    expect(screen.getByText(/sign-in isn.t set up/i)).toBeTruthy();
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
  });

  it("sends the user back to return_to after sign-in", () => {
    window.history.pushState({}, "", "/sign-in?return_to=%2Fevents%2Fmon-3");
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId("clerk-sign-in")).toBeTruthy();
    expect(screen.getByRole("link", { name: /privacy/i }).getAttribute("href")).toBe("/privacy");
    expect(captured.signIn).toMatchObject({ forceRedirectUrl: "/events/mon-3" });
  });

  it("refuses an off-site return_to", () => {
    window.history.pushState({}, "", "/sign-in?return_to=https%3A%2F%2Fevil.example");
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );
    expect(captured.signIn).toMatchObject({ forceRedirectUrl: "/" });
  });

  it("leads with the email form and offers Google below it in a browser", () => {
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );
    const appearance = captured.signIn?.appearance as {
      options?: { socialButtonsPlacement?: string };
    };
    expect(appearance.options?.socialButtonsPlacement).toBe("bottom");
    expect(elementsOf(captured.signIn).socialButtonsRoot).toBeUndefined();
  });

  it("shows Google in the installed iOS app as well", () => {
    setClient({ ios: true, standalone: true });
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );
    const elements = elementsOf(captured.signIn);
    expect(elements.socialButtonsRoot).toBeUndefined();
    expect(elements.dividerRow).toBeUndefined();
  });

  it("does not redirect back to return_to when Clerk reports signed in but getToken returns null", async () => {
    authState.isSignedIn = true;
    authState.getToken.mockResolvedValue(null);
    window.history.pushState({}, "", "/sign-in?return_to=%2F");

    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("redirects to return_to when signed in with a valid token, but stops if it bounces back immediately", async () => {
    authState.isSignedIn = true;
    authState.getToken.mockResolvedValue("tok_valid");
    window.history.pushState({}, "", "/sign-in?return_to=%2F");

    const first = render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    first.unmount();

    // Simulate / immediately bouncing back to /sign-in on 401.
    window.history.pushState({}, "", "/sign-in?return_to=%2F");
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <SignInPage />
      </AuthProvider>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(window.location.pathname).toBe("/sign-in");
  });
});
