/** Which install/push prompt a device gets (S10.2). Pure; browser state is passed in. */

export type InstallPlatform = "ios" | "android" | "desktop";

export interface InstallContext {
  readonly platform: InstallPlatform;
  /** Running as the installed app (home-screen icon), not a browser tab. */
  readonly standalone: boolean;
}

export type PromptKind = "install-ios" | "install-android" | "push";

export interface PromptState {
  /** null when this browser cannot do web push (e.g. a Safari tab on iOS). */
  readonly pushPermission: NotificationPermission | null;
  /** The member has saved an RSVP (PLAN §10: ask only after the first RSVP). */
  readonly rsvped: boolean;
  /** The member tapped Not now on the push card, or dismissed the browser prompt. */
  readonly pushDeclined: boolean;
  readonly installDismissed: boolean;
}

export function detectInstallContext(
  win: Pick<Window, "navigator" | "matchMedia"> = window,
): InstallContext {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ua = nav.userAgent;
  // iPadOS reports a Mac user agent, so it is told apart by touch support.
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  const platform: InstallPlatform = ios ? "ios" : /Android/.test(ua) ? "android" : "desktop";
  const displayMode =
    typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches;
  return { platform, standalone: nav.standalone === true || displayMode };
}

export function decidePrompt(ctx: InstallContext, state: PromptState): PromptKind | null {
  if (!ctx.standalone && !state.installDismissed) {
    if (ctx.platform === "ios") return "install-ios";
    if (ctx.platform === "android") return "install-android";
  }
  if (state.rsvped && !state.pushDeclined && state.pushPermission === "default") return "push";
  return null;
}
