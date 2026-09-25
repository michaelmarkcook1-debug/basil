/**
 * lib/security/sensitive.ts — keep credentials out of the assistant.
 *
 * A live audit (2026-09-15) found a temporary password repeated verbatim in a
 * cached meeting prep and a one-time verification code in an extracted
 * commitment. Nothing between the inbox and the screen had looked. The model
 * read raw email snippets, its output was accepted as-is, the result was
 * cached durably and then again in the browser, and every reopening of the
 * page restored it.
 *
 * This module is the one place that looks. It is deliberately dependency-free
 * so it can run in server routes, storage layers and client components alike.
 *
 *   redactSensitive(text)  — one string → same string with values replaced
 *   redactDeep(value)      — any JSON-shaped value, every string inside it
 *   containsSensitive(t)   — cheap check for guards and tests
 *
 * Placeholders keep the KIND ("[redacted password]") so a reader knows what was
 * there without being able to use it. Values are never logged, never returned
 * and never kept — only counts.
 *
 * Precision matters more than recall here: "reset your password" must survive,
 * "password: hunter22" must not. Every pattern therefore requires a VALUE, not
 * just a keyword.
 */

export type SensitiveKind = "password" | "code" | "token" | "url-secret" | "key";

export interface Redaction {
  kind: SensitiveKind;
}

export interface RedactedText {
  text: string;
  redactions: Redaction[];
  count: number;
}

const placeholder = (kind: SensitiveKind) => `[redacted ${kind}]`;

// ── Patterns ─────────────────────────────────────────────────────────────────
//
// Each entry: a regex with ONE capture group for the value to replace (the rest
// of the match is preserved), and the kind it records. Order matters — earlier
// entries claim their text first.

interface Rule { kind: SensitiveKind; re: RegExp }

const RULES: Rule[] = [
  // Known token shapes. These are unambiguous on their own.
  { kind: "token", re: /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})\b/g },              // OpenAI / Anthropic
  { kind: "token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g },                   // GitHub
  { kind: "token", re: /\b(xox[abposre]-[A-Za-z0-9-]{10,})\b/g },              // Slack
  { kind: "token", re: /\b(AKIA[0-9A-Z]{16})\b/g },                             // AWS access key id
  { kind: "token", re: /\b(AIza[0-9A-Za-z_-]{30,})\b/g },                       // Google API key
  { kind: "token", re: /\b(bsl_[a-f0-9]{32,})\b/g },                            // Basil's own Siri tokens
  { kind: "token", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g }, // JWT
  { kind: "token", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g },

  // Secrets inside URLs: keep the parameter name, drop the value.
  { kind: "url-secret", re: /[?&#](?:token|access_token|refresh_token|auth|auth_token|key|apikey|api_key|code|otp|secret|password|pwd|passwd|sig|signature|reset|reset_token|verify|verification|confirm|confirmation|session|sessionid|magic|invite|activation)=([^&\s"'<>)\]]+)/gi },
  { kind: "url-secret", re: /\/(?:reset-password|reset|verify|verify-email|confirm|magic-link|magic|invite|activate|activation|otp|login-link|auth)\/([A-Za-z0-9_-]{16,})/gi },

  // "password: X", "temporary password is X", "your new passcode - X"
  { kind: "password", re: /\b(?:temporary|temp|new|initial|one[- ]time|your|the|default)?\s*(?:password|passcode|passwd|pwd|pass phrase|passphrase)\s*(?:is|:|=|-|–|—|is now|will be|has been set to)\s*["'`«“]?([^\s"'`«»“”<>,;]{4,})/gi },

  // "verification code: 482913", "your code is 48-29-13", "OTP 482913", "PIN: 1234"
  { kind: "code", re: /\b(?:verification|verify|security|confirmation|login|sign[- ]?in|one[- ]?time|2fa|two[- ]factor|auth(?:entication)?|access|otp|mfa)\s+(?:code|pin|passcode|otp)\s*(?:is|:|=|-|–|—)?\s*["'`«“]?((?=\S{4})[A-Z0-9]{2,10}(?:[- ][A-Z0-9]{2,6}){0,3})\b/gi },
  { kind: "code", re: /\b(?:code|otp|pin|passcode)\s*(?:is|:|=)\s*["'`«“]?((?=\S{4})[A-Z0-9]{2,10}(?:[- ][A-Z0-9]{2,6}){0,3})\b/gi },

  // Key/value secrets: "api_key: …", "client secret = …", "token: …"
  { kind: "key", re: /\b(?:api[_ -]?key|secret[_ -]?key|client[_ -]?secret|private[_ -]?key|access[_ -]?key|auth[_ -]?token|api[_ -]?token|secret|token)\s*(?::|=)\s*["'`]?([A-Za-z0-9_\-./+=]{12,})/gi },
];

/**
 * A bare 6–8 digit number is a code when the words around it say so. Kept
 * separate from RULES because the trigger is context, not a prefix.
 */
const BARE_CODE = /\b(\d{6,8})\b/g;
const CODE_CONTEXT = /\b(?:code|otp|verif|2fa|two[- ]factor|authenticat|one[- ]time|passcode|mfa|pin)\b/i;
const CODE_WINDOW = 60;

/** Replace every credential-shaped value in `text`. Never throws. */
export function redactSensitive(text: string): RedactedText {
  if (typeof text !== "string" || text.length === 0) return { text, redactions: [], count: 0 };
  const redactions: Redaction[] = [];
  let out = text;

  for (const { kind, re } of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, (match: string, value: string) => {
      if (!value) return match;
      redactions.push({ kind });
      return match.replace(value, placeholder(kind));
    });
  }

  BARE_CODE.lastIndex = 0;
  out = out.replace(BARE_CODE, (match: string, digits: string, offset: number) => {
    const before = out.slice(Math.max(0, offset - CODE_WINDOW), offset);
    const after = out.slice(offset + match.length, offset + match.length + CODE_WINDOW);
    if (!CODE_CONTEXT.test(before) && !CODE_CONTEXT.test(after)) return match;
    redactions.push({ kind: "code" });
    return placeholder("code");
  });

  return { text: out, redactions, count: redactions.length };
}

export function containsSensitive(text: string): boolean {
  return redactSensitive(text).count > 0;
}

export interface RedactedValue<T> {
  value: T;
  count: number;
}

/**
 * Walk any JSON-shaped value and redact every string in it. Objects and arrays
 * are copied; non-string leaves pass through untouched. Cycles are not
 * expected in JSON data and are not handled.
 */
export function redactDeep<T>(value: T): RedactedValue<T> {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSensitive(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

/** Human-readable summary for logs — counts only, never values. */
export function describeRedactions(redactions: Redaction[]): string {
  const by = new Map<SensitiveKind, number>();
  for (const r of redactions) by.set(r.kind, (by.get(r.kind) ?? 0) + 1);
  return [...by.entries()].map(([k, n]) => `${n} ${k}`).join(", ") || "none";
}
