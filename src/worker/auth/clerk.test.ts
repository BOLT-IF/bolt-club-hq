import { beforeAll, describe, expect, it } from "vitest";

import { FixedClock } from "../core/clock";
import { createAuthenticator, frontendApiFromPublishableKey } from "./clerk";
import {
  TEST_FRONTEND_API,
  TEST_ISSUER,
  TEST_PUBLISHABLE_KEY,
  bearer,
  createTestSigner,
  jwksFetch,
  nowSeconds,
  type TestSigner,
} from "./test-jwt";

const env = {
  ENV: "test",
  CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
} as unknown as Cloudflare.Env;
const request = (headers?: HeadersInit) =>
  new Request("https://club.test/api/v1/me", headers ? { headers } : {});

describe("frontendApiFromPublishableKey", () => {
  it("decodes the Frontend API host from test and live keys", () => {
    expect(frontendApiFromPublishableKey(TEST_PUBLISHABLE_KEY)).toBe(TEST_FRONTEND_API);
    expect(frontendApiFromPublishableKey(`pk_live_${btoa("clerk.club.example$")}`)).toBe(
      "clerk.club.example",
    );
  });

  it("rejects anything that is not a publishable key", () => {
    expect(frontendApiFromPublishableKey("sk_test_abc")).toBeNull();
    expect(frontendApiFromPublishableKey("pk_test_!!!")).toBeNull();
    expect(frontendApiFromPublishableKey(`pk_test_${btoa("no-dollar")}`)).toBeNull();
    expect(frontendApiFromPublishableKey("")).toBeNull();
  });
});

describe("Clerk JWT verification (networkless, cached JWKS)", () => {
  let signer: TestSigner;
  beforeAll(async () => {
    signer = await createTestSigner();
  });

  function setup(
    signers: () => readonly TestSigner[] = () => [signer],
    clock = new FixedClock("2027-01-01T10:00:00Z"),
  ) {
    const jwks = jwksFetch(signers);
    return { jwks, clock, authenticate: createAuthenticator({ fetch: jwks.fetch, clock }) };
  }

  it("returns the Clerk user id for a valid token", async () => {
    const { authenticate } = setup();
    const token = await signer.sign({ sub: "user_abc" });
    expect(await authenticate(request(bearer(token)), env)).toBe("user_abc");
  });

  it("returns null without an Authorization header or with a non-bearer one", async () => {
    const { authenticate, jwks } = setup();
    expect(await authenticate(request(), env)).toBeNull();
    expect(await authenticate(request({ Authorization: "Basic abc" }), env)).toBeNull();
    expect(jwks.calls).toHaveLength(0);
  });

  it("returns null for an expired token", async () => {
    const { authenticate } = setup();
    const past = nowSeconds() - 3600;
    const token = await signer.sign({ iat: past - 60, nbf: past - 60, exp: past });
    expect(await authenticate(request(bearer(token)), env)).toBeNull();
  });

  it("returns null for a token from the wrong issuer", async () => {
    const { authenticate } = setup();
    const token = await signer.sign({ iss: "https://evil.example" });
    expect(await authenticate(request(bearer(token)), env)).toBeNull();
    expect(TEST_ISSUER).not.toBe("https://evil.example");
  });

  it("returns null for a token signed by a key that is not in the JWKS", async () => {
    const { authenticate } = setup();
    const other = await createTestSigner("ins_test_1"); // same kid, different key
    const token = await other.sign();
    expect(await authenticate(request(bearer(token)), env)).toBeNull();
  });

  it("returns null for garbage, and when the publishable key is not configured", async () => {
    const { authenticate } = setup();
    expect(await authenticate(request(bearer("not.a.jwt")), env)).toBeNull();
    const token = await signer.sign();
    const noKey = { ENV: "test" } as unknown as Cloudflare.Env;
    expect(await authenticate(request(bearer(token)), noKey)).toBeNull();
  });

  it("fetches the JWKS once and serves later requests from the cache", async () => {
    const { authenticate, jwks } = setup();
    for (let i = 0; i < 3; i++) {
      expect(await authenticate(request(bearer(await signer.sign())), env)).toBe("user_test_1");
    }
    expect(jwks.calls).toHaveLength(1);
  });

  it("refreshes once when a token carries an unknown kid (key rotation), at most once a minute", async () => {
    let keys: TestSigner[] = [signer];
    const rotated = await createTestSigner("ins_test_2");
    const { authenticate, jwks, clock } = setup(() => keys);

    expect(await authenticate(request(bearer(await signer.sign())), env)).toBe("user_test_1");
    expect(jwks.calls).toHaveLength(1);

    keys = [signer, rotated];
    clock.advance(61_000);
    expect(await authenticate(request(bearer(await rotated.sign())), env)).toBe("user_test_1");
    expect(jwks.calls).toHaveLength(2);

    // An attacker spraying unknown kids cannot force a refetch per request.
    const unknown = await createTestSigner("ins_unknown");
    for (let i = 0; i < 5; i++) {
      expect(await authenticate(request(bearer(await unknown.sign())), env)).toBeNull();
    }
    expect(jwks.calls.length).toBeLessThanOrEqual(3);
  });

  it("fails closed when the JWKS endpoint is down", async () => {
    const down = createAuthenticator({
      fetch: (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
      clock: new FixedClock("2027-01-01T10:00:00Z"),
    });
    expect(await down(request(bearer(await signer.sign())), env)).toBeNull();
  });
});
