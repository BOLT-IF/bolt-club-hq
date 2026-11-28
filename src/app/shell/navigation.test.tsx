import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../api/client";
import { FeatureFlagsProvider } from "../lib/flags";
import { AdminIndex } from "./AdminIndex";
import { BottomNav } from "./BottomNav";
import { PRIMARY_NAV, adminIndex, moreMenu, visibleNavItems, type NavItem } from "./navigation";

afterEach(() => {
  cleanup();
  configureApiClient({});
});

function renderNav(flags: Record<string, boolean>, path = "/") {
  return render(
    <FeatureFlagsProvider flags={flags}>
      <BottomNav items={PRIMARY_NAV} path={path} badges={{ inbox: 3 }} onMore={() => {}} />
    </FeatureFlagsProvider>,
  );
}

describe("bottom navigation", () => {
  it("shows Home, Events, Money, Inbox and More, in that order", () => {
    renderNav({ events: true, money: true, inbox: true });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const labels = Array.from(nav.querySelectorAll(".bcq-tabbar__label")).map((el) =>
      (el.textContent || "").trim(),
    );
    expect(labels).toEqual(["Home", "Events", "Money", "Inbox", "More"]);
  });

  it("shows the unread badge count on Inbox", () => {
    renderNav({ events: true, money: true, inbox: true });

    expect(screen.getByRole("link", { name: /Inbox/ }).textContent).toContain("3");
  });

  it("marks the current route with aria-current", () => {
    renderNav({ events: true }, "/events/42");

    expect(screen.getByRole("link", { name: "Events" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("hides the entry of a disabled feature flag", () => {
    renderNav({ events: false, money: true, inbox: true });

    expect(screen.queryByRole("link", { name: /Events/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Money/ })).toBeTruthy();
  });

  it("opens the More menu from its button", () => {
    let opened = 0;
    render(
      <FeatureFlagsProvider flags={{}}>
        <BottomNav
          items={PRIMARY_NAV}
          path="/"
          badges={{}}
          onMore={() => {
            opened += 1;
          }}
        />
      </FeatureFlagsProvider>,
    );
    screen.getByRole("button", { name: /More/ }).click();
    expect(opened).toBe(1);
  });
});

describe("navigation registry", () => {
  it("filters items by feature flag, keeping items without a flag", () => {
    const items: NavItem[] = [
      { id: "home", label: "Home", path: "/" },
      { id: "events", label: "Events", path: "/events", flag: "events" },
    ];
    expect(visibleNavItems(items, { events: false }).map((i) => i.id)).toEqual(["home"]);
    expect(visibleNavItems(items, { events: true }).map((i) => i.id)).toEqual(["home", "events"]);
  });

  it("hides Privacy from the More menu unless the privacy flag is on", () => {
    expect(visibleNavItems(moreMenu, { privacy: false }).map((i) => i.id)).not.toContain("privacy");
    expect(visibleNavItems(moreMenu, { privacy: true }).map((i) => i.id)).toContain("privacy");
  });

  it("only offers the Admin index to admins", () => {
    expect(adminIndex.every((item) => item.requiresAdmin === true)).toBe(true);
    expect(moreMenu.some((item) => item.id === "admin")).toBe(true);
  });

  it("gives every admin section a unique path under /admin", () => {
    const paths = adminIndex.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.startsWith("/admin/"))).toBe(true);
  });

  it("uses Title Case for all navigation labels", () => {
    expect(moreMenu.map((m) => m.label)).toEqual([
      "Profile",
      "Notifications",
      "Attendance History",
      "Privacy",
      "Install the App",
      "Admin",
      "Sign Out",
    ]);
    expect(adminIndex.map((a) => a.label)).toEqual([
      "Members",
      "Invites & Join Requests",
      "Terms & Series",
      "Club Finances",
      "Reminders",
      "Broadcast",
      "Polls",
      "Settings",
      "Audit Log",
    ]);
  });
});

describe("AdminIndex grouped hub", () => {
  it("renders the 4 grouped sections with glanceable counts and badges", async () => {
    configureApiClient({
      fetch: vi.fn((input: string) => {
        const path = input.replace("/api/v1", "");
        if (path === "/admin/members") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                members: [
                  { id: "m1", status: "active" },
                  { id: "m2", status: "active" },
                  { id: "m3", status: "erased" },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (path === "/admin/join-requests") {
          return Promise.resolve(
            new Response(JSON.stringify({ requests: [{ id: "r1" }, { id: "r2" }] }), {
              status: 200,
            }),
          );
        }
        if (path === "/polls") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                polls: [
                  { id: "p1", closed: false },
                  { id: "p2", closed: true },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    });

    render(<AdminIndex isAdmin />);

    expect(screen.getByRole("heading", { name: "PEOPLE" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "OPERATIONS" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "COMMUNICATION" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SYSTEM" })).toBeTruthy();

    expect(screen.getByRole("link", { name: /Club Finances/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeTruthy();

    await waitFor(() => {
      const membersLink = screen.getByRole("link", { name: /Members/ });
      expect(within(membersLink).getByText("2")).toBeTruthy();
      const approvalsLink = screen.getByRole("link", { name: /Invites & Join Requests/ });
      expect(within(approvalsLink).getByText("2")).toBeTruthy();
      const pollsLink = screen.getByRole("link", { name: /Polls/ });
      expect(within(pollsLink).getByText("1 Active")).toBeTruthy();
    });
  });
});
