import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { poll, pollOption } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import pollRoutes from "../polls/routes";
import { MAX_IMAGES_PER_POLL } from "../polls/rules";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { drizzleMediaStore, purgeExpiredMedia } from "./purge";

const NOW = "2027-03-01T12:00:00.000Z";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
}

interface PollDto {
  id: string;
  options: Array<{ id: string; label: string; imageUrl: string | null }>;
}

describe("poll image options and purge against Postgres (S9.2)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let env: Cloudflare.Env;
  let deletedFromR2: string[];

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    deletedFromR2 = [];
    env = {
      ENV: "test",
      KV: fakeKv(),
      MEDIA: {
        delete: (keys: string | string[]) => {
          deletedFromR2.push(...(Array.isArray(keys) ? keys : [keys]));
          return Promise.resolve();
        },
      },
    } as unknown as Cloudflare.Env;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const call = (clerk: string, method: string, path: string, body?: unknown) =>
    pollRoutes.request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          [TEST_IDENTITY_HEADER]: clerk,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  it("enforces at most 8 images per poll and returns imageUrl in DTOs", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const alice = await makeMember(t.db, { role: "member" });

    const nineOptions = Array.from({ length: 9 }, (_, i) => `Opt ${String(i + 1)}`);
    const nineImages = Array.from({ length: 9 }, (_, i) => `med_${String(i)}.png`);
    const tooMany = await call(admin.clerkUserId, "POST", "/polls", {
      question: "Too many images?",
      options: nineOptions,
      optionImages: nineImages,
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_images" });
    expect(MAX_IMAGES_PER_POLL).toBe(8);

    const badLength = await call(admin.clerkUserId, "POST", "/polls", {
      question: "Mismatch?",
      options: ["A", "B"],
      optionImages: ["med_0.png"],
    });
    expect(badLength.status).toBe(400);

    const badKey = await call(admin.clerkUserId, "POST", "/polls", {
      question: "Bad key?",
      options: ["A", "B"],
      optionImages: ["../secret.png", null],
    });
    expect(badKey.status).toBe(400);

    const eightImages = Array.from({ length: 8 }, (_, i) => `med_${String(i)}.webp`);
    const okRes = await call(admin.clerkUserId, "POST", "/polls", {
      question: "Pick kit",
      options: Array.from({ length: 9 }, (_, i) => `Kit ${String(i + 1)}`),
      optionImages: [...eightImages, null],
      closesAt: "2027-03-05T12:00:00.000Z",
    });
    expect(okRes.status).toBe(201);
    const created = (await okRes.json<{ poll: PollDto }>()).poll;
    expect(created.options[0]?.imageUrl).toBe("/media/med_0.webp");
    expect(created.options[8]?.imageUrl).toBeNull();

    const fetched = await (
      await call(alice.clerkUserId, "GET", `/polls/${created.id}`)
    ).json<{ poll: PollDto }>();
    expect(fetched.poll.options[7]?.imageUrl).toBe("/media/med_7.webp");
    expect(fetched.poll.options[8]?.imageUrl).toBeNull();
  });

  it("deleting a poll deletes its option images from R2", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await call(admin.clerkUserId, "POST", "/polls", {
      question: "Logo?",
      options: ["A", "B"],
      optionImages: ["med_del_a.jpg", null],
    });
    const created = (await res.json<{ poll: PollDto }>()).poll;
    expect((await call(admin.clerkUserId, "DELETE", `/polls/${created.id}`)).status).toBe(204);
    expect(deletedFromR2).toEqual(["med_del_a.jpg"]);
  });

  it("purge deletes only images > 6 months after poll close and clears imageKey in Postgres", async () => {
    const admin = await makeMember(t.db, { role: "admin" });

    // Poll 1: closes 2027-03-02, purged at 2027-09-02+
    const p1 = (
      await (
        await call(admin.clerkUserId, "POST", "/polls", {
          question: "Old poll",
          options: ["A", "B"],
          optionImages: ["med_old_a.png", "med_old_b.png"],
          closesAt: "2027-03-02T12:00:00.000Z",
        })
      ).json<{ poll: PollDto }>()
    ).poll;

    // Poll 2: closes 2027-04-01, NOT expired at 2027-09-05
    const p2 = (
      await (
        await call(admin.clerkUserId, "POST", "/polls", {
          question: "Recent poll",
          options: ["C", "D"],
          optionImages: ["med_recent.png", null],
          closesAt: "2027-04-01T12:00:00.000Z",
        })
      ).json<{ poll: PollDto }>()
    ).poll;

    // Poll 3: no closing date (open), never expired
    const p3 = (
      await (
        await call(admin.clerkUserId, "POST", "/polls", {
          question: "Open poll",
          options: ["E", "F"],
          optionImages: ["med_open.png", null],
        })
      ).json<{ poll: PollDto }>()
    ).poll;

    const r2Deleted: string[] = [];
    const bucket = {
      delete: (keys: string | string[]) => {
        r2Deleted.push(...(Array.isArray(keys) ? keys : [keys]));
        return Promise.resolve();
      },
    };

    const result = await purgeExpiredMedia(
      drizzleMediaStore(t.db),
      bucket,
      new Date("2027-09-05T12:00:00.000Z"),
    );
    expect(result.deletedKeys.sort()).toEqual(["med_old_a.png", "med_old_b.png"]);
    expect(r2Deleted.sort()).toEqual(["med_old_a.png", "med_old_b.png"]);

    const opts1 = await t.db.select().from(pollOption).where(eq(pollOption.pollId, p1.id));
    expect(opts1.every((o) => o.imageKey === null)).toBe(true);

    const opts2 = await t.db.select().from(pollOption).where(eq(pollOption.pollId, p2.id));
    expect(opts2.find((o) => o.imageKey === "med_recent.png")).toBeTruthy();

    const opts3 = await t.db.select().from(pollOption).where(eq(pollOption.pollId, p3.id));
    expect(opts3.find((o) => o.imageKey === "med_open.png")).toBeTruthy();

    // Second run is a no-op
    const again = await purgeExpiredMedia(
      drizzleMediaStore(t.db),
      bucket,
      new Date("2027-09-05T12:00:00.000Z"),
    );
    expect(again.deletedKeys).toEqual([]);
    expect((await t.db.select().from(poll)).length).toBe(3);
  });
});
