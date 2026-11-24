import { signJwt } from "@clerk/backend/jwt";

/** Test-only Clerk fixtures: a throwaway RSA key pair, a JWKS response and token signing. */
export const TEST_FRONTEND_API = "clerk.bolt-test.example";
export const TEST_ISSUER = `https://${TEST_FRONTEND_API}`;
export const TEST_JWKS_URL = `${TEST_ISSUER}/.well-known/jwks.json`;
/** A Clerk publishable key is `pk_test_` + base64("<frontend api>$"). */
export const TEST_PUBLISHABLE_KEY = `pk_test_${btoa(`${TEST_FRONTEND_API}$`)}`;

export interface TestSigner {
  readonly kid: string;
  readonly publicJwk: JsonWebKey & { kid: string };
  sign(claims?: Partial<TestClaims>): Promise<string>;
}

export interface TestClaims {
  sub: string;
  iss: string;
  iat: number;
  nbf: number;
  exp: number;
}

/**
 * The JWT library checks exp/nbf against the real clock, so tokens are minted from real
 * time. (The injected Clock only drives the JWKS cache.)
 */
export function nowSeconds(): number {
  return Math.floor(new Date().getTime() / 1000);
}

export async function createTestSigner(kid = "ins_test_1"): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid,
    alg: "RS256",
    use: "sig",
  };
  return {
    kid,
    publicJwk,
    sign(claims = {}) {
      const iat = nowSeconds();
      const payload: TestClaims = {
        sub: "user_test_1",
        iss: TEST_ISSUER,
        iat,
        nbf: iat - 5,
        exp: iat + 60,
        ...claims,
      };
      return signJwt(payload as unknown as Record<string, unknown>, privateJwk, {
        algorithm: "RS256",
        header: { typ: "JWT", kid },
      });
    },
  };
}

/** A fetch stand-in that serves `signers`' public keys at the JWKS URL and counts calls. */
export function jwksFetch(signers: () => readonly TestSigner[]) {
  const calls: string[] = [];
  const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url !== TEST_JWKS_URL) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(
      Response.json({ keys: signers().map((s) => s.publicJwk) }, { status: 200 }),
    );
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

export function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}
