/** Per-area feature flags (PLAN §11.5). `FLAG_EVENTS=on` → `{ events: true }`. */
export type FeatureFlags = Record<string, boolean>;

const FLAG_PREFIX = "FLAG_";
const ON = new Set(["on", "true", "1"]);

/**
 * Reads only `FLAG_*` string vars, so no other binding or secret reaches the client.
 * Fails closed: any value other than on/true/1 is off.
 */
export function flagsFromEnv(env: Readonly<Record<string, unknown>>): FeatureFlags {
  const flags: FeatureFlags = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(FLAG_PREFIX) || typeof value !== "string") continue;
    flags[name.slice(FLAG_PREFIX.length).toLowerCase()] = ON.has(value.trim().toLowerCase());
  }
  return flags;
}
