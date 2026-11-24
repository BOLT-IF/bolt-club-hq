import { describe, expect, it, vi } from "vitest";

import { logout } from "./logout";

describe("logout", () => {
  it("signs out, clears the service-worker caches, then goes home, in that order", async () => {
    const order: string[] = [];
    await logout({
      signOut: () => {
        order.push("signOut");
        return Promise.resolve();
      },
      clearCaches: () => {
        order.push("clearCaches");
        return Promise.resolve();
      },
      navigate: (path) => {
        order.push(`navigate:${path}`);
      },
    });
    expect(order).toEqual(["signOut", "clearCaches", "navigate:/"]);
  });

  it("still clears caches when sign-out fails, and reports the failure", async () => {
    const clearCaches = vi.fn(() => Promise.resolve());
    await expect(
      logout({
        signOut: () => Promise.reject(new Error("offline")),
        clearCaches,
        navigate: vi.fn(),
      }),
    ).rejects.toThrow("offline");
    expect(clearCaches).toHaveBeenCalledOnce();
  });
});
