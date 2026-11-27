import { event, pass, rsvp, series, seriesCaptain, term } from "../../../db/schema";
import type { Db, Tx } from "../core/db/client";

let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${String(++counter)}_${crypto.randomUUID().slice(0, 8)}`;

/** Local fixtures for the broadcast tests (the shared factories are not part of this story's Owns). */
export async function makeSeries(db: Db | Tx): Promise<string> {
  const termId = nextId("term");
  await db.insert(term).values({
    id: termId,
    name: "Spring",
    startsOn: "2027-01-01",
    endsOn: "2027-06-01",
    status: "active",
  });
  const id = nextId("ser");
  await db.insert(series).values({
    id,
    termId,
    name: "Monday MD",
    format: "MD",
    weekday: 1,
    startTime: "19:00",
    durationMin: 90,
    capacity: 12,
    passPrice: 800,
    adhocFee: 100,
    shareSlug: `slug_${id}`,
    passCap: 10,
  });
  return id;
}

export async function makeCaptain(db: Db | Tx, seriesId: string, memberId: string): Promise<void> {
  await db.insert(seriesCaptain).values({ seriesId, memberId });
}

export async function makePass(
  db: Db | Tx,
  memberId: string,
  seriesId: string,
  status: "active" | "revoked" = "active",
): Promise<void> {
  await db.insert(pass).values({
    id: nextId("pass"),
    memberId,
    seriesId,
    priceCharged: 800,
    eventsCovered: 10,
    status,
    purchasedAt: new Date("2027-01-02T00:00:00Z"),
  });
}

export async function makeEvent(
  db: Db | Tx,
  createdBy: string,
  seriesId?: string,
): Promise<{ id: string; shareSlug: string }> {
  const id = nextId("evt");
  const shareSlug = `slug_${id}`;
  await db.insert(event).values({
    id,
    seriesId: seriesId ?? null,
    kind: seriesId ? "series" : "admin_oneoff",
    createdBy,
    title: "Monday session",
    format: "MD",
    startsAt: new Date("2027-02-01T18:00:00Z"),
    endsAt: new Date("2027-02-01T19:30:00Z"),
    capacity: 12,
    adhocFee: 100,
    rsvpCloseAt: new Date("2027-01-31T18:00:00Z"),
    allocationMode: "tiered",
    shareSlug,
  });
  return { id, shareSlug };
}

export async function makeRsvp(
  db: Db | Tx,
  eventId: string,
  memberId: string,
  status:
    | "requested"
    | "confirmed"
    | "waitlisted"
    | "offered"
    | "cancelled"
    | "late_cancelled"
    | "declined",
): Promise<void> {
  await db.insert(rsvp).values({
    id: nextId("rsvp"),
    eventId,
    memberId,
    status,
    tier: 1,
    requestedAt: new Date("2027-01-20T10:00:00Z"),
  });
}
