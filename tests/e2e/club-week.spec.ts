import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// WebKit's service worker bypasses Playwright page.route() once sw.js claims the client.
test.use({ serviceWorkers: "block" });

const reply = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockClubWeekApi(page: Page, unmocked: string[]) {
  let voted = false;
  // Catch-all registered first (Playwright evaluates routes in reverse order).
  await page.route("**/api/v1/**", (route) => {
    unmocked.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true, polls: true } })),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      reply(200, {
        id: "mem_dana",
        displayName: "Dana Dropin",
        role: "member",
        status: "active",
        paymentRef: "BC-DANA",
      }),
    ),
  );
  await page.route("**/api/v1/me/profile", (route) =>
    route.fulfill(
      reply(200, {
        id: "mem_dana",
        displayName: "Dana Dropin",
        paymentRef: "BC-DANA",
      }),
    ),
  );
  await page.route("**/api/v1/notifications", (route) =>
    route.fulfill(reply(200, { items: [], unreadCount: 0 })),
  );
  await page.route("**/api/v1/events{,?*}", (route) =>
    route.fulfill(
      reply(200, {
        events: [
          {
            id: "evt_thu1",
            kind: "series",
            seriesId: "ser_1",
            title: "Thursday Mixed",
            format: "mixed",
            startsAt: "2027-03-04T18:00:00.000Z",
            endsAt: "2027-03-04T19:30:00.000Z",
            rsvpCloseAt: "2027-03-03T18:00:00.000Z",
            location: "Hall A",
            capacity: 12,
            confirmedCount: 3,
            adhocFee: 120,
            maxGuestsPerMember: 1,
            allocationMode: "tiered",
            status: "scheduled",
            shareSlug: "thu-mixed-1",
            materialChangeAt: null,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/v1/events/evt_thu1/rsvp", (route) =>
    route.fulfill(reply(200, { rsvp: null })),
  );
  await page.route("**/api/v1/me/ledger", (route) =>
    route.fulfill(
      reply(200, {
        balanceSek: 120,
        owedSek: 120,
        creditSek: 0,
        items: [
          {
            id: "led_1",
            kind: "charge",
            reason: "adhoc",
            amountSek: 120,
            status: "unpaid",
            allocatedSek: 0,
            outstandingSek: 120,
            note: null,
            createdAt: "2027-03-03T18:05:00.000Z",
            reversesEntryId: null,
            passId: null,
            eventId: "evt_thu1",
            eventTitle: "Thursday Mixed",
            eventStartsAt: "2027-03-04T18:00:00.000Z",
            guestId: null,
            guestName: null,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/v1/me/payment-claims", (route) =>
    route.fulfill(reply(200, { claims: [] })),
  );
  await page.route("**/api/v1/settings/public", (route) =>
    route.fulfill(
      reply(200, {
        clubName: "BOLT IF",
        bank: { accountHolder: "BOLT IF", bankgiro: "5402-9681", swish: "1234567890" },
        paymentInstructions: "Use your payment reference.",
      }),
    ),
  );
  await page.route("**/api/v1/passes/offers", (route) =>
    route.fulfill(reply(200, { offers: [], passes: [] })),
  );
  await page.route("**/api/v1/polls", (route) =>
    route.fulfill(
      reply(200, {
        polls: [
          {
            id: "pol_1",
            question: "New shuttle brand?",
            multiChoice: false,
            anonymous: false,
            resultsVisibility: "always",
            closesAt: "2027-03-30T12:00:00.000Z",
            closed: false,
            options: [
              { id: "opt_1", label: "Yonex", imageUrl: null },
              { id: "opt_2", label: "Victor", imageUrl: null },
            ],
            myVote: voted ? ["opt_1"] : [],
            resultsVisible: true,
            results: {
              totalVoters: voted ? 1 : 0,
              options: [
                { optionId: "opt_1", votes: voted ? 1 : 0 },
                { optionId: "opt_2", votes: 0 },
              ],
            },
          },
        ],
      }),
    ),
  );
  await page.route("**/api/v1/polls/pol_1", (route) =>
    route.fulfill(
      reply(200, {
        poll: {
          id: "pol_1",
          question: "New shuttle brand?",
          multiChoice: false,
          anonymous: false,
          resultsVisibility: "always",
          closesAt: "2027-03-30T12:00:00.000Z",
          closed: false,
          options: [
            { id: "opt_1", label: "Yonex", imageUrl: null },
            { id: "opt_2", label: "Victor", imageUrl: null },
          ],
          myVote: voted ? ["opt_1"] : [],
          resultsVisible: true,
          results: {
            totalVoters: voted ? 1 : 0,
            options: [
              { optionId: "opt_1", votes: voted ? 1 : 0 },
              { optionId: "opt_2", votes: 0 },
            ],
          },
        },
      }),
    ),
  );
  await page.route("**/api/v1/polls/pol_1/vote", (route) => {
    voted = true;
    return route.fulfill(
      reply(200, {
        poll: {
          id: "pol_1",
          question: "New shuttle brand?",
          multiChoice: false,
          anonymous: false,
          resultsVisibility: "always",
          closesAt: "2027-03-30T12:00:00.000Z",
          closed: false,
          options: [
            { id: "opt_1", label: "Yonex", imageUrl: null },
            { id: "opt_2", label: "Victor", imageUrl: null },
          ],
          myVote: ["opt_1"],
          resultsVisible: true,
          results: {
            totalVoters: 1,
            options: [
              { optionId: "opt_1", votes: 1 },
              { optionId: "opt_2", votes: 0 },
            ],
          },
        },
      }),
    );
  });
}

test("club-week mobile journey across Home, Money, and Polls has zero serious axe violations", async ({
  page,
}) => {
  const unmocked: string[] = [];
  await mockClubWeekApi(page, unmocked);

  await page.goto("/");
  await expect(page.getByText("Thursday Mixed")).toBeVisible();
  await expect(page.getByText("120 kr")).toBeVisible();
  await expect(page.getByText("New shuttle brand?")).toBeVisible();

  const homeAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    homeAxe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.help}`),
  ).toEqual([]);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /Money/ })
    .click();
  await expect(page.getByText("You owe 120 kr")).toBeVisible();
  await expect(page.getByText("Thursday Mixed")).toBeVisible();

  await page.goto("/polls/pol_1");
  await expect(page.getByText("New shuttle brand?")).toBeVisible();
  await page.getByRole("radio", { name: "Yonex" }).check();
  await page.getByRole("button", { name: /Vote|Save/ }).click();
  await expect(page.getByText("1 vote", { exact: true })).toBeVisible();
  expect(unmocked).toEqual([]);
});
