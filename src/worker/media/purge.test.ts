import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { isMediaExpired, purgeExpiredMedia, sixMonthsAfter, type MediaPurgeStore } from "./purge";

describe("media purge (S9.2, R2 via Miniflare)", () => {
  const keysToClean: string[] = [];

  afterEach(async () => {
    if (keysToClean.length > 0) {
      await env.MEDIA.delete(keysToClean.splice(0));
    }
  });

  it("computes exact 6-month expiry with month-end clamping", () => {
    expect(sixMonthsAfter(new Date("2027-01-15T12:00:00.000Z")).toISOString()).toBe(
      "2027-07-15T12:00:00.000Z",
    );
    expect(sixMonthsAfter(new Date("2026-08-31T12:00:00.000Z")).toISOString()).toBe(
      "2027-02-28T12:00:00.000Z",
    );
    expect(isMediaExpired(null, new Date("2027-09-01T00:00:00.000Z"))).toBe(false);
    expect(
      isMediaExpired(
        new Date("2027-03-01T12:00:00.000Z"),
        new Date("2027-09-01T11:59:59.000Z"),
      ),
    ).toBe(false);
    expect(
      isMediaExpired(
        new Date("2027-03-01T12:00:00.000Z"),
        new Date("2027-09-01T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("deletes only expired images (> 6 months after poll close) from Miniflare R2", async () => {
    const now = new Date("2027-09-01T12:00:00.000Z");
    const putObj = async (key: string) => {
      keysToClean.push(key);
      await env.MEDIA.put(key, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });
    };

    const expiredOld = "med_expired_old.png";
    const expiredExact = "med_expired_exact.png";
    const recentClosed = "med_recent_closed.png";
    const unreferenced = "med_unrelated.png";

    await Promise.all([
      putObj(expiredOld),
      putObj(expiredExact),
      putObj(recentClosed),
      putObj(unreferenced),
    ]);

    const clearedIds: string[] = [];
    const store: MediaPurgeStore = {
      findExpiredOptions: () =>
        Promise.resolve([
          {
            optionId: "pol_1_o00",
            closesAt: new Date("2027-02-15T12:00:00.000Z"),
            imageKey: expiredOld,
          },
          {
            optionId: "pol_2_o00",
            closesAt: new Date("2027-03-01T12:00:00.000Z"),
            imageKey: expiredExact,
          },
          {
            optionId: "pol_3_o00",
            closesAt: new Date("2027-03-01T12:00:01.000Z"),
            imageKey: recentClosed,
          },
        ]),
      clearImageKeys: (ids) => {
        clearedIds.push(...ids);
        return Promise.resolve();
      },
    };

    const result = await purgeExpiredMedia(store, env.MEDIA, now);

    expect(result.deletedKeys.sort()).toEqual([expiredExact, expiredOld].sort());
    expect(clearedIds.sort()).toEqual(["pol_1_o00", "pol_2_o00"].sort());

    expect(await env.MEDIA.get(expiredOld)).toBeNull();
    expect(await env.MEDIA.get(expiredExact)).toBeNull();
    expect(await env.MEDIA.get(recentClosed)).not.toBeNull();
    expect(await env.MEDIA.get(unreferenced)).not.toBeNull();
  });
});
