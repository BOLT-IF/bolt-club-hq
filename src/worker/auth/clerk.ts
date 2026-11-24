import { decodeJwt, verifyJwt } from "@clerk/backend/jwt";

import type { Clock } from "../core/clock";
import type { RequestDeps } from "../core/context";

/** Reads a Worker var or secret that is not in the generated `Env` type. */
export function envString(env: Cloudflare.Env, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * A Clerk publishable key is `pk_test_` or `pk_live_` followed by base64 of
 * "<frontend api host>$". Returns the host, or null when the key is not well formed.
 */
export function frontendApiFromPublishableKey(key: string): string | null {
  const match = /^pk_(?:test|live)_(.+)$/.exec(key);
  if (!match?.[1]) return null;
  try {
    const decoded = atob(match[1]);
    return decoded.endsWith("$") && decoded.length > 1 ? decoded.slice(0, -1) : null;
  } catch {
    return null;
  }
}

/** Unknown-kid refetches are throttled so forged tokens cannot make us hammer Clerk. */
export const JWKS_MIN_REFETCH_MS = 60_000;
/** Cached keys older than this are refreshed on next use (Clerk rotates rarely). */
export const JWKS_MAX_AGE_MS = 60 * 60_000;

interface JwksCache {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}

export interface AuthenticatorOptions {
  fetch?: typeof fetch;
  clock: Clock;
}

/**
 * Bearer-token verification without a call to Clerk per request (PLAN §11.5). The
 * instance's public keys are fetched from its Frontend API once, cached per isolate
 * and refreshed only on key rotation (unknown `kid`, at most once a minute) or after an
 * hour. Anything wrong with the token, the key or the network returns null (401).
 */
export function createAuthenticator(options: AuthenticatorOptions): RequestDeps["authenticate"] {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const caches = new Map<string, JwksCache>();
  const inflight = new Map<string, Promise<JwksCache | null>>();

  function refresh(frontendApi: string): Promise<JwksCache | null> {
    const pending = inflight.get(frontendApi);
    if (pending) return pending;
    const run = (async (): Promise<JwksCache | null> => {
      try {
        const res = await doFetch(`https://${frontendApi}/.well-known/jwks.json`);
        if (!res.ok) return null;
        const body = await res.json<{ keys?: (JsonWebKey & { kid?: string })[] }>();
        const keys = new Map<string, JsonWebKey>();
        for (const jwk of body.keys ?? []) if (jwk.kid) keys.set(jwk.kid, jwk);
        const fresh = { keys, fetchedAt: options.clock.now().getTime() };
        caches.set(frontendApi, fresh);
        return fresh;
      } catch {
        return null;
      } finally {
        inflight.delete(frontendApi);
      }
    })();
    inflight.set(frontendApi, run);
    return run;
  }

  async function keyFor(frontendApi: string, kid: string): Promise<JsonWebKey | null> {
    const now = options.clock.now().getTime();
    let cache = caches.get(frontendApi) ?? null;
    const age = cache ? now - cache.fetchedAt : Infinity;
    if (!cache || age > JWKS_MAX_AGE_MS) cache = (await refresh(frontendApi)) ?? cache;
    const hit = cache?.keys.get(kid);
    if (hit) return hit;
    if (cache && now - cache.fetchedAt >= JWKS_MIN_REFETCH_MS) {
      return (await refresh(frontendApi))?.keys.get(kid) ?? null;
    }
    return null;
  }

  return async (request, env) => {
    const header = request.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return null;
    const publishableKey = envString(env, "CLERK_PUBLISHABLE_KEY");
    const frontendApi = publishableKey ? frontendApiFromPublishableKey(publishableKey) : null;
    if (!frontendApi) return null;

    try {
      const kid = decodeJwt(token).header.kid;
      if (!kid) return null;
      const key = await keyFor(frontendApi, kid);
      if (!key) return null;
      const claims = await verifyJwt(token, { key, issuer: `https://${frontendApi}` });
      return claims.sub;
    } catch {
      return null;
    }
  };
}
