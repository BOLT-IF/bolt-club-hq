import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, notification, pollVote } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { NEXT_DUE_KEY } from "../scheduler/schedule";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { runClosingReminders } from "./reminders";
import routes from "./routes";

const NOW = "2027-03-01T12:00:00.000Z";
const IN_3_DAYS = "2027-03-04T12:00:00.000Z";

/** Minimal in-memory KV: enough for markDue. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
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

interface Result {
  optionId: string;
  votes: number;
  voters?: Array<{ memberId: string; displayName: string }>;
}
interface PollDto {
  id: string;
  question: string;
  multiChoice: boolean;
  anonymous: boolean;
  resultsVisibility: string;
  closesAt: string | null;
  closed: boolean;
  options: Array<{ id: string; label: string }>;
  myVote: string[];
  resultsVisible: boolean;
  results: { totalVoters: number; options: Result[] } | null;
}

describe("poll routes", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let kv: ReturnType<typeof fakeKv>;
  let env: Cloudflare.Env;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    kv = fakeKv();
    env = { ENV: "test", KV: kv } as unknown as Cloudflare.Env;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const call = (clerk: string | null, method: string, path: string, body?: unknown) =>
    routes.request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(clerk ? { [TEST_IDENTITY_HEADER]: clerk } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  async function create(adminClerk: string, body: Record<string, unknown> = {}) {
    const res = await call(adminClerk, "POST", "/polls", {
      question: "Kit colour?",
      options: ["Red", "Blue", "Green"],
      closesAt: IN_3_DAYS,
      ...body,
    });
    expect(res.status).toBe(201);
    return (await res.json<{ poll: PollDto }>()).poll;
  }
  const get = async (clerk: string, id: string) =>
    (await (await call(clerk, "GET", `/polls/${id}`)).json<{ poll: PollDto }>()).poll;
  const vote = (clerk: string, id: string, optionIds: unknown) =>
    call(clerk, "PUT", `/polls/${id}/vote`, { optionIds });

  async function cast() {
    const admin = await makeMember(t.db, { role: "admin", displayName: "Ada Admin" });
    const alice = await makeMember(t.db, { displayName: "Alice Voter" });
    const bob = await makeMember(t.db, { displayName: "Bob Voter" });
    return { admin, alice, bob };
  }

  describe("guards", () => {
    it("members can read and vote; only admins create, edit or delete", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      expect((await call(null, "GET", "/polls")).status).toBe(401);
      const pending = await makeMember(t.db, { status: "pending" });
      expect((await call(pending.clerkUserId, "GET", "/polls")).status).toBe(403);
      expect((await call(alice.clerkUserId, "GET", "/polls")).status).toBe(200);
      expect(
        (await call(alice.clerkUserId, "POST", "/polls", { question: "x", options: ["a", "b"] }))
          .status,
      ).toBe(403);
      expect(
        (await call(alice.clerkUserId, "PATCH", `/polls/${p.id}`, { close: true })).status,
      ).toBe(403);
      expect((await call(alice.clerkUserId, "DELETE", `/polls/${p.id}`)).status).toBe(403);
      expect((await call(alice.clerkUserId, "GET", "/polls/nope")).status).toBe(404);
    });
  });

  describe("single and multi choice", () => {
    it("single choice: one option, and re-voting replaces the vote", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      const [red, blue] = p.options.map((o) => o.id);
      expect((await vote(alice.clerkUserId, p.id, [red, blue])).status).toBe(400);
      expect((await vote(alice.clerkUserId, p.id, [])).status).toBe(400);
      expect((await vote(alice.clerkUserId, p.id, ["opt_other"])).status).toBe(400);
      expect((await vote(alice.clerkUserId, p.id, [red])).status).toBe(200);
      expect((await vote(alice.clerkUserId, p.id, [blue])).status).toBe(200);
      const mine = await get(alice.clerkUserId, p.id);
      expect(mine.myVote).toEqual([blue]);
      expect(mine.results?.totalVoters).toBe(1);
      const rows = await t.db.select().from(pollVote).where(eq(pollVote.pollId, p.id));
      expect(rows).toHaveLength(1);
    });

    it("multi choice: several distinct options, counted per option", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId, { multiChoice: true });
      const [red, blue, green] = p.options.map((o) => o.id);
      expect((await vote(alice.clerkUserId, p.id, [red, red])).status).toBe(400);
      expect((await vote(alice.clerkUserId, p.id, [red, blue])).status).toBe(200);
      expect((await vote(bob.clerkUserId, p.id, [blue, green])).status).toBe(200);
      const view = await get(alice.clerkUserId, p.id);
      expect(view.myVote.sort()).toEqual([red, blue].sort());
      expect(view.results?.totalVoters).toBe(2);
      const votes = Object.fromEntries(
        view.results?.options.map((o) => [o.optionId, o.votes]) ?? [],
      );
      expect(votes).toEqual({ [red ?? ""]: 1, [blue ?? ""]: 2, [green ?? ""]: 0 });
    });

    it("an option of another poll is rejected", async () => {
      const { admin, alice } = await cast();
      const p1 = await create(admin.clerkUserId);
      const p2 = await create(admin.clerkUserId);
      expect((await vote(alice.clerkUserId, p1.id, [p2.options[0]?.id])).status).toBe(400);
    });
  });

  describe("closing", () => {
    it("voting at or after the close time is rejected and leaves the vote unchanged", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      const [red, blue] = p.options.map((o) => o.id);
      await vote(alice.clerkUserId, p.id, [red]);
      clock.set(IN_3_DAYS);
      const res = await vote(alice.clerkUserId, p.id, [blue]);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "poll_closed" });
      expect((await get(alice.clerkUserId, p.id)).myVote).toEqual([red]);
      expect((await get(alice.clerkUserId, p.id)).closed).toBe(true);
    });

    it("an admin can close a poll early; votes are then rejected", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      const res = await call(admin.clerkUserId, "PATCH", `/polls/${p.id}`, { close: true });
      expect(res.status).toBe(200);
      expect((await res.json<{ poll: PollDto }>()).poll.closesAt).toBe(NOW);
      expect((await vote(alice.clerkUserId, p.id, [p.options[0]?.id])).status).toBe(409);
    });

    it("rejects creation with a past closing time", async () => {
      const { admin } = await cast();
      const res = await call(admin.clerkUserId, "POST", "/polls", {
        question: "Late?",
        options: ["a", "b"],
        closesAt: "2027-02-01T00:00:00Z",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("visibility modes", () => {
    it("always: results for everyone, even before voting", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId);
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const v = await get(bob.clerkUserId, p.id);
      expect(v.resultsVisible).toBe(true);
      expect(v.results?.totalVoters).toBe(1);
    });

    it("after_vote: hidden until you vote", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId, { resultsVisibility: "after_vote" });
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const before = await get(bob.clerkUserId, p.id);
      expect(before.resultsVisible).toBe(false);
      expect(before.results).toBeNull();
      await vote(bob.clerkUserId, p.id, [p.options[1]?.id]);
      expect((await get(bob.clerkUserId, p.id)).results?.totalVoters).toBe(2);
    });

    it("after_close: hidden from voters until close, then shown", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId, { resultsVisibility: "after_close" });
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      expect((await get(alice.clerkUserId, p.id)).results).toBeNull();
      expect((await get(admin.clerkUserId, p.id)).results?.totalVoters).toBe(1);
      clock.set(IN_3_DAYS);
      expect((await get(alice.clerkUserId, p.id)).results?.totalVoters).toBe(1);
    });

    it("admins: members never see results, also not in the list", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId, { resultsVisibility: "admins" });
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      clock.set(IN_3_DAYS);
      expect((await get(alice.clerkUserId, p.id)).results).toBeNull();
      const list = await (
        await call(alice.clerkUserId, "GET", "/polls")
      ).json<{ polls: PollDto[] }>();
      expect(list.polls[0]?.results).toBeNull();
      expect((await get(admin.clerkUserId, p.id)).results?.totalVoters).toBe(1);
    });

    it("a named (not anonymous) poll shows who voted for what, alongside the results", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const v = await get(admin.clerkUserId, p.id);
      expect(v.results?.options[0]?.voters).toEqual([
        { memberId: alice.id, displayName: "Alice Voter" },
      ]);
    });

    it("only these settings can change after creation", async () => {
      const { admin } = await cast();
      const p = await create(admin.clerkUserId, { anonymous: true });
      expect(
        (await call(admin.clerkUserId, "PATCH", `/polls/${p.id}`, { anonymous: false })).status,
      ).toBe(400);
      const res = await call(admin.clerkUserId, "PATCH", `/polls/${p.id}`, {
        resultsVisibility: "after_close",
      });
      expect((await res.json<{ poll: PollDto }>()).poll.resultsVisibility).toBe("after_close");
    });
  });

  describe("anonymous polls never reveal voters", () => {
    /**
     * Every route of this area, with a request that exercises it. A new route that is not
     * listed here fails the sweep, so it cannot ship without being checked for leaks.
     */
    const sweep = (optionId: string): Record<string, { body?: unknown }> => ({
      "GET /polls": {},
      "GET /polls/:id": {},
      "POST /polls": { body: { question: "Another?", options: ["x", "y"], anonymous: true } },
      "PATCH /polls/:id": { body: { question: "Kit colour, really?" } },
      "PUT /polls/:id/vote": { body: { optionIds: [optionId] } },
      "DELETE /polls/:id": {},
    });

    it("no endpoint returns voter ids or names, for any viewer, open or closed", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId, { anonymous: true, multiChoice: true });
      const [red, blue] = p.options.map((o) => o.id);
      await vote(alice.clerkUserId, p.id, [red, blue]);
      await vote(bob.clerkUserId, p.id, [blue]);

      const secrets = [
        alice.id,
        bob.id,
        alice.clerkUserId,
        bob.clerkUserId,
        "Alice Voter",
        "Bob Voter",
      ];
      const table = sweep(red ?? "");
      const declared = routes.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`);
      for (const key of declared)
        expect(Object.keys(table), `add ${key} to the sweep`).toContain(key);

      // DELETE last, so the other routes still find the poll.
      const ordered = [...new Set(declared)].sort((a, b) =>
        a.startsWith("DELETE") ? 1 : b.startsWith("DELETE") ? -1 : 0,
      );
      let checked = 0;
      for (const at of [NOW, IN_3_DAYS]) {
        clock.set(at);
        for (const key of ordered) {
          const [method = "GET", pattern = ""] = key.split(" ");
          if (method === "DELETE" && at === NOW) continue;
          const path = pattern.replace(":id", p.id);
          for (const viewer of [admin, alice, bob]) {
            const res = await call(viewer.clerkUserId, method, path, table[key]?.body);
            const text = await res.text();
            for (const secret of secrets) {
              expect(text, `${key} as ${viewer.displayName} leaked ${secret}`).not.toContain(
                secret,
              );
            }
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(new Set(declared).size * 3);
    });

    it("results of an anonymous poll carry counts but no voters field", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId, { anonymous: true });
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const v = await get(admin.clerkUserId, p.id);
      expect(v.results?.options[0]?.votes).toBe(1);
      for (const o of v.results?.options ?? []) expect(o).not.toHaveProperty("voters");
    });

    it("the audit trail of a vote does not record who voted in an anonymous poll", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId, { anonymous: true });
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const audits = await t.db.select().from(auditLog);
      for (const a of audits) expect(JSON.stringify(a)).not.toContain(alice.id);
    });
  });

  describe("notifications and scheduling", () => {
    it("a new poll notifies every active member once and schedules the closing reminder", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId);
      const rows = await t.db.select().from(notification).where(eq(notification.category, "polls"));
      expect(rows.map((r) => r.memberId).sort()).toEqual([admin.id, alice.id, bob.id].sort());
      expect(rows[0]?.link).toBe(`/polls/${p.id}`);
      // 24h before close (PLAN §10).
      expect(kv.store.get(NEXT_DUE_KEY)).toBe(String(new Date("2027-03-03T12:00:00Z").getTime()));
    });

    it("the closing reminder goes 24h before close, only to members who have not voted, once", async () => {
      const { admin, alice, bob } = await cast();
      const p = await create(admin.clerkUserId);
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      const reminders = () =>
        t.db
          .select()
          .from(notification)
          .where(eq(notification.idempotencyKey, `poll-closing:${p.id}:${bob.id}`));

      clock.set("2027-03-03T11:59:00Z"); // 24h01m before close: too early
      await runClosingReminders({ db: t.db, clock, now: clock.now() });
      expect(await reminders()).toHaveLength(0);

      clock.set("2027-03-03T12:00:00Z");
      await runClosingReminders({ db: t.db, clock, now: clock.now() });
      await runClosingReminders({ db: t.db, clock, now: clock.now() });
      expect(await reminders()).toHaveLength(1);
      const all = await t.db.select().from(notification);
      expect(
        all
          .filter((n) => n.idempotencyKey.startsWith("poll-closing:"))
          .map((n) => n.memberId)
          .sort(),
      ).toEqual([admin.id, bob.id].sort());

      clock.set(IN_3_DAYS); // closed polls get no reminder
      const late = await create(admin.clerkUserId, { closesAt: "2027-03-04T13:00:00Z" });
      await call(admin.clerkUserId, "PATCH", `/polls/${late.id}`, { close: true });
      await runClosingReminders({ db: t.db, clock, now: clock.now() });
      const lateRows = (await t.db.select().from(notification)).filter((n) =>
        n.idempotencyKey.startsWith(`poll-closing:${late.id}`),
      );
      expect(lateRows).toHaveLength(0);
    });

    it("deleting a poll removes its options and votes", async () => {
      const { admin, alice } = await cast();
      const p = await create(admin.clerkUserId);
      await vote(alice.clerkUserId, p.id, [p.options[0]?.id]);
      expect((await call(admin.clerkUserId, "DELETE", `/polls/${p.id}`)).status).toBe(204);
      expect((await call(alice.clerkUserId, "GET", `/polls/${p.id}`)).status).toBe(404);
      expect(await t.db.select().from(pollVote)).toHaveLength(0);
    });
  });
});
