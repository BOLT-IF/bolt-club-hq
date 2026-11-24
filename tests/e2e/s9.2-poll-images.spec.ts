import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// 1x1 transparent PNG (67 bytes), valid magic bytes + decodable by Chromium and WebKit.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const POLL_WITH_IMAGES = {
  id: "pol_img_1",
  question: "Which jersey design for 2027?",
  multiChoice: false,
  anonymous: false,
  resultsVisibility: "after_vote",
  closesAt: "2027-04-01T18:00:00.000Z",
  closed: false,
  createdAt: "2027-03-01T12:00:00.000Z",
  options: [
    { id: "pol_img_1_o00", label: "Orange Bolt", imageUrl: "/media/med_orange.png" },
    { id: "pol_img_1_o01", label: "Midnight Slate", imageUrl: "/media/med_slate.png" },
  ],
  myVote: [],
  resultsVisible: false,
  results: null,
};

async function setupPollRoutes(page: Page) {
  let votePayload: unknown = null;
  const mediaRequests: string[] = [];

  await page.route("**/api/v1/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags: { events: true, money: true, inbox: true, polls: true } }),
    }),
  );

  await page.route("**/media/**", (route) => {
    mediaRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "Cache-Control": "private, max-age=86400" },
      body: TINY_PNG,
    });
  });

  await page.route("**/api/v1/polls/pol_img_1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ poll: POLL_WITH_IMAGES }),
    }),
  );

  await page.route("**/api/v1/polls/pol_img_1/vote", async (route) => {
    votePayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        poll: {
          ...POLL_WITH_IMAGES,
          myVote: ["pol_img_1_o01"],
          resultsVisible: true,
          results: {
            totalVoters: 1,
            options: [
              { optionId: "pol_img_1_o00", votes: 0, voters: [] },
              {
                optionId: "pol_img_1_o01",
                votes: 1,
                voters: [{ memberId: "mem_1", displayName: "Alex" }],
              },
            ],
          },
        },
      }),
    });
  });

  return {
    getVotePayload: () => votePayload,
    mediaRequests,
  };
}

test.describe("polls with images on mobile (S9.2)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("member views image options on mobile, votes, and sees results with zero axe violations", async ({
    page,
  }) => {
    const tracker = await setupPollRoutes(page);
    await page.goto("/polls/pol_img_1");

    await expect(page.getByRole("heading", { name: "Which jersey design for 2027?" })).toBeVisible();

    const images = page.locator("article img");
    await expect(images).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(images.nth(i)).toBeVisible();
      const loaded = await images.nth(i).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
      expect(loaded).toBe(true);
    }
    expect(tracker.mediaRequests.sort()).toEqual(["/media/med_orange.png", "/media/med_slate.png"]);

    // No horizontal overflow on a 390px mobile viewport.
    const fitsViewport = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fitsViewport).toBe(true);

    await page.getByRole("radio", { name: "Midnight Slate" }).click();
    await page.getByRole("button", { name: "Vote" }).click();

    await expect(page.getByText("Your vote is saved.")).toBeVisible();
    expect(tracker.getVotePayload()).toEqual({ optionIds: ["pol_img_1_o01"] });
    await expect(page.getByText("1 vote")).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("admin attaches an image when creating a poll", async ({ page }) => {
    let createdBody: unknown = null;

    await page.route("**/api/v1/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flags: { events: true, money: true, inbox: true, polls: true } }),
      }),
    );
    await page.route("**/api/v1/polls", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ polls: [] }),
        });
      }
      createdBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ poll: POLL_WITH_IMAGES }),
      });
    });
    await page.route("**/api/v1/media", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          key: "med_uploaded.png",
          url: "/media/med_uploaded.png",
          contentType: "image/png",
          size: TINY_PNG.byteLength,
        }),
      }),
    );

    await page.goto("/admin/polls");
    await page.getByLabel("Question").fill("Which jersey?");
    await page.getByLabel("Option 1").fill("Orange");
    await page.getByLabel("Option 2").fill("Slate");

    await page.getByLabel("Image for option 1").setInputFiles({
      name: "orange.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect(page.getByRole("button", { name: /remove image for option 1/i })).toBeVisible();

    await page.getByRole("button", { name: "Create poll" }).click();
    await expect.poll(() => createdBody).toEqual({
      question: "Which jersey?",
      options: ["Orange", "Slate"],
      optionImages: ["med_uploaded.png", null],
      multiChoice: false,
      anonymous: false,
      resultsVisibility: "always",
      closesAt: null,
    });
  });
});
