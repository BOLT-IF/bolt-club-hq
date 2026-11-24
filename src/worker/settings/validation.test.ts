import { describe, expect, it } from "vitest";

import { toPublicSettings, DEFAULT_SETTINGS } from "./model";
import {
  isValidBankgiro,
  isValidIban,
  normalizeBankgiro,
  normalizeIban,
  normalizeRosterAppUrl,
  validateSettingsInput,
} from "./validation";

const valid = {
  clubName: "Bolt Club",
  passUnpaidRevokeDays: 21,
  autoPromoteCutoffMin: 180,
};

describe("IBAN", () => {
  it("accepts a valid Swedish IBAN with or without spaces and any case", () => {
    expect(isValidIban("SE4550000000058398257466")).toBe(true);
    expect(isValidIban("se45 5000 0000 0583 9825 7466")).toBe(true);
    expect(normalizeIban("se45 5000 0000 0583 9825 7466")).toBe("SE4550000000058398257466");
  });

  it("accepts a valid IBAN from another country", () => {
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
  });

  it("rejects a bad checksum, a bad length for SE, and junk", () => {
    expect(isValidIban("SE4550000000058398257467")).toBe(false);
    expect(isValidIban("SE45500000000583982574")).toBe(false);
    expect(isValidIban("not an iban")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });
});

describe("bankgiro", () => {
  it("accepts 7 and 8 digit numbers with a valid Luhn check digit and normalises the hyphen", () => {
    expect(isValidBankgiro("5402-9681")).toBe(true);
    expect(isValidBankgiro("54029681")).toBe(true);
    expect(normalizeBankgiro("54029681")).toBe("5402-9681");
    expect(isValidBankgiro("123-4566")).toBe(true);
    expect(normalizeBankgiro("1234566")).toBe("123-4566");
  });

  it("rejects a wrong check digit, wrong length and non-digits", () => {
    expect(isValidBankgiro("5402-9682")).toBe(false);
    expect(isValidBankgiro("123456")).toBe(false);
    expect(isValidBankgiro("123456789")).toBe(false);
    expect(isValidBankgiro("abcd-efgh")).toBe(false);
  });
});

describe("roster app URL", () => {
  it("accepts https and drops a trailing slash", () => {
    expect(normalizeRosterAppUrl("https://roster.example.se/")).toEqual({
      ok: true,
      value: "https://roster.example.se",
    });
    expect(normalizeRosterAppUrl("https://example.se/roster/")).toEqual({
      ok: true,
      value: "https://example.se/roster",
    });
  });

  it.each([
    "http://roster.example.se",
    "javascript:alert(1)",
    "ftp://roster.example.se",
    "https://user:pw@roster.example.se",
    "https://roster.example.se/?a=1",
    "https://roster.example.se/#frag",
    "roster.example.se",
    "not a url",
  ])("rejects %s", (url) => {
    expect(normalizeRosterAppUrl(url).ok).toBe(false);
  });
});

describe("validateSettingsInput", () => {
  it("accepts the minimum and fills optional parts with empty values", () => {
    const result = validateSettingsInput(valid);
    expect(result).toEqual({
      ok: true,
      value: {
        clubName: "Bolt Club",
        bank: null,
        paymentInstructions: null,
        quietHours: null,
        passUnpaidRevokeDays: 21,
        autoPromoteCutoffMin: 180,
        defaults: {},
        accountCodes: {},
        rosterAppUrl: null,
      },
    });
  });

  it("normalises bank details and requires at least one of IBAN or bankgiro", () => {
    const ok = validateSettingsInput({
      ...valid,
      bank: {
        accountHolder: " Bolt IF ",
        iban: "se45 5000 0000 0583 9825 7466",
        bankgiro: "54029681",
      },
    });
    expect(ok.ok && ok.value.bank).toEqual({
      accountHolder: "Bolt IF",
      iban: "SE4550000000058398257466",
      bankgiro: "5402-9681",
    });

    const empty = validateSettingsInput({ ...valid, bank: { accountHolder: "Bolt IF" } });
    expect(!empty.ok && empty.errors).toHaveProperty("bank");
  });

  it("reports each invalid field by name", () => {
    const result = validateSettingsInput({
      clubName: " ",
      bank: { iban: "SE4550000000058398257467", bankgiro: "1234567" },
      quietHours: { start: "25:00", end: "08:00" },
      passUnpaidRevokeDays: 0,
      autoPromoteCutoffMin: -5,
      defaults: { capacity: 1.5, adhocFee: -1, surprise: 1 },
      accountCodes: { "Bad Key": "3010" },
      rosterAppUrl: "http://insecure.example.se",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [
        "accountCodes",
        "autoPromoteCutoffMin",
        "bank.bankgiro",
        "bank.iban",
        "clubName",
        "defaults.adhocFee",
        "defaults.capacity",
        "defaults.surprise",
        "passUnpaidRevokeDays",
        "quietHours.start",
        "rosterAppUrl",
      ].sort(),
    );
  });

  it("requires club name and the two numeric rules", () => {
    const result = validateSettingsInput({});
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "autoPromoteCutoffMin",
      "clubName",
      "passUnpaidRevokeDays",
    ]);
  });

  it("rejects equal quiet-hour start and end, and non-object bodies", () => {
    const same = validateSettingsInput({ ...valid, quietHours: { start: "22:00", end: "22:00" } });
    expect(same.ok).toBe(false);
    expect(validateSettingsInput(null).ok).toBe(false);
    expect(validateSettingsInput("x").ok).toBe(false);
  });

  it("keeps money defaults as whole kronor integers", () => {
    const result = validateSettingsInput({ ...valid, defaults: { passPrice: 1200.5 } });
    expect(!result.ok && result.errors).toHaveProperty("defaults.passPrice");
  });
});

describe("toPublicSettings", () => {
  it("contains only the member-visible subset", () => {
    const pub = toPublicSettings({
      ...DEFAULT_SETTINGS,
      defaults: { capacity: 12 },
      accountCodes: { pass: "3010" },
      rosterAppUrl: "https://roster.example.se",
    });
    expect(Object.keys(pub).sort()).toEqual(
      ["bank", "clubName", "paymentInstructions", "quietHours", "rosterAppUrl"].sort(),
    );
  });
});
