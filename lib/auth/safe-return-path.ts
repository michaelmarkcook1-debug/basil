/**
 * Where to send someone back to after an OAuth round trip — only ever a path
 * on this site.
 *
 * The Zoom callback checked `startsWith("/") && !startsWith("//")`, which
 * "/\evil.com" passes; browsers and `new URL("/\\evil.com", base)` read the
 * backslash as a slash and land off-site (found 2026-11-10). A single leading
 * "/", then no "/" or "\" next, no backslash anywhere, no control characters.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  if (!/^\/(?![/\\])/.test(raw)) return null;
  if (raw.includes("\\")) return null;
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  return raw;
}
