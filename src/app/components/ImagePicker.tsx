import { getToken } from "@clerk/react";
import { useEffect, useState, type ChangeEvent } from "react";

import { useAuthEnabled } from "../auth/AuthProvider";
import { Button } from "./ui";
import "./ImagePicker.css";

/** Maximum uploaded image size in bytes (300 KB, PLAN §10). */
export const MAX_IMAGE_BYTES = 300 * 1024;

const ALLOWED_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PASS_DIMENSION = 1600;
const DIMENSION_STEPS = [1200, 900, 640, 480] as const;
const QUALITY_STEPS = [0.85, 0.72, 0.58, 0.42] as const;

export interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

export interface ResizeDeps {
  readonly decode?: (file: Blob) => Promise<DecodedBitmap | null>;
  readonly createCanvas?: () => HTMLCanvasElement;
}

async function defaultDecode(file: Blob): Promise<DecodedBitmap | null> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  }
  return null;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

/**
 * Resizes and compresses an image on the client so it stays at or below 300 KB.
 * Preserves small animated GIFs and images already within size and dimension budgets.
 */
export async function resizeImageToFit(file: Blob, deps: ResizeDeps = {}): Promise<Blob> {
  if (file.type === "image/gif" && file.size <= MAX_IMAGE_BYTES) {
    return file;
  }
  const decode = deps.decode ?? defaultDecode;
  const bitmap = await decode(file);
  if (!bitmap) {
    if (file.size <= MAX_IMAGE_BYTES) return file;
    throw new Error("Image could not be resized under 300 KB.");
  }

  try {
    if (
      file.size <= MAX_IMAGE_BYTES &&
      bitmap.width <= MAX_PASS_DIMENSION &&
      bitmap.height <= MAX_PASS_DIMENSION
    ) {
      return file;
    }

    const createCanvas =
      deps.createCanvas ??
      (() => {
        if (typeof document === "undefined") {
          throw new Error("Canvas is unavailable in this environment.");
        }
        return document.createElement("canvas");
      });

    const canvas = createCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable.");

    const formats = ["image/webp", "image/jpeg"] as const;
    for (const maxDim of DIMENSION_STEPS) {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height, 1));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);

      for (const mime of formats) {
        for (const quality of QUALITY_STEPS) {
          const blob = await canvasToBlob(canvas, mime, quality);
          if (blob && blob.size <= MAX_IMAGE_BYTES) {
            return blob;
          }
        }
      }
    }
    throw new Error("Image could not be compressed under 300 KB.");
  } finally {
    bitmap.close?.();
  }
}

export interface PickedImage {
  readonly key: string;
  readonly url: string;
  readonly previewUrl?: string;
}

export interface ImagePickerProps {
  readonly label: string;
  readonly value: PickedImage | null;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onChange: (next: PickedImage | null) => void;
  readonly onUpload: (blob: Blob) => Promise<{ key: string; url: string }>;
}

function removeLabelFor(label: string): string {
  const lower = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return `Remove ${lower}`;
}

export function ImagePicker({
  label,
  value,
  disabled = false,
  disabledReason,
  onChange,
  onUpload,
}: ImagePickerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError(null);
    if (!ALLOWED_INPUT_TYPES.has(file.type)) {
      setError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }

    setBusy(true);
    try {
      const resized = await resizeImageToFit(file);
      const uploaded = await onUpload(resized);
      let previewUrl = uploaded.url;
      if (typeof URL.createObjectURL === "function") {
        try {
          previewUrl = URL.createObjectURL(resized);
        } catch {
          // jsdom/restricted environments may not support Blob URL creation.
        }
      }
      onChange({ key: uploaded.key, url: uploaded.url, previewUrl });
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "Could not upload image.");
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="bcq-image-picker bcq-image-picker--attached">
        <img src={value.previewUrl ?? value.url} alt="" className="bcq-image-picker__thumb" />
        <Button
          variant="ghost"
          aria-label={removeLabelFor(label)}
          onClick={() => {
            if (
              value.previewUrl?.startsWith("blob:") &&
              typeof URL.revokeObjectURL === "function"
            ) {
              URL.revokeObjectURL(value.previewUrl);
            }
            onChange(null);
          }}
        >
          Remove image
        </Button>
      </div>
    );
  }

  return (
    <div className="bcq-image-picker">
      <label
        className={`bcq-image-picker__trigger${disabled || busy ? " bcq-image-picker__trigger--disabled" : ""}`}
      >
        <span>{busy ? "Uploading image…" : "Add image"}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="bcq-visually-hidden"
          aria-label={label}
          disabled={disabled || busy}
          onChange={(e) => {
            void handleFile(e);
          }}
        />
      </label>
      {disabled && disabledReason ? (
        <span className="bcq-image-picker__hint">{disabledReason}</span>
      ) : null}
      {busy ? (
        <span role="status" className="bcq-visually-hidden">
          Uploading image
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="bcq-image-picker__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AuthedMemberImage({
  src,
  alt,
  className,
}: {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    void (async () => {
      try {
        const token = await getToken().catch(() => null);
        const headers = new Headers();
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const res = await globalThis.fetch(src, { headers });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the effect cleanup.
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the effect cleanup.
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        // Leave unloaded if offline or unauthorized.
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  if (!objectUrl) return null;
  return <img src={objectUrl} alt={alt} className={className} loading="lazy" />;
}

/**
 * Renders a member-only `/media/{key}` image. In Clerk sessions it attaches the
 * Bearer token and resolves an object URL; in unconfigured/test mode it loads directly.
 */
export function MemberImage({
  src,
  alt = "",
  className,
}: {
  readonly src: string;
  readonly alt?: string;
  readonly className?: string;
}) {
  const authEnabled = useAuthEnabled();
  if (!authEnabled) {
    return <img src={src} alt={alt} className={className} loading="lazy" />;
  }
  return (
    <AuthedMemberImage src={src} alt={alt} {...(className !== undefined ? { className } : {})} />
  );
}
