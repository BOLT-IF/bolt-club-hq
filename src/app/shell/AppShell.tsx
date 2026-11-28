import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { InstallPrompt } from "../components/install";
import { useClientOutdated } from "../lib/clientVersion";
import { goBack } from "../lib/navigate";
import { BottomNav } from "./BottomNav";
import { MoreSheet } from "./MoreSheet";
import boltMark from "./assets/bolt-mark.png";
import { PRIMARY_NAV } from "./navigation";

export interface AppShellProps {
  /** Current pathname. The Back control is hidden on the root. */
  readonly path: string;
  readonly children: ReactNode;
  readonly badges?: Readonly<Record<string, number>>;
  readonly isAdmin?: boolean;
  readonly isSignedIn?: boolean;
}

interface BackOverride {
  readonly path: string;
  readonly label: string;
  readonly fallback: string;
}

interface BackTargetContextValue {
  readonly currentPath: string;
  readonly setOverride: (next: BackOverride | null) => void;
}

const BackTargetContext = createContext<BackTargetContextValue>({
  currentPath: "",
  setOverride: () => undefined,
});

/** Lets a pushed route specify an exact parent title and fallback path in the AppShell top bar. */
export function useBackTarget(
  target: { readonly label: string; readonly fallback: string } | null,
) {
  const { currentPath, setOverride } = useContext(BackTargetContext);
  const label = target?.label ?? null;
  const fallback = target?.fallback ?? null;

  useEffect(() => {
    if (!label || !fallback) return;
    setOverride({ path: currentPath, label, fallback });
    return () => {
      setOverride(null);
    };
  }, [currentPath, label, fallback, setOverride]);
}

/** Primary bottom-nav root routes never render a top-bar Back button (PWA_UI_Rules.md §3). */
const ROOT_NAV_PATHS = new Set(PRIMARY_NAV.flatMap((item) => ("path" in item ? [item.path] : [])));

/** Determine contextual Back label and fallback target for the top bar. */
function backTargetFor(path: string): { readonly label: string; readonly fallback: string } {
  if (/^\/admin\/[^/]+$/.test(path)) {
    return { label: "Admin", fallback: "/admin" };
  }
  if (/^\/admin\/terms\/series\/[^/]+\/schedule$/.test(path)) {
    return { label: "Series", fallback: "/admin/terms" };
  }
  if (/^\/admin\/terms\/series\/[^/]+$/.test(path)) {
    return { label: "Term", fallback: "/admin/terms" };
  }
  if (path.startsWith("/admin/terms/")) {
    return { label: "Terms", fallback: "/admin/terms" };
  }
  if (path.startsWith("/admin/money/members/")) {
    return { label: "Balances", fallback: "/admin/money" };
  }
  if (path.startsWith("/admin/money/")) {
    return { label: "Finances", fallback: "/admin/money" };
  }
  if (path.startsWith("/admin/")) {
    return { label: "Admin", fallback: "/admin" };
  }
  if (path.startsWith("/money/")) {
    return { label: "Money", fallback: "/money" };
  }
  return { label: "Back", fallback: "/" };
}

/** Shell chrome: skip link, top bar with explicit Back, routed content, bottom nav, More sheet. */
export function AppShell({
  path,
  children,
  badges = {},
  isAdmin = false,
  isSignedIn = false,
}: AppShellProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [override, setOverride] = useState<BackOverride | null>(null);
  const outdated = useClientOutdated();
  const showBack = !ROOT_NAV_PATHS.has(path);
  const defaultTarget = backTargetFor(path);
  const backTarget =
    override && override.path === path
      ? { label: override.label, fallback: override.fallback }
      : defaultTarget;

  return (
    <BackTargetContext.Provider value={{ currentPath: path, setOverride }}>
      <div className="bcq-app" data-testid="app-shell">
        <a className="bcq-skip" href="#main">
          Skip to content
        </a>

        {outdated ? (
          <div className="bcq-banner" role="alert">
            <span>A newer version of BOLT HQ is ready.</span>
            <button
              type="button"
              className="bcq-banner__action"
              onClick={() => {
                window.location.reload();
              }}
            >
              Refresh
            </button>
          </div>
        ) : null}

        <header className="bcq-topbar">
          {showBack ? (
            <button
              type="button"
              className="bcq-back"
              onClick={() => {
                goBack(backTarget.fallback);
              }}
            >
              <svg
                aria-hidden="true"
                focusable="false"
                className="bcq-back__arrow"
                viewBox="0 0 24 24"
              >
                <path
                  d="M15 6l-6 6 6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="bcq-back__label">{backTarget.label}</span>
            </button>
          ) : null}
          <span className="bcq-brand">
            <img className="bcq-brand__mark" src={boltMark} alt="" width="28" height="27" />
            BOLT <span className="bcq-brand__hq">HQ</span>
          </span>
        </header>

        <main id="main" className="bcq-main" tabIndex={-1}>
          {path === "/install" ? null : <InstallPrompt />}
          {children}
        </main>

        <BottomNav
          items={PRIMARY_NAV}
          path={path}
          badges={badges}
          isAdmin={isAdmin}
          onMore={() => {
            setMoreOpen(true);
          }}
        />

        <MoreSheet
          open={moreOpen}
          isAdmin={isAdmin}
          isSignedIn={isSignedIn}
          onClose={() => {
            setMoreOpen(false);
          }}
        />
      </div>
    </BackTargetContext.Provider>
  );
}
