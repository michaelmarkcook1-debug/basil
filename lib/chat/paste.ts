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

/**
 * What a paste should do: attach files, or put text in at the cursor.
 *
 * An image copied as a file (a screenshot file copied in Finder or on the
 * desktop) brings its file name as text too, and an image copied from a web
 * page or Slack can bring its address. Until 2026-11-10 any text won, so those
 * pastes dropped "Screenshot … .png" or a URL into the box and lost the
 * picture. Now text that only names the files, or is a bare link, gives way to
 * the files. Real text still wins: a spreadsheet range copies as text AND a
 * picture of itself, and the text is what was meant.
 */
export function pasteAction(cd: ClipboardLike, now = new Date()): { files: File[] } | { text: string } | null {
  const text = pastedText(cd);
  const files = pastedFiles(cd, now);
  if (files.length > 0 && (!text.trim() || onlyNamesOrLink(text, cd))) return { files };
  if (text) return { text };
  return null;
}

/** The clipboard's own names for its files (before pastedFiles renames "image.png"). */
function clipboardFileNames(cd: ClipboardLike): string[] {
  const names: string[] = [];
  for (const item of Array.from(cd.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f?.name) names.push(f.name);
  }
  return names;
}

function onlyNamesOrLink(text: string, cd: ClipboardLike): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const names = new Set(clipboardFileNames(cd).map((n) => n.toLowerCase()));
  const base = (l: string) => l.split(/[\\/]/).pop()!.toLowerCase();
  if (lines.every((l) => names.has(l.toLowerCase()) || names.has(base(l)))) return true;
  return lines.length === 1 && /^(https?:\/\/|file:\/\/)\S+$/i.test(lines[0]);
}
