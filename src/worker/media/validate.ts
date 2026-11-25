/** Maximum allowed poll option image size in bytes (300 KB, PLAN §10). */
export const MAX_IMAGE_BYTES = 300 * 1024;

export interface DetectedImage {
  readonly ext: "jpg" | "png" | "webp" | "gif";
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Inspects real magic bytes for JPEG, PNG, WebP, or GIF. Rejects SVG, HTML, PDF,
 * plain text, and spoofed Content-Type headers.
 */
export function detectImageFormat(bytes: Uint8Array): DetectedImage | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.byteLength >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  return null;
}

const SAFE_KEY_RE = /^[A-Za-z0-9_-]+\.(jpg|png|webp|gif)$/;

/** Validates that a media key has a safe filename shape with no path traversal. */
export function isValidMediaKey(key: string): boolean {
  return key.length <= 128 && SAFE_KEY_RE.test(key);
}

/** Best-effort batch deletion of R2 media objects (chunked to R2's 1000-key batch limit). */
export async function deleteMediaKeys(
  bucket: Pick<R2Bucket, "delete"> | undefined | null,
  keys: readonly string[],
): Promise<void> {
  if (!bucket || keys.length === 0) return;
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 1000) {
    await bucket.delete(unique.slice(i, i + 1000));
  }
}
