import { expect, test, type Page } from "@playwright/test";

// tsconfig.node.json has no DOM lib. These declarations type only the browser globals used
// inside page.evaluate() callbacks, which run in the page, not in Node.
declare const navigator: {
  serviceWorker: {
    controller: { postMessage(message: unknown, transfer: unknown[]): void } | null;
    getRegistration(): Promise<
      { active: { state: string } | null; update(): Promise<void> } | undefined
    >;
  };
};
declare const caches: { keys(): Promise<string[]> };
declare const MessageChannel: new () => {
  readonly port1: { onmessage: ((event: unknown) => void) | null };
  readonly port2: unknown;
};

/** Waits until a service worker controls this page (installed, activated and claimed). */
async function waitForController(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 30_000,
    })
    .toBe(true);
}

test("manifest is valid, icons are served and the service worker registers", async ({
  page,
  request,
}) => {
  await page.goto("/probe");

  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const manifest = (await (await request.get(href!)).json()) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    display?: string;
    icons?: { src: string; sizes: string; type?: string; purpose?: string }[];
  };
  expect(manifest.name).toBeTruthy();
  expect(manifest.short_name).toBeTruthy();
  expect(manifest.start_url).toBeTruthy();
  expect(manifest.display).toBe("standalone");

  const icons = manifest.icons ?? [];
  expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  for (const icon of icons) {
    const res = await request.get(icon.src);
    expect(res.ok(), `icon ${icon.src} should be served`).toBe(true);
  }

  // Apple meta tags for the installed iOS app.
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.state ?? null;
      }),
    )
    .toBe("activated");
});

test("offline reload still shows the app shell", async ({ page, context }) => {
  await page.goto("/probe");
  await waitForController(page);

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test("/api requests never receive the app-shell fallback", async ({ page, context }) => {
  await page.goto("/probe");
  await waitForController(page);

  // Online: an unknown API path is a real API 404, not index.html.
  const online = await page.evaluate(async () => {
    const res = await fetch("/api/v1/does-not-exist");
    return { status: res.status, body: await res.text() };
  });
  expect(online.status).toBe(404);
  expect(online.body).not.toContain('id="root"');

  // Offline: API and excluded navigations fail instead of resolving with the shell.
  await context.setOffline(true);
  const apiOffline = await page.evaluate(() =>
    fetch("/api/v1/me").then(
      () => "resolved",
      () => "rejected",
    ),
  );
  expect(apiOffline).toBe("rejected");

  for (const path of ["/api/v1/me", "/e/some-event", "/s/some-series", "/media/some-key"]) {
    await expect(page.goto(path), `navigation to ${path} must not fall back`).rejects.toThrow();
    await expect(page.getByTestId("app-shell")).toHaveCount(0);
  }
});

test("caches are empty after logout", async ({ page }) => {
  await page.goto("/probe");
  await waitForController(page);
  expect(await page.evaluate(() => caches.keys())).not.toEqual([]);

  // The exported logout hook (src/sw/client.ts) asks the worker to clear every app cache.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          reject(new Error("no controlling service worker"));
          return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          resolve();
        };
        controller.postMessage({ type: "CLEAR_APP_CACHES" }, [channel.port2]);
      }),
  );

  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test("a new service worker version shows an update prompt", async ({ page, context, request }) => {
  await page.goto("/probe");
  await waitForController(page);

  // Serve a byte-different service worker to the next update check.
  const current = await (await request.get("/sw.js")).text();
  await context.route("**/sw.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `${current}\n// s0.3 update check\n`,
    }),
  );
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

  await expect(page.getByTestId("update-prompt")).toBeVisible();
});
