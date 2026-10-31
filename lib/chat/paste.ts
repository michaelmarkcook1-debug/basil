/**
 * What a paste into Ask Basil's message box carries (app/dashboard/chat).
 * Tested in tests/chat-paste.test.mjs.
 */

/** The minimum of a browser DataTransfer these helpers read. */
export interface ClipboardLike {
  getData(type: string): string;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
}

/** Turn copied HTML (some apps put nothing else on the clipboard) into plain text. */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text a paste carries, Windows line endings made plain. "" when none. */
export function pastedText(cd: ClipboardLike): string {
  const plain = cd.getData("text/plain");
  const text = plain || htmlToText(cd.getData("text/html"));
  return text.replace(/\r\n?/g, "\n");
}

const ATTACHABLE = /^(image\/|application\/pdf$|text\/|application\/json$)/;

/** Files a paste carries that Ask Basil can attach (images, PDFs, text). */
export function pastedFiles(cd: ClipboardLike, now = new Date()): File[] {
  const out: File[] = [];
  for (const item of Array.from(cd.items ?? [])) {
    if (item.kind !== "file" || !ATTACHABLE.test(item.type)) continue;
    const f = item.getAsFile();
    if (!f) continue;
    // A clipboard screenshot arrives as "image.png"; name it so the chip says what it is.
    const name = f.name && f.name !== "image.png" ? f.name : `pasted-${now.toISOString().replace(/[:.]/g, "-")}.png`;
    out.push(name === f.name ? f : new File([f], name, { type: f.type }));
  }
  return out;
}
