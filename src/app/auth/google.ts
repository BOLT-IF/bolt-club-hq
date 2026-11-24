/**
 * Google sign-in visibility. PROVISIONAL: the S0.6 device spike has not run, so we do not
 * know whether Clerk's Google flow works inside the installed iOS app (WhatsApp opens links
 * in Safari, which has a separate login from the installed app). Until S0.6 says otherwise,
 * Google is hidden there and the screen leads with email code. This is the one place to
 * change: set it to false to show Google everywhere. See docs/DECISIONS.md (S1.1).
 */
export const GOOGLE_HIDDEN_IN_INSTALLED_IOS = true;

export interface ClientKind {
  readonly ios: boolean;
  /** Running as an installed app (home-screen icon), not a browser tab. */
  readonly standalone: boolean;
}

export function shouldShowGoogle(
  client: ClientKind,
  hiddenInInstalledIos: boolean = GOOGLE_HIDDEN_IN_INSTALLED_IOS,
): boolean {
  return !(hiddenInInstalledIos && client.ios && client.standalone);
}

export function detectClient(win: Pick<Window, "navigator" | "matchMedia"> = window): ClientKind {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  // iPadOS reports a Mac user agent, so it is told apart by touch support.
  const ios =
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  const displayModeStandalone =
    typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches;
  return { ios, standalone: nav.standalone === true || displayModeStandalone };
}
