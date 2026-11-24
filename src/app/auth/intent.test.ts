import { beforeEach, describe, expect, it } from "vitest";

import { INTENT_TTL_MS, peekIntent, safeReturnTo, saveIntent, takeIntent } from "./intent";

const T0 = 1_800_000_000_000;

/** Map-backed Storage: Node's experimental global localStorage can shadow jsdom's. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("RSVP intent (stored before sign-in, restored after)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  });

  it("survives the sign-in round trip, including a full page reload in between", () => {
    saveIntent({ returnTo: "/events/mon-3", rsvp: { eventSlug: "mon-3", response: "in" } }, T0);
    // The reload is simulated by reading only from storage, with no module state involved.
    expect(peekIntent(T0 + 5 * 60_000)).toEqual({
      returnTo: "/events/mon-3",
      rsvp: { eventSlug: "mon-3", response: "in" },
    });
  });

  it("is consumed once by takeIntent, so a refresh never replays an RSVP", () => {
    saveIntent({ returnTo: "/events/mon-3", rsvp: { eventSlug: "mon-3", response: "in" } }, T0);
    expect(takeIntent(T0 + 1000)?.rsvp?.eventSlug).toBe("mon-3");
    expect(takeIntent(T0 + 2000)).toBeNull();
    expect(peekIntent(T0 + 2000)).toBeNull();
  });

  it("expires, so a stale tap from last week never fires", () => {
    saveIntent({ returnTo: "/events/mon-3" }, T0);
    expect(peekIntent(T0 + INTENT_TTL_MS + 1)).toBeNull();
  });

  it("ignores corrupt storage instead of throwing", () => {
    window.localStorage.setItem("bcq.signin-intent", "{not json");
    expect(peekIntent(T0)).toBeNull();
    window.localStorage.setItem("bcq.signin-intent", JSON.stringify({ at: T0, intent: 7 }));
    expect(peekIntent(T0)).toBeNull();
  });

  it("refuses an intent whose returnTo leaves the site", () => {
    saveIntent({ returnTo: "https://evil.example/x" }, T0);
    expect(peekIntent(T0)?.returnTo).toBe("/");
  });
});

describe("safeReturnTo (open-redirect guard)", () => {
  it("keeps same-site paths, with query and hash", () => {
    expect(safeReturnTo("/events/mon-3?x=1#top")).toBe("/events/mon-3?x=1#top");
  });

  it("falls back to / for anything else", () => {
    for (const bad of [
      null,
      "",
      "events",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/sign-in",
      "/sign-in?return_to=/x",
    ]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});
