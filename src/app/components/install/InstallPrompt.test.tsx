import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallGuide } from "./InstallGuide";
import { InstallPrompt } from "./InstallPrompt";
import { noteRsvpSaved } from "./state";
import type { InstallContext } from "./platform";
import type { PushPort } from "./pushPort";

/** Map-backed Storage: Node's experimental global localStorage can shadow jsdom's. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function fakePush(
  initial: NotificationPermission | null,
  answer: NotificationPermission = "granted",
) {
  let permission = initial;
  const port: PushPort & {
    request: ReturnType<typeof vi.fn>;
    resubscribe: ReturnType<typeof vi.fn>;
  } = {
    permission: () => permission,
    request: vi.fn(() => {
      permission = answer;
      return Promise.resolve(answer);
    }),
    resubscribe: vi.fn(() => Promise.resolve()),
  };
  return port;
}

const IOS: InstallContext = { platform: "ios", standalone: false };
const IOS_APP: InstallContext = { platform: "ios", standalone: true };
const ANDROID: InstallContext = { platform: "android", standalone: false };
const DESKTOP: InstallContext = { platform: "desktop", standalone: false };

async function expectAxeClean(container: HTMLElement) {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("InstallPrompt", () => {
  it("first load: never requests push permission, and shows no push card", async () => {
    const push = fakePush("default");
    render(<InstallPrompt context={DESKTOP} push={push} />);
    await Promise.resolve();
    expect(push.request).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
  });

  it("iOS Safari: shows Add to Home Screen instructions, no push", async () => {
    const push = fakePush(null);
    const { container } = render(<InstallPrompt context={IOS} push={push} />);
    expect(screen.getByRole("heading", { name: /add bolt hq to your home screen/i })).toBeTruthy();
    expect(screen.getByText(/add to home screen/i, { selector: "strong" })).toBeTruthy();
    await expectAxeClean(container);
  });

  it("Android Chrome: the Install button uses the browser's install prompt", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    render(<InstallPrompt context={ANDROID} push={fakePush("default")} />);
    act(() => {
      window.dispatchEvent(event);
    });
    fireEvent.click(await screen.findByRole("button", { name: /^install$/i }));
    expect(prompt).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
    });
  });

  it("Android without an install event: shows the browser-menu instructions", () => {
    render(<InstallPrompt context={ANDROID} push={fakePush("default")} />);
    expect(screen.getByText(/install app/i, { selector: "strong" })).toBeTruthy();
  });

  it("dismissing the install card keeps it dismissed", () => {
    const first = render(<InstallPrompt context={IOS} push={fakePush(null)} />);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByRole("heading", { name: /home screen/i })).toBeNull();
    first.unmount();
    render(<InstallPrompt context={IOS} push={fakePush(null)} />);
    expect(screen.queryByRole("heading", { name: /home screen/i })).toBeNull();
  });

  it("desktop and the installed iOS app show nothing before the first RSVP", () => {
    const { container: a } = render(<InstallPrompt context={DESKTOP} push={fakePush("default")} />);
    expect(a.textContent).toBe("");
    cleanup();
    const { container: b } = render(<InstallPrompt context={IOS_APP} push={fakePush("default")} />);
    expect(b.textContent).toBe("");
  });

  it("after the first RSVP: offers push and asks only when the member taps", async () => {
    const push = fakePush("default");
    const { container } = render(<InstallPrompt context={IOS_APP} push={push} />);
    act(() => {
      noteRsvpSaved();
    });
    const button = await screen.findByRole("button", { name: /turn on notifications/i });
    expect(push.request).not.toHaveBeenCalled();
    await expectAxeClean(container);
    fireEvent.click(button);
    await waitFor(() => {
      expect(push.request).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(push.resubscribe).toHaveBeenCalled();
    });
    expect(await screen.findByText(/notifications are on/i)).toBeTruthy();
  });

  it("no re-ask after the member taps Not now", () => {
    noteRsvpSaved();
    const push = fakePush("default");
    const first = render(<InstallPrompt context={DESKTOP} push={push} />);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
    first.unmount();
    noteRsvpSaved();
    render(<InstallPrompt context={DESKTOP} push={push} />);
    expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
    expect(push.request).not.toHaveBeenCalled();
  });

  it("no re-ask after the browser prompt is declined", async () => {
    noteRsvpSaved();
    const push = fakePush("default", "default"); // closed the browser prompt without choosing
    const first = render(<InstallPrompt context={DESKTOP} push={push} />);
    fireEvent.click(screen.getByRole("button", { name: /turn on notifications/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
    });
    first.unmount();
    render(<InstallPrompt context={DESKTOP} push={push} />);
    expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
    expect(push.request).toHaveBeenCalledOnce();
  });

  it("re-subscribes on every open when permission is already granted, without asking", async () => {
    const push = fakePush("granted");
    const { container } = render(<InstallPrompt context={IOS_APP} push={push} />);
    await waitFor(() => {
      expect(push.resubscribe).toHaveBeenCalledOnce();
    });
    expect(push.request).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});

describe("InstallGuide (/install)", () => {
  it("shows the current device's steps and is axe-clean", async () => {
    const { container } = render(<InstallGuide context={IOS} push={fakePush(null)} />);
    expect(screen.getByRole("heading", { level: 1, name: /install the app/i })).toBeTruthy();
    expect(screen.getByText(/ios 16\.4/i)).toBeTruthy();
    await expectAxeClean(container);
  });

  it("says so when already installed", () => {
    render(<InstallGuide context={IOS_APP} push={fakePush("granted")} />);
    expect(screen.getByText(/using the installed app/i)).toBeTruthy();
    expect(screen.getByText(/notifications are on for this device/i)).toBeTruthy();
  });

  it("lets the member turn notifications on themselves, even after Not now", async () => {
    window.localStorage.setItem("bcq.push.declined", "1");
    const push = fakePush("default");
    render(<InstallGuide context={DESKTOP} push={push} />);
    expect(push.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /turn on notifications/i }));
    await waitFor(() => {
      expect(push.request).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText(/notifications are on for this device/i)).toBeTruthy();
  });

  it("explains how to unblock when the browser has blocked notifications", () => {
    render(<InstallGuide context={DESKTOP} push={fakePush("denied")} />);
    expect(screen.getByText(/blocked/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn on notifications/i })).toBeNull();
  });
});
