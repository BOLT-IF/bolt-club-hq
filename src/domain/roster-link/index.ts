export const ROSTER_IMPORT_VERSION = 1 as const;
export const ROSTER_IMPORT_SOURCE = "bolt-club-hq" as const;
const MAX_FIELD_LEN = 120;

export interface RosterEventInput {
  readonly title: string;
  readonly startsAt: Date;
  readonly format?: string | null;
}

export interface RosterPlayerInput {
  readonly name: string;
  readonly rosterName?: string | null;
  readonly guest: boolean;
  readonly tier: number;
  readonly confirmedAt: Date;
  readonly sortId?: string;
}

export interface RosterImportV1Player {
  readonly name: string;
  readonly short: string;
  readonly guest: boolean;
}

export interface RosterImportV1Payload {
  readonly v: typeof ROSTER_IMPORT_VERSION;
  readonly source: typeof ROSTER_IMPORT_SOURCE;
  readonly event: {
    readonly title: string;
    readonly starts_at: string;
    readonly format?: string;
  };
  readonly players: readonly RosterImportV1Player[];
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

function resolveShortName(player: RosterPlayerInput): string {
  const raw =
    !player.guest && player.rosterName?.trim() ? player.rosterName.trim() : firstWord(player.name);
  return raw.slice(0, MAX_FIELD_LEN);
}

function formatUtcIso(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, "Z");
}

function comparePlayers(a: RosterPlayerInput, b: RosterPlayerInput): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const timeDiff = a.confirmedAt.getTime() - b.confirmedAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return (a.sortId ?? a.name).localeCompare(b.sortId ?? b.name);
}

/** Builds a `roster-import/v1` payload ordered by tier ascending, then confirmation time ascending. */
export function buildRosterImportPayload(
  event: RosterEventInput,
  players: readonly RosterPlayerInput[],
): RosterImportV1Payload {
  const sorted = [...players].sort(comparePlayers);
  const format = event.format?.trim();

  return {
    v: ROSTER_IMPORT_VERSION,
    source: ROSTER_IMPORT_SOURCE,
    event: {
      title: event.title.trim(),
      starts_at: formatUtcIso(event.startsAt),
      ...(format ? { format } : {}),
    },
    players: sorted.map((p) => ({
      name: p.name.trim().slice(0, MAX_FIELD_LEN),
      short: resolveShortName(p),
      guest: p.guest,
    })),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(encoded: string): Uint8Array {
  const padded = encoded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encodes a `roster-import/v1` payload as unpadded base64url UTF-8 JSON. */
export function encodeRosterImportPayload(payload: RosterImportV1Payload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decodes a `roster-import/v1` base64url fragment back into its JSON payload. */
export function decodeRosterImportFragment(fragment: string): RosterImportV1Payload {
  const json = new TextDecoder().decode(fromBase64Url(fragment));
  return JSON.parse(json) as RosterImportV1Payload;
}

/** Builds `{ROSTER_APP_URL}/planner#import=<base64url(JSON)>` from confirmed players. */
export function buildRosterImportUrl(
  rosterAppUrl: string,
  event: RosterEventInput,
  players: readonly RosterPlayerInput[],
): string {
  const base = rosterAppUrl.replace(/\/+$/, "");
  const payload = buildRosterImportPayload(event, players);
  return `${base}/planner#import=${encodeRosterImportPayload(payload)}`;
}

/** Plain-text fallback: one player name per line in roster order. */
export function formatRosterTextList(players: readonly RosterImportV1Player[]): string {
  return players.map((p) => p.name).join("\n");
}
