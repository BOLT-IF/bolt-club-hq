import { describe, expect, it } from "vitest";

import { selfLedgerGuard } from "./index";

describe("self-ledger guard (PLAN A11)", () => {
  it("allows an admin to write on someone else's ledger", () => {
    expect(selfLedgerGuard({ actorId: "a", memberId: "b", otherActiveAdmins: 0 })).toBe("allow");
    expect(selfLedgerGuard({ actorId: "a", memberId: "b", otherActiveAdmins: 3 })).toBe("allow");
  });

  it("blocks an admin writing on their own ledger when another admin exists", () => {
    expect(selfLedgerGuard({ actorId: "a", memberId: "a", otherActiveAdmins: 1 })).toBe("block");
    expect(selfLedgerGuard({ actorId: "a", memberId: "a", otherActiveAdmins: 4 })).toBe("block");
  });

  it("allows but flags it when the admin is the only admin", () => {
    expect(selfLedgerGuard({ actorId: "a", memberId: "a", otherActiveAdmins: 0 })).toBe(
      "allow_flagged",
    );
  });
});
