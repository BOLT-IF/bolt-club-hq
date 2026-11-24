import { describe, expect, it } from "vitest";

import wranglerRaw from "../../../wrangler.jsonc?raw";
import {
  CRON_FREQUENT,
  CRON_HOURLY,
  cronIntervalMs,
  isTickStale,
  markDue,
  readNextDue,
  NEXT_DUE_KEY,
} from "./schedule";
import { env } from "cloudflare:workers";

const MINUTE = 60_000;

/** Stockholm wall-clock hour for a UTC instant, via Intl (the test is the only place that needs it). */
function stockholmHour(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")?.value);
}

/** Which UTC hours does a trigger like "*\/10 5-22 * * *" or "0 0-4,23 * * *" fire in? */
function utcHoursOf(cron: string): number[] {
  const hourField = cron.split(" ")[1] ?? "";
  return hourField.split(",").flatMap((part) => {
    const [from, to] = part.split("-").map(Number);
    if (from === undefined) return [];
    return Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
  });
}

describe("cron triggers vs the Stockholm 07-23 window (S0.1 follow-up)", () => {
  it("wrangler.jsonc declares exactly the two scheduler triggers", () => {
    const match = /"crons":\s*\[([^\]]*)\]/.exec(wranglerRaw);
    const crons = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual([CRON_FREQUENT, CRON_HOURLY]);
  });

  it.each([
    ["summer (UTC+2)", "2026-07-15"],
    ["winter (UTC+1)", "2026-12-15"],
  ])("the frequent trigger covers every Stockholm hour 07-23 in %s", (_label, day) => {
    const frequent = new Set(utcHoursOf(CRON_FREQUENT));
    for (let utcHour = 0; utcHour < 24; utcHour++) {
      const at = new Date(`${day}T${String(utcHour).padStart(2, "0")}:00:00Z`);
      const local = stockholmHour(at);
      if (local >= 7 && local <= 23) {
        expect(frequent.has(utcHour), `UTC ${String(utcHour)}h = Stockholm ${String(local)}h`).toBe(
          true,
        );
      }
    }
  });

  it("every UTC hour is covered by exactly one trigger, so nothing is skipped and nothing overlaps", () => {
    const all = [...utcHoursOf(CRON_FREQUENT), ...utcHoursOf(CRON_HOURLY)].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });
});

describe("tick cadence and staleness", () => {
  it("is 10 minutes inside the frequent window and an hour outside it, in UTC", () => {
    expect(cronIntervalMs(Date.UTC(2026, 11, 15, 22, 30))).toBe(10 * MINUTE);
    expect(cronIntervalMs(Date.UTC(2026, 11, 15, 4, 30))).toBe(60 * MINUTE);
    expect(cronIntervalMs(Date.UTC(2026, 11, 15, 23, 0))).toBe(60 * MINUTE);
  });

  it("measures staleness against the cadence the previous tick ran at", () => {
    const at0400 = Date.UTC(2026, 11, 15, 4, 0);
    // Hourly tick at 04:00 then the first frequent tick at 05:00 is normal.
    expect(isTickStale(at0400, at0400 + 60 * MINUTE)).toBe(false);
    const at1200 = Date.UTC(2026, 11, 15, 12, 0);
    expect(isTickStale(at1200, at1200 + 20 * MINUTE)).toBe(false);
    expect(isTickStale(at1200, at1200 + 21 * MINUTE)).toBe(true);
    expect(isTickStale(null, at1200)).toBe(true);
  });
});

describe("next_due_at in KV", () => {
  it("markDue keeps the earliest due time", async () => {
    await env.KV.delete(NEXT_DUE_KEY);
    await markDue(env.KV, new Date("2026-12-15T12:00:00Z"));
    await markDue(env.KV, new Date("2026-12-15T18:00:00Z"));
    expect(await readNextDue(env.KV)).toBe(Date.parse("2026-12-15T12:00:00Z"));
    await markDue(env.KV, new Date("2026-12-15T09:00:00Z"));
    expect(await readNextDue(env.KV)).toBe(Date.parse("2026-12-15T09:00:00Z"));
    await env.KV.delete(NEXT_DUE_KEY);
  });
});
