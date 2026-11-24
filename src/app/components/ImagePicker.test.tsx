import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImagePicker, MAX_IMAGE_BYTES, resizeImageToFit } from "./ImagePicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("resizeImageToFit", () => {
  it("keeps small valid images under 300 KB without blowing up in jsdom", async () => {
    const small = new File([new Uint8Array(1024)], "small.png", { type: "image/png" });
    const result = await resizeImageToFit(small);
    expect(result.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it("resizes and compresses an oversized image down to <= 300 KB", async () => {
    const oversized = new File([new Uint8Array(MAX_IMAGE_BYTES + 50_000)], "big.jpg", {
      type: "image/jpeg",
    });

    const blobStub = new Blob([new Uint8Array(120_000)], { type: "image/webp" });
    const fakeCtx = { drawImage: vi.fn() };
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => fakeCtx),
      toBlob: vi.fn((cb: (b: Blob | null) => void) => {
        cb(blobStub);
      }),
    };
    const fakeBitmap = { width: 2400, height: 1800, close: vi.fn() };

    const out = await resizeImageToFit(oversized, {
      decode: () => Promise.resolve(fakeBitmap),
      createCanvas: () => fakeCanvas as unknown as HTMLCanvasElement,
    });

    expect(out.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(fakeCtx.drawImage).toHaveBeenCalled();
    expect(fakeBitmap.close).toHaveBeenCalled();
  });
});

describe("ImagePicker", () => {
  it("rejects non-image files without calling onUpload", async () => {
    const onUpload = vi.fn();
    const onChange = vi.fn();
    render(<ImagePicker label="Image for option 1" value={null} onChange={onChange} onUpload={onUpload} />);

    const input = screen.getByLabelText("Image for option 1");
    const txt = new File(["not an image"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [txt] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/jpeg, png, webp, or gif/i);
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("uploads an image, shows a preview, and allows removing it", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-1"),
      revokeObjectURL: vi.fn(),
    });
    const onUpload = vi.fn(() => Promise.resolve({ key: "med_1.png", url: "/media/med_1.png" }));
    const onChange = vi.fn();
    const { rerender } = render(
      <ImagePicker label="Image for option 1" value={null} onChange={onChange} onUpload={onUpload} />,
    );

    const input = screen.getByLabelText("Image for option 1");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "kit.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledTimes(1);
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: "med_1.png", url: "/media/med_1.png" }),
    );

    rerender(
      <ImagePicker
        label="Image for option 1"
        value={{ key: "med_1.png", url: "/media/med_1.png", previewUrl: "blob:preview-1" }}
        onChange={onChange}
        onUpload={onUpload}
      />,
    );

    const removeBtn = screen.getByRole("button", { name: /remove image/i });
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("disables adding an image when the 8-image limit is reached", () => {
    render(
      <ImagePicker
        label="Image for option 9"
        value={null}
        disabled
        disabledReason="Maximum 8 images per poll"
        onChange={vi.fn()}
        onUpload={vi.fn()}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Image for option 9");
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/maximum 8 images per poll/i)).toBeTruthy();
  });
});
