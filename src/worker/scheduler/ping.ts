const PING_TIMEOUT_MS = 5_000;

/**
 * Pings the healthchecks.io dead-man switch (PLAN §11.1). `HEALTHCHECK_PING_URL` is an
 * optional secret; unset means no ping. A failed ping never fails the tick.
 */
export async function pingHealthcheck(
  env: { HEALTHCHECK_PING_URL?: string },
  outcome: "success" | "fail",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = env.HEALTHCHECK_PING_URL;
  if (!base) return;
  const url = outcome === "fail" ? `${base.replace(/\/+$/, "")}/fail` : base;
  try {
    await fetchImpl(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  } catch {
    // The dead-man switch alerts on silence, so a lost ping is its own signal.
  }
}
