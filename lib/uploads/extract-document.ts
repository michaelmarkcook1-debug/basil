/**
 * lib/uploads/extract-document.ts — a document → its text.
 *
 * PDF (unpdf), Word .docx (mammoth), and plain-text kinds read directly.
 * Caption files (.vtt / .srt — a Zoom, Teams or Meet transcript download)
 * come back as timestamped segments, so they read like a transcribed recording
 * without any transcription cost.
 */
import "server-only";
import { looksLikeCaptions, parseCaptions, type Segment } from "./shape";

export async function extractDocument(
  buf: Buffer,
  filename: string,
  contentType: string,
): Promise<{ text?: string; segments?: Segment[] }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf") || contentType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const t = (Array.isArray(text) ? text.join("\n\n") : text).trim();
    if (!t) throw new Error("This PDF has no text layer (it may be a scan) — Basil can't read it yet.");
    return { text: t };
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value.trim() };
  }
  const raw = buf.toString("utf8");
  if (looksLikeCaptions(filename, raw)) {
    const segments = parseCaptions(raw);
    if (segments.length) return { segments };
  }
  if (/\.html?$/.test(lower) || contentType === "text/html") {
    return { text: raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
  }
  if (lower.endsWith(".rtf")) {
    return { text: raw.replace(/\\par[d]?/g, "\n").replace(/\{\*?\\[^{}]+\}|[{}]|\\[a-z]+-?\d* ?/gi, "").trim() };
  }
  return { text: raw.trim() };
}
