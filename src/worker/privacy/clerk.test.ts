import { describe, expect, it, vi } from "vitest";

import { ClerkDeleteError, createClerkUserDeleter } from "./clerk";

const envWithKey = { ENV: "test", CLERK_SECRET_KEY: "sk_test_123" } as unknown as Cloudflare.Env;
const envDevNoKey = { ENV: "dev" } as unknown as Cloudflare.Env;
const envProdNoKey = { ENV: "production" } as unknown as Cloudflare.Env;

describe("createClerkUserDeleter", () => {
  it("calls DELETE /v1/users/{clerkUserId} with Bearer token and succeeds on 200 or 404", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const deleter = createClerkUserDeleter(fetchMock);
    await deleter.deleteUser({ clerkUserId: "user_abc 123", env: envWithKey });
    await deleter.deleteUser({ clerkUserId: "user_gone", env: envWithKey });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.clerk.com/v1/users/user_abc%20123",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer sk_test_123" },
      }),
    );
  });

  it("skips sentinel clerkUserIds (erased: / preprovisioned:)", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const deleter = createClerkUserDeleter(fetchMock);
    await deleter.deleteUser({ clerkUserId: "erased:mem_1", env: envWithKey });
    await deleter.deleteUser({ clerkUserId: "preprovisioned:mem_2", env: envWithKey });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when CLERK_SECRET_KEY is unset in non-production, and throws in production", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const deleter = createClerkUserDeleter(fetchMock);
    await deleter.deleteUser({ clerkUserId: "user_1", env: envDevNoKey });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      deleter.deleteUser({ clerkUserId: "user_1", env: envProdNoKey }),
    ).rejects.toBeInstanceOf(ClerkDeleteError);
  });

  it("throws ClerkDeleteError on non-404 errors or network failure", async () => {
    const failStatus = createClerkUserDeleter(() =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );
    await expect(
      failStatus.deleteUser({ clerkUserId: "user_1", env: envWithKey }),
    ).rejects.toBeInstanceOf(ClerkDeleteError);

    const failNetwork = createClerkUserDeleter(() => Promise.reject(new Error("socket error")));
    await expect(
      failNetwork.deleteUser({ clerkUserId: "user_1", env: envWithKey }),
    ).rejects.toBeInstanceOf(ClerkDeleteError);
  });
});
