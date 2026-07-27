/**
 * lib/images/downscale.ts
 *
 * Client-side image downscaling for chat attachments. Browser-only — uses
 * canvas, so it must NOT be imported into a server module.
 *
 * WHY THIS EXISTS
 * Attachments are inlined into the request as base64 data URLs, and useChat
 * resends the WHOLE conversation every turn. So a single 3 MB screenshot became
 * ~4 MB of base64 on the first message AND on every message after it — which is
 * why Ask Basil appeared to break on plain text (a pasted URL) after an image:
 * the image was still riding along in history.
 *
 * Downscaling costs nothing in quality that the model would have used anyway:
 * Claude resizes anything over ~1568px on its long edge server-side, so sending
 * a 4000px screenshot spends bandwidth, tokens and money to deliver pixels that
 * are discarded on arrival.
 */

/** Claude's effective ceiling — larger is resized on their side regardless. */
const MAX_EDGE = 1568;
/** JPEG quality for re-encode. 0.82 is visually clean for UI screenshots. */
const QUALITY = 0.82;
/** Below this, re-encoding usually costs more bytes than it saves. */
const SKIP_BELOW_BYTES = 200_000;

/**
 * Downscale an image File if it is large. Returns the ORIGINAL file unchanged
 * when it is already small, is not an image, or if anything goes wrong —
 * degrading to "send what the user picked" rather than dropping their
 * attachment.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // SVGs are vector — rasterising them here would make them worse, not smaller.
  if (file.type === "image/svg+xml") return file;
  if (file.size <= SKIP_BELOW_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longEdge = Math.max(width, height);

    // Already within budget on dimensions — but still re-encode, because a
    // 2 MB PNG screenshot at 1200px is mostly wasted bytes.
    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", QUALITY)
    );
    if (!blob) return file;

    // If the re-encode somehow grew the file, keep the original.
    if (blob.size >= file.size) return file;

    const renamed = file.name.replace(/\.(png|webp|gif|bmp|tiff?)$/i, ".jpg");
    return new File([blob], renamed, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    // Never block the send on a downscale failure — the size guard on the
    // server is the backstop.
    return file;
  }
}

/** Human-readable size, for attachment chips and error copy. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
