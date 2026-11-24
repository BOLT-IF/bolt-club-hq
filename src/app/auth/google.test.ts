import { describe, expect, it } from "vitest";

import { GOOGLE_HIDDEN_IN_INSTALLED_IOS, detectClient, shouldShowGoogle } from "./google";

describe("Google sign-in visibility (provisional rule, S0.6 not run yet)", () => {
  it("is a single constant, on by default: hide Google in the installed iOS app", () => {
    expect(GOOGLE_HIDDEN_IN_INSTALLED_IOS).toBe(true);
  });

  it("hides Google only in the installed iOS app", () => {
    expect(shouldShowGoogle({ ios: true, standalone: true })).toBe(false);
    expect(shouldShowGoogle({ ios: true, standalone: false })).toBe(true); // Safari
    expect(shouldShowGoogle({ ios: false, standalone: true })).toBe(true); // Android PWA
    expect(shouldShowGoogle({ ios: false, standalone: false })).toBe(true); // desktop
  });

  it("shows Google everywhere once the rule is switched off", () => {
    expect(shouldShowGoogle({ ios: true, standalone: true }, false)).toBe(true);
  });
});

describe("detectClient", () => {
  const win = (ua: string, extra: Record<string, unknown> = {}, standaloneMedia = false) =>
    ({
      navigator: { userAgent: ua, platform: "", maxTouchPoints: 0, ...extra },
      matchMedia: () => ({ matches: standaloneMedia }),
    }) as unknown as Pick<Window, "navigator" | "matchMedia">;

  it("sees an iPhone home-screen app through navigator.standalone", () => {
    expect(detectClient(win("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", { standalone: true }))).toEqual({
      ios: true,
      standalone: true,
    });
  });

  it("sees iPadOS, which reports a Mac user agent, by touch support", () => {
    const ipad = win("Mozilla/5.0 (Macintosh)", { platform: "MacIntel", maxTouchPoints: 5 });
    expect(detectClient(ipad).ios).toBe(true);
  });

  it("treats a display-mode: standalone Android app as standalone, not iOS", () => {
    expect(detectClient(win("Mozilla/5.0 (Linux; Android 15)", {}, true))).toEqual({
      ios: false,
      standalone: true,
    });
  });

  it("sees a desktop browser tab", () => {
    expect(detectClient(win("Mozilla/5.0 (Macintosh; Intel Mac OS X)"))).toEqual({
      ios: false,
      standalone: false,
    });
  });
});
