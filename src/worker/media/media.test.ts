import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import type { Db } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { MAX_IMAGE_BYTES } from "./validate";

const BASE = "https://example.test";
const NOW = "2027-03-01T12:00:00.000Z";

const ACTORS = new Map<string, CurrentMember>([
  ["clerk_admin", { id: "m_admin", role: "admin", status: "active", seriesIds: [] }],
  ["clerk_member", { id: "m_alice", role: "member", status: "active", seriesIds: [] }],
  ["clerk_pending", { id: "m_pend", role: "member", status: "pending", seriesIds: [] }],
  ["clerk_inactive", { id: "m_exit", role: "member", status: "inactive", seriesIds: [] }],
]);

/** Minimal valid magic-byte payloads for each allowed image format. */
function pngBytes(extra = 0): Uint8Array {
  const out = new Uint8Array(16 + extra);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  ]);
}

function gifBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
}

function multipart(bytes: Uint8Array, filename: string, contentType: string): FormData {
  const form = new FormData();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append("file", new File([copy.buffer], filename, { type: contentType }));
  return form;
}

async function upload(clerk: string | null, body: BodyInit, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}/api/v1/media`, {
    method: "POST",
    headers: {
      ...(clerk ? { [TEST_IDENTITY_HEADER]: clerk } : {}),
      ...headers,
    },
    body,
  });
}

async function fetchMedia(clerk: string | null, key: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}/media/${key}`, {
    method: "GET",
    headers: {
      ...(clerk ? { [TEST_IDENTITY_HEADER]: clerk } : {}),
      ...headers,
    },
  });
}

describe("media upload and serving (S9.2)", () => {
  const uploadedKeys: string[] = [];

  beforeEach(() => {
    configureRequestDeps({
      db: () => Promise.resolve({} as Db),
      clock: new FixedClock(NOW),
      currentMember: () => ({
        currentMember: ({ clerkUserId }) => Promise.resolve(ACTORS.get(clerkUserId) ?? null),
      }),
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    if (uploadedKeys.length > 0) {
      await env.MEDIA.delete(uploadedKeys.splice(0));
    }
  });

  describe("upload validation: non-images and oversized files are rejected", () => {
    it("rejects non-image payloads including SVG, PDF, plain text, and spoofed Content-Type", async () => {
      const enc = new TextEncoder();
      const nonImages: Array<[Uint8Array, string, string]> = [
        [enc.encode("hello world"), "notes.txt", "text/plain"],
        [enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg", "image/svg+xml"],
        [enc.encode("%PDF-1.4\n%fake"), "doc.pdf", "application/pdf"],
        // Spoofed PNG header/filename with HTML bytes
        [enc.encode("<html>not a png</html>"), "evil.png", "image/png"],
      ];

      for (const [bytes, name, type] of nonImages) {
        const res = await upload("clerk_admin", multipart(bytes, name, type));
        expect(res.status, `expected 400 for ${name}`).toBe(400);
        const json = await res.json<{ error: string }>();
        expect(json.error).toBe("invalid_image_type");
      }
    });

    it("rejects empty files and requests without a file", async () => {
      const empty = await upload("clerk_admin", multipart(new Uint8Array(0), "empty.png", "image/png"));
      expect(empty.status).toBe(400);

      const missing = await upload("clerk_admin", new FormData());
      expect(missing.status).toBe(400);
    });

    it("rejects oversized files (> 300 KB)", async () => {
      const tooBig = pngBytes(MAX_IMAGE_BYTES + 1);
      const res = await upload("clerk_admin", multipart(tooBig, "huge.png", "image/png"));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "file_too_large" });
    });

    it("accepts JPEG, PNG, WebP, and GIF up to 300 KB and stores them in R2", async () => {
      const cases: Array<[Uint8Array, string, string]> = [
        [jpegBytes(), "photo.jpg", "image/jpeg"],
        [pngBytes(MAX_IMAGE_BYTES - 16), "exact.png", "image/png"],
        [webpBytes(), "pic.webp", "image/webp"],
        [gifBytes(), "anim.gif", "image/gif"],
      ];

      for (const [bytes, name, expectedMime] of cases) {
        const res = await upload("clerk_admin", multipart(bytes, name, "application/octet-stream"));
        expect(res.status, `upload failed for ${name}`).toBe(201);
        const body = await res.json<{ key: string; url: string; contentType: string; size: number }>();
        uploadedKeys.push(body.key);
        expect(body.url).toBe(`/media/${body.key}`);
        expect(body.contentType).toBe(expectedMime);
        expect(body.size).toBe(bytes.byteLength);

        const stored = await env.MEDIA.get(body.key);
        expect(stored).not.toBeNull();
        expect(stored?.httpMetadata?.contentType).toBe(expectedMime);
        const storedBytes = new Uint8Array(await stored!.arrayBuffer());
        expect(storedBytes).toEqual(bytes);
      }
    });
  });

  describe("members only", () => {
    it("only active admins can upload to POST /api/v1/media", async () => {
      const form = () => multipart(pngBytes(), "a.png", "image/png");
      expect((await upload(null, form())).status).toBe(401);
      expect((await upload("clerk_pending", form())).status).toBe(403);
      expect((await upload("clerk_inactive", form())).status).toBe(403);
      expect((await upload("clerk_member", form())).status).toBe(403);
    });

    it("/media/{key} serves images to active members only, with cache headers", async () => {
      const payload = webpBytes();
      const up = await upload("clerk_admin", multipart(payload, "kit.webp", "image/webp"));
      expect(up.status).toBe(201);
      const { key } = await up.json<{ key: string }>();
      uploadedKeys.push(key);

      expect((await fetchMedia(null, key)).status).toBe(401);
      expect((await fetchMedia("clerk_pending", key)).status).toBe(403);
      expect((await fetchMedia("clerk_inactive", key)).status).toBe(403);

      const memberRes = await fetchMedia("clerk_member", key);
      expect(memberRes.status).toBe(200);
      expect(memberRes.headers.get("Content-Type")).toBe("image/webp");
      expect(memberRes.headers.get("Cache-Control")).toContain("private");
      expect(memberRes.headers.get("Cache-Control")).toMatch(/max-age=\d+/);
      expect(memberRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const etag = memberRes.headers.get("ETag");
      expect(etag).toBeTruthy();
      expect(new Uint8Array(await memberRes.arrayBuffer())).toEqual(payload);

      const notModified = await fetchMedia("clerk_member", key, { "If-None-Match": etag! });
      expect(notModified.status).toBe(304);

      expect((await fetchMedia("clerk_member", "med_missing.webp")).status).toBe(404);
      expect((await fetchMedia("clerk_member", "..%2Fsecret.txt")).status).toBe(404);
    });
  });
});
