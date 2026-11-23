import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BottomNav } from "./BottomNav";
import { FeatureFlagsProvider } from "../lib/flags";
import { PRIMARY_NAV, adminIndex, moreMenu, visibleNavItems, type NavItem } from "./navigation";

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
    const labels = Array.from(nav.querySelectorAll("a, button")).map((el) =>
      (el.textContent ?? "").replace(/\s*\d+$/, "").trim(),
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

  it("opens the More menu from its button", async () => {
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

  it("only offers the Admin index to admins", () => {
    expect(adminIndex.every((item) => item.requiresAdmin === true)).toBe(true);
    expect(moreMenu.some((item) => item.id === "admin")).toBe(true);
  });

  it("gives every admin section a unique path under /admin", () => {
    const paths = adminIndex.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.startsWith("/admin/"))).toBe(true);
  });
});
