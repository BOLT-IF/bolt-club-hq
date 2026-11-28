/**
 * Ports: the seams between domain services and the outside world. Each port has
 * a production adapter (added by the story that owns it) and a recording fake
 * under src/worker/test-support/fakes.ts.
 */

import type { Tx } from "./db/client";

export interface CurrentMember {
  id: string;
  role: "member" | "admin";
  status: "pending" | "active" | "inactive" | "erased";
  /** Series this member captains (for the captain-of-series guard). */
  seriesIds: string[];
}

export interface NotifyPort {
  notify(input: {
    memberId: string;
    category: string;
    title: string;
    body: string;
    link?: string | null;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface PrepaidPort {
  isPrepaid(input: { memberId: string; eventId: string; tx?: Tx }): Promise<boolean>;
}

export interface ChargePort {
  charge(input: {
    memberId: string;
    amountSek: number;
    reason: string;
    idempotencyKey: string;
    eventId?: string | null;
    passId?: string | null;
    guestId?: string | null;
    note?: string;
  }): Promise<void>;
}

export interface ReversePort {
  reverse(input: { entryId: string; idempotencyKey: string }): Promise<void>;
}

export interface PublishOgPort {
  publishOg(input: { key: string; html: string }): Promise<void>;
}

export interface CurrentMemberPort {
  currentMember(input: { clerkUserId: string }): Promise<CurrentMember | null>;
}
