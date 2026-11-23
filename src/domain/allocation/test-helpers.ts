import type { Candidate, GuestCandidate, MemberCandidate } from "./types";

export function member(id: string, tier: 1 | 2, requestedAt: number): MemberCandidate {
  return { kind: "member", id, tier, requestedAt };
}

export function guest(id: string, hostId: string, requestedAt: number): GuestCandidate {
  return { kind: "guest", id, hostId, tier: 3, requestedAt };
}

export function ids(list: readonly Candidate[]): string[] {
  return list.map((candidate) => candidate.id);
}
