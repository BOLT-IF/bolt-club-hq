import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const EVENT_DTO = {
  id: "evt_share_1",
  slug: "k3f9xq2m",
  seriesId: null,
  kind: "admin_oneoff",
  title: "Thu Mixed Doubles",
  format: "XD",
  startsAt: "2027-03-11T18:00:00.000Z",
  endsAt: "2027-03-11T19:30:00.000Z",
  location: "Hall X",
  capacity: 16,
  adhocFee: 50,
  maxGuestsPerMember: 1,
  rsvpCloseAt: "2027-03-11T17:00:00.000Z",
  allocationMode: "tiered",
  status: "scheduled",
  readOnly: false,
};

test.describe("share link flows (S7.1)", () => {
  test.use({ serviceWorkers: "block" });

  test("logged out -> sign-in -> RSVP in at most 1 extra tap", async ({ page }) => {
    let signedIn = false;
    let rsvpPutCount = 0;

    await page.route("**/api/v1/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flags: { events: true, money: false, inbox: false, polls: false } }),
      }),
    );

    await page.route("**/api/v1/events/by-slug/k3f9xq2m", (route) => {
      if (!signedIn) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          event: EVENT_DTO,
          viewer: { canManage: false, canSeeAttendees: true },
        }),
      });
    });

    await page.route("**/api/v1/events/evt_share_1/rsvp", (route) => {
      if (route.request().method() === "PUT") {
        rsvpPutCount += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            rsvp: { id: "rsvp_1", status: "requested", guests: [] },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rsvp: rsvpPutCount > 0 ? { id: "rsvp_1", status: "requested", guests: [] } : null,
        }),
      });
    });

    await page.route("**/api/v1/events/evt_share_1/attendees", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ attendees: [] }),
      }),
    );

    await page.goto("/e/k3f9xq2m");
    const signInBtn = page.getByRole("button", { name: /sign in/i });
    await expect(signInBtn).toBeVisible();
    await signInBtn.click();

    await expect(page).toHaveURL(/\/sign-in/);

    // Simulate Clerk email-code sign-in completing and returning to return_to.
    signedIn = true;
    const returnTo = new URL(page.url()).searchParams.get("return_to") ?? "/e/k3f9xq2m";
    await page.goto(returnTo);

    await expect(page.getByRole("heading", { name: "Thu Mixed Doubles" })).toBeVisible();
    await expect.poll(() => rsvpPutCount).toBe(1);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("non-member sees request to join", async ({ page }) => {
    await page.route("**/api/v1/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flags: { events: true, money: false, inbox: false, polls: false } }),
      }),
    );

    await page.route("**/api/v1/events/by-slug/k3f9xq2m", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "forbidden" }),
      }),
    );

    await page.goto("/e/k3f9xq2m");
    const joinLink = page.getByRole("link", { name: /request to join/i });
    await expect(joinLink).toBeVisible();
    await expect(joinLink).toHaveAttribute("href", "/join/event/k3f9xq2m");

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });
});
