import { envString } from "./clerk";
import { primaryVerifiedEmail, type ClerkUserLike } from "./members";

export interface ClerkProfile {
  email: string | null;
  name: string | null;
}

export type ProfileLoader = (env: Cloudflare.Env, clerkUserId: string) => Promise<ClerkProfile>;

interface ClerkUserResponse {
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: {
    id: string;
    email_address: string;
    verification?: { status?: string } | null;
  }[];
}

/**
 * Loads name and verified email from the Clerk Backend API. Called once, when a user
 * first signs in. Without CLERK_SECRET_KEY (dev, CI) it returns an empty profile; a
 * failing Clerk call throws, so no half-filled member is created and the client retries.
 */
export function createProfileLoader(fetchImpl: typeof fetch = fetch): ProfileLoader {
  return async (env, clerkUserId) => {
    const secret = envString(env, "CLERK_SECRET_KEY");
    if (!secret) return { email: null, name: null };
    const res = await fetchImpl(
      `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
    );
    if (!res.ok) throw new Error(`Clerk user lookup failed with status ${String(res.status)}`);
    const user = await res.json<ClerkUserResponse>();
    const like: ClerkUserLike = {
      primaryEmailAddressId: user.primary_email_address_id ?? null,
      emailAddresses: (user.email_addresses ?? []).map((e) => ({
        id: e.id,
        emailAddress: e.email_address,
        verification: e.verification?.status ? { status: e.verification.status } : null,
      })),
    };
    const name = [user.first_name, user.last_name]
      .filter((part): part is string => !!part?.trim())
      .join(" ");
    return { email: primaryVerifiedEmail(like), name: name || null };
  };
}
