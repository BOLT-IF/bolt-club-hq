import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const PLACEHOLDERS = {
  payment_due: ["name", "balance", "paymentRef"],
  event_unrsvped: ["name", "event", "when", "closes"],
};

const INITIAL_RULE = {
  id: "rr_pay_1",
  kind: "payment_due" as const,
  enabled: true,
  minIntervalDays: 90,
  template: "Hi {name}, you owe {balance} kr (ref {paymentRef}).",
  params: { thresholdSek: 300 },
};

async function mockAdminApi(page: Page) {
  let rules = [{ ...INITIAL_RULE }];
  const reply = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true } })),
  );

  await page.route("**/api/v1/notifications**", (route) =>
    route.fulfill(reply(200, { items: [], unreadCount: 0 })),
  );

  await page.route("**/api/v1/admin/reminder-rules**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (pathname === "/api/v1/admin/reminder-rules") {
      if (req.method() === "GET") {
        return route.fulfill(reply(200, { items: rules, placeholders: PLACEHOLDERS }));
      }
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Omit<typeof INITIAL_RULE, "id">;
        const created = { id: `rr_${String(rules.length + 1)}`, ...body };
        rules = [...rules, created];
        return route.fulfill(reply(201, created));
      }
      return route.fulfill(reply(405, { error: "method_not_allowed" }));
    }

    if (pathname.endsWith("/preview") && req.method() === "POST") {
      return route.fulfill(
        reply(200, {
          count: 1,
          recipients: [{ memberId: "m1", displayName: "Alex" }],
          sample: {
            title: "Payment reminder",
            body: "Hi Alex, you owe 450 kr (ref BOLT-ALEX).",
            link: "/money",
          },
        }),
      );
    }

    const id = pathname.split("/").pop() ?? "";
    if (req.method() === "DELETE") {
      return route.fulfill(reply(409, { error: "rule_has_sends" }));
    }
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as Omit<typeof INITIAL_RULE, "id">;
      const updated = { id, ...body };
      rules = rules.map((r) => (r.id === id ? updated : r));
      return route.fulfill(reply(200, updated));
    }
    return route.fulfill(reply(404, { error: "not_found" }));
  });
}

test("renders placeholders, rejects unknown placeholder, previews, and disables on 409", async ({
  page,
}) => {
  await mockAdminApi(page);
  await page.goto("/admin/reminders");

  await expect(page.getByRole("heading", { level: 1, name: "Reminders" })).toBeVisible();
  await expect(page.getByText(/you owe \{balance\} kr/i)).toBeVisible();

  await page.getByRole("button", { name: "New rule" }).click();
  await expect(page.getByRole("button", { name: "{paymentRef}" })).toBeVisible();

  await page.getByLabel("Minimum balance owed (kr)").fill("200");
  await page.getByLabel("Message template").fill("Pay {nope}");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText(/unknown placeholder.*\{nope\}/i)).toBeVisible();

  await page.getByLabel("Message template").fill("Pay ");
  await page.getByRole("button", { name: "{balance}" }).click();
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("Pay {balance}")).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).first().click();
  const previewDialog = page.getByRole("dialog", { name: /preview/i });
  await expect(previewDialog).toContainText("1 member");
  await expect(previewDialog).toContainText("Alex");
  await previewDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Delete rule" }).click();
  await expect(page.getByText(/already sent reminders/i)).toBeVisible();
  await page.getByRole("button", { name: "Disable instead" }).click();
  await expect(page.getByText("Disabled").first()).toBeVisible();
});

test("members get 403 and see an admins-only message", async ({ page }) => {
  await page.route("**/api/v1/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags: { events: true, money: true, inbox: true } }),
    }),
  );
  await page.route("**/api/v1/notifications**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], unreadCount: 0 }),
    }),
  );
  await page.route("**/api/v1/admin/reminder-rules", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "forbidden" }),
    }),
  );

  await page.goto("/admin/reminders");
  await expect(page.getByRole("heading", { name: "Admins only" })).toBeVisible();
});

test("the reminder admin screen has no serious or critical axe violations", async ({ page }) => {
  await mockAdminApi(page);
  await page.goto("/admin/reminders");
  await expect(page.getByRole("heading", { level: 1, name: "Reminders" })).toBeVisible();

  await page.getByRole("button", { name: "New rule" }).click();
  await expect(page.getByRole("button", { name: "{paymentRef}" })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
