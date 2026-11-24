/** Pure helpers for turning a Clerk user into a Member row. */

export interface ClerkEmailAddress {
  id: string;
  emailAddress: string;
  verification: { status: string } | null;
}

export interface ClerkUserLike {
  primaryEmailAddressId: string | null;
  emailAddresses: readonly ClerkEmailAddress[];
}

/**
 * The primary email, lower-cased, only if Clerk verified it. An unverified address must
 * never grant the bootstrap admin role.
 */
export function primaryVerifiedEmail(user: ClerkUserLike): string | null {
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  return primary?.verification?.status === "verified" ? primary.emailAddress.toLowerCase() : null;
}

/** Case-insensitive match against BOOTSTRAP_ADMIN_EMAIL. Missing or empty never matches. */
export function isBootstrapEmail(
  email: string | null | undefined,
  bootstrap: string | null | undefined,
): boolean {
  const a = email?.trim().toLowerCase();
  const b = bootstrap?.trim().toLowerCase();
  return !!a && !!b && a === b;
}

export function displayNameFor(input: { name: string | null; email: string | null }): string {
  const name = input.name?.trim();
  if (name) return name;
  const local = input.email?.split("@")[0]?.trim();
  return local ? local : "New member";
}

// No 0/1/I/O: the reference is read aloud and typed into a bank transfer.
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short unique-enough payment reference, e.g. BC-K7X2QM. The column is unique anyway. */
export function newPaymentRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `BC-${Array.from(bytes, (b) => REF_ALPHABET.charAt(b % REF_ALPHABET.length)).join("")}`;
}
