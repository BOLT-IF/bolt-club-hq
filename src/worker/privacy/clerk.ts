export interface ClerkErasePort {
  deleteUser(input: { clerkUserId: string; env: Cloudflare.Env }): Promise<void>;
}

export class ClerkDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClerkDeleteError";
  }
}

function readSecret(env: Cloudflare.Env): string {
  const raw: unknown = Reflect.get(env, "CLERK_SECRET_KEY");
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Deletes a Clerk user via the Clerk Backend API (`DELETE /v1/users/{id}`).
 * A 404 means the user is already absent in Clerk and succeeds idempotently.
 * When `CLERK_SECRET_KEY` is unset in non-production (local dev / test without Clerk),
 * it becomes a no-op; in production a missing secret fails loudly.
 */
export function createClerkUserDeleter(fetchImpl: typeof fetch = fetch): ClerkErasePort {
  return {
    async deleteUser({ clerkUserId, env }) {
      if (clerkUserId.startsWith("erased:") || clerkUserId.startsWith("preprovisioned:")) {
        return;
      }
      const secret = readSecret(env);
      if (!secret) {
        const envName: unknown = Reflect.get(env, "ENV");
        if (envName === "production") {
          throw new ClerkDeleteError("CLERK_SECRET_KEY is required to delete a Clerk user");
        }
        return;
      }
      let res: Response;
      try {
        res = await fetchImpl(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${secret}` },
        });
      } catch (error) {
        throw new ClerkDeleteError(
          error instanceof Error ? error.message : "Clerk delete request failed",
        );
      }
      if (!res.ok && res.status !== 404) {
        throw new ClerkDeleteError(`Clerk user deletion failed with status ${String(res.status)}`);
      }
    },
  };
}

let port: ClerkErasePort = createClerkUserDeleter();

/** Overrides the Clerk user deletion port in tests. Call with `undefined` to restore default. */
export function configureClerkErase(next?: ClerkErasePort): void {
  port = next ?? createClerkUserDeleter();
}

export function getClerkErase(): ClerkErasePort {
  return port;
}
