/** 32 URL-safe characters (no `l` or `o`), so `byte & 31` picks one without modulo bias. */
export const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
/** 10 characters is about 50 bits: unguessable, and well over the 8 PLAN §5.1 asks for. */
export const SLUG_LENGTH = 10;
const MAX_ATTEMPTS = 5;

/** A random share slug for an event or a series. */
export function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  return Array.from(bytes, (byte) => SLUG_ALPHABET.charAt(byte & 31)).join("");
}

/** Draws slugs until `isTaken` says one is free. Collisions are astronomically rare, so this stays short. */
export async function uniqueSlug(isTaken: (slug: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const slug = randomSlug();
    if (!(await isTaken(slug))) return slug;
  }
  throw new Error("could not find a free share slug");
}
