import { apiFetch } from "../../api/client";

export type ResultsVisibility = "always" | "after_vote" | "after_close" | "admins";

export interface PollResultOption {
  readonly optionId: string;
  readonly votes: number;
  /** Absent on anonymous polls: the server never sends voter identities for them. */
  readonly voters?: ReadonlyArray<{ readonly memberId: string; readonly displayName: string }>;
}

export interface Poll {
  readonly id: string;
  readonly question: string;
  readonly multiChoice: boolean;
  readonly anonymous: boolean;
  readonly resultsVisibility: ResultsVisibility;
  /** ISO 8601, UTC, or null for no closing date. */
  readonly closesAt: string | null;
  readonly closed: boolean;
  readonly createdAt: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly myVote: readonly string[];
  readonly resultsVisible: boolean;
  readonly results: {
    readonly totalVoters: number;
    readonly options: readonly PollResultOption[];
  } | null;
}

export interface NewPoll {
  readonly question: string;
  readonly options: readonly string[];
  readonly multiChoice: boolean;
  readonly anonymous: boolean;
  readonly resultsVisibility: ResultsVisibility;
  readonly closesAt: string | null;
}

export async function listPolls(): Promise<Poll[]> {
  return (await apiFetch<{ polls: Poll[] }>("/polls")).polls;
}

export async function getPoll(id: string): Promise<Poll> {
  return (await apiFetch<{ poll: Poll }>(`/polls/${encodeURIComponent(id)}`)).poll;
}

export async function vote(id: string, optionIds: readonly string[]): Promise<Poll> {
  return (
    await apiFetch<{ poll: Poll }>(`/polls/${encodeURIComponent(id)}/vote`, {
      method: "PUT",
      body: { optionIds },
    })
  ).poll;
}

export async function createPoll(input: NewPoll): Promise<Poll> {
  return (await apiFetch<{ poll: Poll }>("/polls", { method: "POST", body: input })).poll;
}

export async function closePoll(id: string): Promise<Poll> {
  return (
    await apiFetch<{ poll: Poll }>(`/polls/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { close: true },
    })
  ).poll;
}

export function deletePoll(id: string): Promise<void> {
  return apiFetch(`/polls/${encodeURIComponent(id)}`, { method: "DELETE" });
}
