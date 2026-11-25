import { Hono, type Context } from "hono";

import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import type { AppEnv } from "../types";
import "./purge";
import { detectImageFormat, isValidMediaKey, MAX_IMAGE_BYTES } from "./validate";

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("media: guard let a request through without an actor");
  return actor;
}

async function readUploadBytes(
  c: Context<AppEnv>,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413; error: string }> {
  const contentLength = Number(c.req.header("Content-Length") ?? "0");
  // Multipart boundaries add minor overhead; reject clearly oversized payloads before buffering.
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 64 * 1024) {
    return { ok: false, status: 413, error: "file_too_large" };
  }

  const contentType = (c.req.header("Content-Type") ?? "").toLowerCase();
  let bytes: Uint8Array;
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") {
      return { ok: false, status: 400, error: "missing_file" };
    }
    const blob: Blob = file;
    if (blob.size === 0) return { ok: false, status: 400, error: "empty_file" };
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "file_too_large" };
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }

  if (bytes.byteLength === 0) return { ok: false, status: 400, error: "empty_file" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: "file_too_large" };
  }
  return { ok: true, bytes };
}

/**
 * `/api/v1/media` upload endpoint (auto-mounted by `src/worker/registry.ts`).
 * Admin only: checks real magic bytes (JPEG/PNG/WebP/GIF) and enforces <= 300 KB.
 */
export default new Hono<AppEnv>()
  .use("/media", contextMiddleware())
  .use("/media/*", contextMiddleware())
  .post("/media", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const read = await readUploadBytes(c);
    if (!read.ok) return c.json({ error: read.error }, read.status);

    const detected = detectImageFormat(read.bytes);
    if (!detected) return c.json({ error: "invalid_image_type" }, 400);

    const key = `med_${crypto.randomUUID()}.${detected.ext}`;
    await c.env.MEDIA.put(key, read.bytes, {
      httpMetadata: { contentType: detected.mimeType },
      customMetadata: {
        uploadedBy: actor.id,
        uploadedAt: c.var.clock.now().toISOString(),
      },
    });
    return c.json(
      {
        key,
        url: `/media/${key}`,
        contentType: detected.mimeType,
        size: read.bytes.byteLength,
      },
      201,
    );
  });

/**
 * `/media/:key` serving app (mounted outside `/api/v1` in `src/worker/app.ts`).
 * Active members only (`requireGuard("member")`), with private immutable cache headers.
 */
export function createMediaServeApp(): Hono<AppEnv> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- chained Hono builder.
  return new Hono<AppEnv>()
    .use("/media/*", contextMiddleware())
    .get("/media/:key", requireGuard("member"), async (c) => {
      const key = c.req.param("key");
      if (!isValidMediaKey(key)) return c.json({ error: "not_found" }, 404);

      const obj = await c.env.MEDIA.get(key);
      if (!obj) return c.json({ error: "not_found" }, 404);

      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch && obj.httpEtag && ifNoneMatch === obj.httpEtag) {
        return c.body(null, 304);
      }

      const headers = new Headers();
      headers.set("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
      headers.set("Cache-Control", "private, max-age=31536000, immutable");
      headers.set("X-Content-Type-Options", "nosniff");
      if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
      return new Response(obj.body, { status: 200, headers });
    });
}
