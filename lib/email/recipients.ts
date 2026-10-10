/**
 * Recipient fields typed into the reply composer (To / Cc / Bcc).
 */
import { parseAddressList, type Address } from "@/lib/google/gmail";

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * One field → addresses, or the entries that are not addresses.
 * Accepts "a@x.com, Name <b@y.com>" or an array of such strings.
 * Undefined/null means "not edited — use the default".
 */
export function parseRecipientField(v: unknown): { ok: true; list: Address[] | undefined } | { ok: false; bad: string[] } {
  if (v === undefined || v === null) return { ok: true, list: undefined };
  const raw = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(", ") : typeof v === "string" ? v : "";
  // Parse entry by entry: parseAddressList drops anything without an "@", and a
  // typo silently vanishing from the recipients is worse than an error.
  const list: Address[] = [];
  const bad: string[] = [];
  for (const entry of splitEntries(raw)) {
    const [a] = parseAddressList(entry);
    if (a && EMAIL_RE.test(a.email)) list.push({ name: a.name, email: a.email.toLowerCase() });
    else bad.push(entry);
  }
  return bad.length ? { ok: false, bad } : { ok: true, list };
}

/** Split on commas/semicolons outside quotes and <…>. */
function splitEntries(raw: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === "<") angle = true;
    if (ch === ">") angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((e) => e.trim()).filter(Boolean);
}
