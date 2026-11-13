/**
 * Guest field → bare email addresses, for creating and editing meetings.
 *
 * The day view's guest autocomplete inserts "Name <email>"; the create route
 * kept only bare addresses, so every guest picked from contacts was silently
 * dropped (found 2026-11-10). Pure and import-free: the client (DayView) and
 * the calendar routes both use it, so either side alone is enough.
 */

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "Name <a@b.com>" or "a@b.com" → "a@b.com"; anything else → null. */
export function attendeeEmail(entry: unknown): string | null {
  const s = String(entry ?? "").trim();
  const m = s.match(/<([^<>]+)>\s*$/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return EMAIL_RE.test(addr) ? addr : null;
}

/**
 * A list (or the comma-separated field text) → deduped addresses, plus the
 * entries that are not addresses, so a caller can refuse rather than drop them.
 */
export function parseAttendees(list: unknown): { emails: string[]; bad: string[] } {
  const items = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
  const emails = new Set<string>();
  const bad: string[] = [];
  for (const item of items) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const email = attendeeEmail(raw);
    if (email) emails.add(email);
    else bad.push(raw);
  }
  return { emails: Array.from(emails), bad };
}
