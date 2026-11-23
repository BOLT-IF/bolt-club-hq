/** Header a test client sends to act as a given Clerk user id. */
export const TEST_IDENTITY_HEADER = "X-Test-Identity";

/**
 * Test-identity override (PLAN §11.5). Only honoured when ENV is "test". When a
 * header is sent under any other ENV, this throws, so a misconfigured deploy
 * can never impersonate a user. No header returns null (use the real Clerk JWT).
 */
export function testIdentityFromRequest(env: { ENV: string }, request: Request): string | null {
  const value = request.headers.get(TEST_IDENTITY_HEADER);
  if (value === null) return null;
  if (env.ENV !== "test") {
    throw new Error(`${TEST_IDENTITY_HEADER} is only allowed when ENV=test (got ENV=${env.ENV})`);
  }
  return value;
}
