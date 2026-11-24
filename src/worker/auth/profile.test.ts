import { describe, expect, it } from "vitest";

import { createProfileLoader } from "./profile";

const env = { ENV: "test", CLERK_SECRET_KEY: "sk_test_x" } as unknown as Cloudflare.Env;

const user = {
  first_name: "Ada",
  last_name: "Lovelace",
  primary_email_address_id: "e1",
  email_addresses: [
    { id: "e1", email_address: "Ada@Club.test", verification: { status: "verified" } },
  ],
};

describe("createProfileLoader", () => {
  it("reads name and verified email from the Clerk Backend API with the secret key", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const load = createProfileLoader(((url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("Authorization") };
      return Promise.resolve(Response.json(user));
    }) as typeof fetch);
    expect(await load(env, "user_1")).toEqual({ email: "ada@club.test", name: "Ada Lovelace" });
    expect(seen).toEqual({
      url: "https://api.clerk.com/v1/users/user_1",
      auth: "Bearer sk_test_x",
    });
  });

  it("returns an empty profile without a secret key, and makes no call", async () => {
    const load = createProfileLoader((() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch);
    const bare = { ENV: "test" } as unknown as Cloudflare.Env;
    expect(await load(bare, "user_1")).toEqual({ email: null, name: null });
  });

  it("throws when Clerk answers with an error, so nothing is half-created", async () => {
    const load = createProfileLoader((() =>
      Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch);
    await expect(load(env, "user_1")).rejects.toThrow(/500/);
  });
});
