import { describe, expect, it, vi } from "vitest";

import { actionUrl, focusOrOpen, notificationFor, showPush } from "./push";

const data = (text: string | null) =>
  text === null ? null : { text: () => text, json: () => JSON.parse(text) as unknown };

function registration() {
  const shown: { title: string; options: NotificationOptions | undefined }[] = [];
  return {
    shown,
    reg: {
      showNotification: vi.fn((title: string, options?: NotificationOptions) => {
        shown.push({ title, options });
        return Promise.resolve();
      }),
    },
  };
}

describe("SW push handler", () => {
  it.each([
    ["a full payload", JSON.stringify({ title: "T", body: "B", url: "/events/x", tag: "ntf_1" })],
    ["a payload without url or tag", JSON.stringify({ title: "T", body: "B" })],
    ["an empty object", "{}"],
    ["wrong field types", JSON.stringify({ title: 3, body: null, url: 42 })],
    ["plain text", "Hello"],
    ["an empty string", ""],
    ["JSON that is not an object", "[1,2]"],
    ["no data at all", null],
  ])("shows a notification for %s (iOS revokes push otherwise)", async (_label, text) => {
    const { reg, shown } = registration();
    await showPush(reg, data(text));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title.length).toBeGreaterThan(0);
  });

  it("uses the payload's title, body, tag and in-app url", () => {
    const n = notificationFor(
      data(JSON.stringify({ title: "T", body: "B", url: "/events/x", tag: "ntf_1" })),
    );
    expect(n.title).toBe("T");
    expect(n.options).toMatchObject({ body: "B", tag: "ntf_1", data: { url: "/events/x" } });
  });

  it("falls back to the inbox for missing or off-site urls", () => {
    for (const url of [undefined, "https://evil.test/", "//evil.test", "/\\evil.test"]) {
      const n = notificationFor(data(JSON.stringify({ title: "T", body: "B", url })));
      expect(n.options.data).toEqual({ url: "/inbox" });
    }
  });

  it("uses plain text as the body under a generic title", () => {
    const n = notificationFor(data("Practice moved"));
    expect(n.options.body).toBe("Practice moved");
  });

  it("preserves up to two valid quick-action buttons on push notifications", () => {
    const n = notificationFor(
      data(
        JSON.stringify({
          title: "Thu XD",
          body: "RSVP open",
          url: "/events/thu",
          actions: [
            { action: "going", title: "RSVP" },
            { action: "decline", title: "Not going" },
            { action: "extra", title: "Ignored" },
          ],
        }),
      ),
    );
    expect(n.options.actions).toEqual([
      { action: "going", title: "RSVP" },
      { action: "decline", title: "Not going" },
    ]);
  });

  it("builds quickRsvp action URLs only for going/decline actions", () => {
    expect(actionUrl("/events/thu", "going")).toBe("/events/thu?quickRsvp=going");
    expect(actionUrl("/events/thu", "decline")).toBe("/events/thu?quickRsvp=decline");
    expect(actionUrl("/events/thu?src=push", "going")).toBe("/events/thu?src=push&quickRsvp=going");
    expect(actionUrl("/events/thu", "")).toBe("/events/thu");
    expect(actionUrl("https://evil.test/", "going")).toBe("/inbox?quickRsvp=going");
  });
});

describe("SW notification click", () => {
  const origin = "https://club.test";

  it("focuses an open window and navigates it to the target", async () => {
    const navigate = vi.fn(() => Promise.resolve(null));
    const focus = vi.fn(() => Promise.resolve(undefined));
    const clients = {
      matchAll: () => Promise.resolve([{ url: `${origin}/`, focus, navigate }]),
      openWindow: vi.fn(() => Promise.resolve(null)),
    };
    await focusOrOpen(clients, origin, "/events/x");
    expect(navigate).toHaveBeenCalledWith(`${origin}/events/x`);
    expect(focus).toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a window when none is open", async () => {
    const clients = {
      matchAll: () => Promise.resolve([]),
      openWindow: vi.fn(() => Promise.resolve(null)),
    };
    await focusOrOpen(clients, origin, "/inbox");
    expect(clients.openWindow).toHaveBeenCalledWith(`${origin}/inbox`);
  });
});
