/** Club settings as the API sees them (PLAN §5.1 ClubSettings). Money is whole kronor. */
export interface BankDetails {
  accountHolder?: string;
  iban?: string;
  bankgiro?: string;
}

export interface QuietHours {
  /** "HH:MM", 24 h, Stockholm time. */
  start: string;
  end: string;
}

/** Series/event defaults an admin can preset. All whole numbers. */
export const DEFAULT_KEYS = [
  "capacity",
  "durationMin",
  "passPrice",
  "adhocFee",
  "maxGuestsDefault",
  "rsvpCloseOffsetMin",
] as const;
export type DefaultKey = (typeof DEFAULT_KEYS)[number];

export interface ClubSettingsValue {
  clubName: string;
  bank: BankDetails | null;
  paymentInstructions: string | null;
  quietHours: QuietHours | null;
  passUnpaidRevokeDays: number;
  autoPromoteCutoffMin: number;
  defaults: Partial<Record<DefaultKey, number>>;
  accountCodes: Record<string, string>;
  rosterAppUrl: string | null;
}

/** Served before an admin has saved anything (PLAN A9, §5.1 defaults). */
export const DEFAULT_SETTINGS: ClubSettingsValue = {
  clubName: "Bolt Club",
  bank: null,
  paymentInstructions: null,
  quietHours: { start: "22:00", end: "08:00" },
  passUnpaidRevokeDays: 21,
  autoPromoteCutoffMin: 180,
  defaults: {},
  accountCodes: {},
  rosterAppUrl: null,
};

/** What an active member may see. Everything else (codes, rules, defaults) stays admin only. */
export type PublicSettings = Pick<
  ClubSettingsValue,
  "clubName" | "bank" | "paymentInstructions" | "quietHours" | "rosterAppUrl"
>;

export function toPublicSettings(settings: ClubSettingsValue): PublicSettings {
  return {
    clubName: settings.clubName,
    bank: settings.bank,
    paymentInstructions: settings.paymentInstructions,
    quietHours: settings.quietHours,
    rosterAppUrl: settings.rosterAppUrl,
  };
}
