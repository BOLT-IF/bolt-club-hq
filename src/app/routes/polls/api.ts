import { API_BASE, ApiError, CLIENT_VERSION, apiFetch } from "../../api/client";
import { markClientOutdated } from "../../lib/clientVersion";

export type ResultsVisibility = "always" | "after_vote" | "after_close" | "admins";

export interface PollOption {
  readonly id: string;
  readonly label: string;
  readonly imageUrl?: string | null;
}

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
  readonly options: readonly PollOption[];
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
  readonly optionImages?: readonly (string | null)[];
  readonly multiChoice: boolean;
  readonly anonymous: boolean;
  readonly resultsVisibility: ResultsVisibility;
  readonly closesAt: string | null;
}

export interface UploadedMedia {
  readonly key: string;
  readonly url: string;
}

export async function uploadPollImage(
  blob: Blob,
  getAuthToken?: () => Promise<string | null>,
): Promise<UploadedMedia> {
  const headers = new Headers({
    Accept: "application/json",
    "X-Client-Version": CLIENT_VERSION,
  });
  if (getAuthToken) {
    const token = await getAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const form = new FormData();
  form.append("file", blob, "option-image");
  const response = await globalThis.fetch(`${API_BASE}/media`, {
    method: "POST",
    headers,
    body: form,
  });
  if (response.status === 426) {
    markClientOutdated();
  }
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep plain text error body.
    }
    throw new ApiError(response.status, parsed);
  }
  return (await response.json()) as UploadedMedia;
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
