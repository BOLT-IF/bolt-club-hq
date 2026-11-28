import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { createApp } from "../app";
import { eventsDeps } from "../events/deps";
import { eventOgKey, ogSnapshot } from "../events/rules";
import { configureShareDeps } from "./deps";
import { injectOgIntoHtml } from "./og";

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
}

describe("share OG and edge routes (S7.1)", () => {
  it("escapes a malicious title and location in every OG attribute and HTML tag", async () => {
    const kv = makeKv();
    const maliciousTitle = `Bad "Title" <script>alert(1)</script> & 'xss'`;
    const maliciousLocation = `Hall <img src=x onerror=alert(1)> "A" & 'B'`;
    await kv.put(
      eventOgKey("evilslug"),
      ogSnapshot({
        shareSlug: "evilslug",
        title: maliciousTitle,
        format: "Mixed Doubles",
        location: maliciousLocation,
        startsAt: new Date("2027-03-11T18:00:00.000Z"),
        endsAt: new Date("2027-03-11T19:30:00.000Z"),
        status: "scheduled",
      }),
    );

    const app = createApp();
    const res = await app.request("https://club.example/e/evilslug", undefined, { ...env, KV: kv });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;Title&quot;");
    expect(html).toContain("&#39;xss&#39;");
    expect(html).toContain("&amp;");
    // Every OG meta tag has properly escaped content.
    expect(html).toMatch(
      /<meta property="og:title" content="[^"]*&lt;script&gt;alert\(1\)&lt;\/script&gt;[^"]*"\s*\/?>/,
    );
    expect(html).toMatch(
      /<meta property="og:description" content="[^"]*&lt;img src=x[^"]*"\s*\/?>/,
    );
  });

  it("carries noindex, a CSP without unsafe-inline scripts, and no attendee names", async () => {
    const kv = makeKv();
    await kv.put(
      eventOgKey("club1234"),
      ogSnapshot({
        shareSlug: "club1234",
        title: "Thu Mixed Doubles",
        format: "Mixed Doubles",
        location: "Hall X",
        startsAt: new Date("2027-03-11T18:00:00.000Z"),
        endsAt: new Date("2027-03-11T19:30:00.000Z"),
        status: "scheduled",
      }),
    );

    const app = createApp();
    const res = await app.request("https://club.example/e/club1234", undefined, { ...env, KV: kv });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex');
    expect(html).not.toContain("attendee");
  });

  it("falls back to Neon on KV miss, and to generic page when Neon is unavailable", async () => {
    const kv = makeKv();
    let neonCalled = false;
    configureShareDeps({
      findEventBySlug: () => {
        neonCalled = true;
        return Promise.resolve({
          shareSlug: "fromneon1",
          title: "Neon Fallback Event",
          format: "Mixed Doubles",
          location: "Hall N",
          startsAt: new Date("2027-03-12T18:00:00.000Z"),
          endsAt: new Date("2027-03-12T19:30:00.000Z"),
          status: "scheduled",
        });
      },
    });

    try {
      const app = createApp();
      const res1 = await app.request("https://club.example/e/fromneon1", undefined, {
        ...env,
        KV: kv,
      });
      expect(res1.status).toBe(200);
      expect(neonCalled).toBe(true);
      const html1 = await res1.text();
      expect(html1).toContain("Neon Fallback Event");

      // When Neon also fails (e.g. suspended/unreachable), falls back to generic page.
      configureShareDeps({
        findEventBySlug: () => Promise.reject(new Error("neon_timeout")),
      });
      const res2 = await app.request("https://club.example/e/someevent", undefined, {
        ...env,
        KV: kv,
      });
      expect(res2.status).toBe(200);
      const html2 = await res2.text();
      expect(html2).toContain("BOLT IF");
      expect(html2).toContain('name="robots" content="noindex');
    } finally {
      configureShareDeps({});
    }
  });

  it("returns a friendly 404 for an unknown slug when Neon confirms it does not exist", async () => {
    const kv = makeKv();
    configureShareDeps({
      findEventBySlug: () => Promise.resolve(null),
      findSeriesNextBySlug: () => Promise.resolve({ exists: false, event: null }),
    });

    try {
      const app = createApp();
      const resEvent = await app.request("https://club.example/e/doesnotexist", undefined, {
        ...env,
        KV: kv,
      });
      expect(resEvent.status).toBe(404);
      expect(resEvent.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(await resEvent.text()).toContain("We couldn&#39;t find that event");

      const resSeries = await app.request("https://club.example/s/doesnotexist", undefined, {
        ...env,
        KV: kv,
      });
      expect(resSeries.status).toBe(404);
      expect(await resSeries.text()).toContain("We couldn&#39;t find that series");
    } finally {
      configureShareDeps({});
    }
  });

  it("production publishOg writes og:event:<slug> JSON to KV (not a no-op)", async () => {
    const kv = makeKv();
    const port = eventsDeps().publishOg({ ...env, KV: kv });
    const snapshot = ogSnapshot({
      shareSlug: "real1234",
      title: "Real KV Event",
      format: "Men's Doubles",
      location: "Hall R",
      startsAt: new Date("2027-03-11T18:00:00.000Z"),
      endsAt: new Date("2027-03-11T19:30:00.000Z"),
      status: "scheduled",
    });
    await port.publishOg({ key: eventOgKey("real1234"), html: snapshot });
    expect(await kv.get("og:event:real1234")).toBe(snapshot);
  });

  it("does not expand $ replacement patterns in title, description, url, or bodyFallback", () => {
    const html = injectOgIntoHtml(
      null,
      {
        title: "Match $' $& $$ $`",
        description: "Desc $' $& $$ $`",
        url: "https://club.example/e/dollar$'$$$&",
      },
      "Fallback $' $& $$ $`",
    );

    // Must not duplicate <body> or <script type="module" inside <head>.
    const headEndIdx = html.indexOf("</head>");
    expect(headEndIdx).toBeGreaterThan(-1);
    const headSection = html.slice(0, headEndIdx);
    expect(headSection).not.toContain("<body>");
    expect(headSection).not.toContain('<script type="module"');

    // Literal $ sequences must be preserved intact.
    expect(html).toContain("<title>Match $&#39; $&amp; $$ $`</title>");
    expect(html).toContain('content="Desc $&#39; $&amp; $$ $`"');
    expect(html).toContain('content="https://club.example/e/dollar$&#39;$$$&amp;"');
    expect(html).toContain('<div id="root"><p>Fallback $&#39; $&amp; $$ $`</p></div>');
    expect(html.match(/<body>/gi)?.length).toBe(1);
    expect(html.match(/<script type="module"/gi)?.length).toBe(1);
  });

  it("canonicalizes og:url without query strings and resists query-string $-pattern injection on /e/:slug and /s/:slug", async () => {
    const kv = makeKv();
    configureShareDeps({
      findEventBySlug: () => Promise.resolve(null),
      findSeriesNextBySlug: () => Promise.resolve({ exists: false, event: null }),
    });

    try {
      const app = createApp();
      const resEvent = await app.request(
        "https://club.example/e/nonexistent?x=$'&utm=1",
        undefined,
        {
          ...env,
          KV: kv,
        },
      );
      expect(resEvent.status).toBe(404);
      const eventHtml = await resEvent.text();
      expect(eventHtml).toContain(
        '<meta property="og:url" content="https://club.example/e/nonexistent" />',
      );
      expect(eventHtml).not.toContain("?x=");
      expect(eventHtml.match(/<body>/gi)?.length).toBe(1);
      expect(eventHtml.match(/<script type="module"/gi)?.length).toBe(1);

      const resSeries = await app.request(
        "https://club.example/s/nonexistent?x=$'&foo=bar",
        undefined,
        {
          ...env,
          KV: kv,
        },
      );
      expect(resSeries.status).toBe(404);
      const seriesHtml = await resSeries.text();
      expect(seriesHtml).toContain(
        '<meta property="og:url" content="https://club.example/s/nonexistent" />',
      );
      expect(seriesHtml).not.toContain("?x=");
      expect(seriesHtml.match(/<body>/gi)?.length).toBe(1);
    } finally {
      configureShareDeps({});
    }
  });
});
