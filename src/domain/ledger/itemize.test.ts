import { describe, expect, it } from "vitest";

import { balanceOf, itemize, type LedgerRow } from "./index";

let n = 0;
function row(
  kind: LedgerRow["kind"],
  amountSek: number,
  createdAt: number,
  extra: Partial<LedgerRow> = {},
): LedgerRow {
  n += 1;
  return {
    id: `e${String(n).padStart(3, "0")}`,
    kind,
    amountSek,
    reason: kind === "payment" ? "payment" : "adhoc",
    createdAt,
    reversesEntryId: null,
    ...extra,
  };
}

function byId(result: ReturnType<typeof itemize>, id: string) {
  const item = result.items.find((i) => i.entry.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

describe("balance", () => {
  it("is the sum of the signed entries; positive means the member owes", () => {
    expect(balanceOf([])).toBe(0);
    expect(balanceOf([row("charge", 120, 1), row("charge", 80, 2), row("payment", -50, 3)])).toBe(
      150,
    );
  });
});

describe("itemize: FIFO allocation", () => {
  it("a partial payment pays the oldest charge first and splits across the next", () => {
    const c1 = row("charge", 100, 1);
    const c2 = row("charge", 200, 2);
    const c3 = row("charge", 50, 3);
    const p = row("payment", -150, 4);
    const result = itemize([c1, c2, c3, p]);

    expect(result.balanceSek).toBe(200);
    expect(result.owedSek).toBe(200);
    expect(result.creditSek).toBe(0);
    expect(byId(result, c1.id)).toMatchObject({
      allocatedSek: 100,
      outstandingSek: 0,
      status: "paid",
    });
    expect(byId(result, c2.id)).toMatchObject({
      allocatedSek: 50,
      outstandingSek: 150,
      status: "partly_paid",
    });
    expect(byId(result, c3.id)).toMatchObject({
      allocatedSek: 0,
      outstandingSek: 50,
      status: "unpaid",
    });
    expect(byId(result, p.id)).toMatchObject({ allocatedSek: 150, outstandingSek: 0 });
  });

  it("credit from an early payment is consumed by later charges", () => {
    const p = row("payment", -300, 1);
    const afterPayment = itemize([p]);
    expect(afterPayment).toMatchObject({ balanceSek: -300, owedSek: 0, creditSek: 300 });
    expect(byId(afterPayment, p.id)).toMatchObject({ allocatedSek: 0, outstandingSek: 300 });

    const c1 = row("charge", 120, 2);
    const c2 = row("charge", 120, 3);
    const c3 = row("charge", 120, 4);
    const result = itemize([p, c1, c2, c3]);
    expect(result).toMatchObject({ balanceSek: 60, owedSek: 60, creditSek: 0 });
    expect(byId(result, c1.id).status).toBe("paid");
    expect(byId(result, c2.id).status).toBe("paid");
    expect(byId(result, c3.id)).toMatchObject({ allocatedSek: 60, outstandingSek: 60 });
    expect(byId(result, p.id)).toMatchObject({ allocatedSek: 300, outstandingSek: 0 });
  });

  it("overpayment leaves credit and every charge paid", () => {
    const c = row("charge", 100, 1);
    const p = row("payment", -250, 2);
    const result = itemize([c, p]);
    expect(result).toMatchObject({ balanceSek: -150, owedSek: 0, creditSek: 150 });
    expect(byId(result, c.id).status).toBe("paid");
    expect(byId(result, p.id)).toMatchObject({ allocatedSek: 100, outstandingSek: 150 });
  });

  it("orders by time then id, not by input order", () => {
    const c1 = row("charge", 100, 1);
    const c2 = row("charge", 100, 2);
    const p = row("payment", -100, 3);
    const result = itemize([p, c2, c1]);
    expect(result.items.map((i) => i.entry.id)).toEqual([c1.id, c2.id, p.id]);
    expect(byId(result, c1.id).status).toBe("paid");
    expect(byId(result, c2.id).status).toBe("unpaid");
  });

  it("a reversed charge and its reversal drop out of the allocation", () => {
    const c1 = row("charge", 100, 1);
    const c2 = row("charge", 100, 2);
    const r1 = row("reversal", -100, 3, { reversesEntryId: c1.id });
    const p = row("payment", -100, 4);
    const result = itemize([c1, c2, r1, p]);
    expect(result).toMatchObject({ balanceSek: 0, owedSek: 0, creditSek: 0 });
    expect(byId(result, c1.id)).toMatchObject({
      status: "reversed",
      allocatedSek: 0,
      outstandingSek: 0,
    });
    expect(byId(result, r1.id)).toMatchObject({
      status: "reversal",
      allocatedSek: 0,
      outstandingSek: 0,
    });
    expect(byId(result, c2.id).status).toBe("paid");
  });

  it("a reversed payment puts the debt back", () => {
    const c = row("charge", 100, 1);
    const p = row("payment", -100, 2);
    const r = row("reversal", 100, 3, { reversesEntryId: p.id });
    const result = itemize([c, p, r]);
    expect(result).toMatchObject({ balanceSek: 100, owedSek: 100, creditSek: 0 });
    expect(byId(result, c.id)).toMatchObject({ status: "unpaid", outstandingSek: 100 });
  });

  it("adjustments join the pool by sign", () => {
    const c = row("charge", 100, 1);
    const waiver = row("adjustment", -40, 2, { reason: "waiver" });
    const opening = row("adjustment", 25, 3, { reason: "opening_balance" });
    const result = itemize([c, waiver, opening]);
    expect(result).toMatchObject({ balanceSek: 85, owedSek: 85, creditSek: 0 });
    expect(byId(result, c.id)).toMatchObject({ allocatedSek: 40, outstandingSek: 60 });
    expect(byId(result, opening.id)).toMatchObject({ allocatedSek: 0, outstandingSek: 25 });
  });

  it("an empty ledger is zero", () => {
    expect(itemize([])).toEqual({ balanceSek: 0, owedSek: 0, creditSek: 0, items: [] });
  });

  it("a reversal that does not cancel its target exactly stays a plain entry (balance is still the sum)", () => {
    const c = row("charge", 100, 1);
    const odd = row("reversal", -60, 2, { reversesEntryId: c.id });
    const result = itemize([c, odd]);
    expect(result.balanceSek).toBe(40);
    expect(byId(result, c.id).status).toBe("partly_paid");
  });
});
