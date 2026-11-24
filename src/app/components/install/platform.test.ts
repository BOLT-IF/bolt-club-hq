import { describe, expect, it } from "vitest";

import {
  decidePrompt,
  detectInstallContext,
  type InstallContext,
  type PromptState,
} from "./platform";

const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  ipadOs:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
};

function win(
  ua: string,
  opts: { touch?: number; standalone?: boolean; displayMode?: boolean } = {},
) {
  return {
    navigator: {
      userAgent: ua,
      maxTouchPoints: opts.touch ?? 0,
      ...(opts.standalone === undefined ? {} : { standalone: opts.standalone }),
    },
    matchMedia: () => ({ matches: opts.displayMode ?? false }),
  } as unknown as Pick<Window, "navigator" | "matchMedia">;
}

describe("detectInstallContext: user-agent matrix", () => {
  it.each<[string, Pick<Window, "navigator" | "matchMedia">, InstallContext]>([
    [
      "iOS Safari",
      win(UA.iosSafari, { touch: 5, standalone: false }),
      { platform: "ios", standalone: false },
    ],
    [
      "iOS installed",
      win(UA.iosSafari, { touch: 5, standalone: true }),
      { platform: "ios", standalone: true },
    ],
    ["iOS Chrome", win(UA.iosChrome, { touch: 5 }), { platform: "ios", standalone: false }],
    [
      "iPadOS (Mac UA, touch)",
      win(UA.ipadOs, { touch: 5 }),
      { platform: "ios", standalone: false },
    ],
    [
      "Android Chrome",
      win(UA.androidChrome, { touch: 5 }),
      { platform: "android", standalone: false },
    ],
    [
      "Android installed",
      win(UA.androidChrome, { touch: 5, displayMode: true }),
      { platform: "android", standalone: true },
    ],
    ["desktop Chrome (Mac)", win(UA.macChrome), { platform: "desktop", standalone: false }],
    ["desktop Edge (Windows)", win(UA.windowsEdge), { platform: "desktop", standalone: false }],
    [
      "desktop installed",
      win(UA.windowsEdge, { displayMode: true }),
      { platform: "desktop", standalone: true },
    ],
  ])("%s", (_name, w, expected) => {
    expect(detectInstallContext(w)).toEqual(expected);
  });
});

const fresh: PromptState = {
  pushPermission: "default",
  rsvped: false,
  pushDeclined: false,
  installDismissed: false,
};

describe("decidePrompt", () => {
  const ios = { platform: "ios", standalone: false } as const;
  const iosInstalled = { platform: "ios", standalone: true } as const;
  const android = { platform: "android", standalone: false } as const;
  const desktop = { platform: "desktop", standalone: false } as const;

  it("shows the matching install card on mobile browsers, nothing on desktop, on first load", () => {
    expect(decidePrompt(ios, { ...fresh, pushPermission: null })).toBe("install-ios");
    expect(decidePrompt(android, fresh)).toBe("install-android");
    expect(decidePrompt(desktop, fresh)).toBeNull();
    expect(decidePrompt(iosInstalled, fresh)).toBeNull();
  });

  it("never offers push before the first RSVP", () => {
    for (const ctx of [iosInstalled, desktop, { platform: "android", standalone: true } as const]) {
      expect(decidePrompt(ctx, fresh)).toBeNull();
    }
  });

  it("offers push after the first RSVP when the browser can still ask", () => {
    expect(decidePrompt(iosInstalled, { ...fresh, rsvped: true })).toBe("push");
    expect(decidePrompt(desktop, { ...fresh, rsvped: true })).toBe("push");
  });

  it("never re-offers push after a decline, a block, or when it is unsupported or on", () => {
    const rsvped = { ...fresh, rsvped: true };
    expect(decidePrompt(desktop, { ...rsvped, pushDeclined: true })).toBeNull();
    expect(decidePrompt(desktop, { ...rsvped, pushPermission: "denied" })).toBeNull();
    expect(decidePrompt(desktop, { ...rsvped, pushPermission: "granted" })).toBeNull();
    expect(decidePrompt(desktop, { ...rsvped, pushPermission: null })).toBeNull();
  });

  it("iOS Safari never gets push (Safari tabs cannot receive it); install comes first", () => {
    expect(decidePrompt(ios, { ...fresh, pushPermission: null, rsvped: true })).toBe("install-ios");
    expect(
      decidePrompt(ios, { ...fresh, pushPermission: null, rsvped: true, installDismissed: true }),
    ).toBeNull();
  });

  it("a dismissed install card stays dismissed; push can follow on Android", () => {
    expect(decidePrompt(android, { ...fresh, installDismissed: true })).toBeNull();
    expect(decidePrompt(android, { ...fresh, installDismissed: true, rsvped: true })).toBe("push");
  });
});
