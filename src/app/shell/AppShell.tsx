import { useState, type ReactNode } from "react";

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
}

/** Shell chrome: skip link, top bar with explicit Back, routed content, bottom nav, More sheet. */
export function AppShell({ path, children, badges = {}, isAdmin = false }: AppShellProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const outdated = useClientOutdated();
  const showBack = path !== "/";

  return (
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
              goBack();
            }}
          >
            <span aria-hidden="true" className="bcq-back__arrow">
              ←
            </span>
            Back
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
        onClose={() => {
          setMoreOpen(false);
        }}
      />
    </div>
  );
}
