import { describe, expect, it } from "vitest";

import type { Clock } from "../core/clock";
import type { Tx } from "../core/db/client";
import {
  loadPolicies,
  runPolicyChain,
  type NotificationPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "./policy";

const ctx = {
  db: {} as Tx,
  clock: { now: () => new Date("2027-01-01T10:00:00Z") } satisfies Clock,
  notification: {
    id: "ntf_1",
    memberId: "m1",
    category: "rsvp_status",
    title: "t",
    body: "b",
    link: null,
  },
} satisfies PolicyContext;

const policy = (id: string, order: number, decision: PolicyDecision, seen?: string[]) =>
  ({
    id,
    order,
    evaluate: () => {
      seen?.push(id);
      return Promise.resolve(decision);
    },
  }) satisfies NotificationPolicy;

describe("policy chain", () => {
  it("allows when there are no policies", async () => {
    expect(await runPolicyChain([], ctx)).toEqual({ action: "allow" });
  });

  it("runs in ascending order and the first non-allow decision wins", async () => {
    const seen: string[] = [];
    const decision = await runPolicyChain(
      [
        policy("freq-cap", 30, { action: "suppress", reason: "cap" }, seen),
        policy("mute", 10, { action: "allow" }, seen),
        policy("quiet", 20, { action: "suppress", reason: "quiet" }, seen),
      ],
      ctx,
    );
    expect(decision).toEqual({ action: "suppress", reason: "quiet" });
    expect(seen).toEqual(["mute", "quiet"]);
  });

  it("carries a deferral through unchanged", async () => {
    const until = new Date("2027-01-02T07:00:00Z");
    const decision = await runPolicyChain(
      [policy("quiet", 20, { action: "defer", until, reason: "quiet hours" })],
      ctx,
    );
    expect(decision).toEqual({ action: "defer", until, reason: "quiet hours" });
  });
});

describe("policy loading", () => {
  it("takes each module's default export, ordered", () => {
    const quiet = policy("quiet", 20, { action: "allow" });
    const mute = policy("mute", 10, { action: "allow" });
    expect(
      loadPolicies({
        "./policies/quiet.ts": { default: quiet },
        "./policies/mute.ts": { default: mute },
      }),
    ).toEqual([mute, quiet]);
  });

  it("ships no policies yet (S6.2 and S6.3 add them)", () => {
    expect(loadPolicies({})).toEqual([]);
  });
});
