/**
 * lib/email/send.ts — transactional email via Resend.
 *
 * No-op (returns ok:false) when RESEND_API_KEY is unset, so callers can treat
 * email as a best-effort channel. Configure RESEND_API_KEY and (optionally)
 * RESEND_FROM_EMAIL to enable.
 *
 * THIS IS THE ONLY RESEND CLIENT. Routes must not hand-roll their own fetch to
 * api.resend.com — forgot-password did, so every fix here had to be made twice
 * and the two paths drifted.
 *
 * server-only.
 */

import "server-only";

/** Resend's own key format. Anything else is a different service's credential. */
const RESEND_KEY_PREFIX = "re_";

/**
 * Read an env var and strip surrounding whitespace.
 *
 * Not cosmetic. A key pasted into a terminal prompt or a dashboard field very
 * often carries a trailing newline or space, which rides along into
 * `Bearer <key>` and makes Resend answer 401 — indistinguishable from a wrong
 * key, and unfixable by re-entering the same value again. This cost hours on
 * 2026-08-15: the key was re-entered repeatedly and rejected every time.
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Why the configured key cannot work, or null when it looks usable.
 *
 * Shape-only: this never proves a key is VALID (only Resend can), but it does
 * catch the failure that actually happened — a credential for an entirely
 * different service sitting in the slot. Returns a description safe to log and
 * show an operator: length and prefix, never the value.
 */
export function resendKeyProblem(): string | null {
  const raw = process.env.RESEND_API_KEY;
  if (typeof raw !== "string" || raw.trim() === "") return "RESEND_API_KEY is not set";

  const key = raw.trim();
  if (raw !== key) {
    // Reaching here means the trim above saved the call; worth saying so, because
    // the stored value is still dirty and every other consumer sees the raw form.
    console.warn("[email] RESEND_API_KEY had surrounding whitespace — trimmed before use");
  }
  if (!key.startsWith(RESEND_KEY_PREFIX)) {
    return `RESEND_API_KEY does not look like a Resend key: expected a "${RESEND_KEY_PREFIX}" prefix, ` +
      `got "${key.slice(0, 3)}…" (length ${key.length}). A key for a different service in this slot ` +
      `returns 401 from Resend no matter how many times it is re-entered.`;
  }
  return null;
}

/**
 * True when email is plausibly configured.
 *
 * Deliberately stricter than "the variable is non-empty". It returned true while
 * the slot held an Anthropic key, so the app reported email as configured and
 * the only symptom was a 401 buried in a log line — "configured" and "working"
 * were indistinguishable, which is the failure mode this codebase keeps hitting.
 */
export function isEmailConfigured(): boolean {
  return resendKeyProblem() === null;
}

export function emailFromAddress(): string {
  return env("RESEND_FROM_EMAIL") || "Basil <noreply@basil-app.vercel.app>";
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const problem = resendKeyProblem();
  if (problem) return { ok: false, error: problem };

  const apiKey = env("RESEND_API_KEY")!;
  const from = emailFromAddress();
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `${res.status}: ${body.slice(0, 150)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface EmailProbe {
  configured: boolean;
  /**
   * Length and prefix only — never the value. This is the field that
   * distinguishes a key mangled on entry from a complete key Resend has
   * revoked. A real Resend key is `re_` plus ~32 chars; markedly shorter means
   * the value was truncated on the way in, and re-pasting the same key through
   * the same route will truncate it again.
   */
  keyShape: { length: number; prefix: string; plausibleLength: boolean } | null;
  /** Why it cannot work, or null. Safe to show an operator — never the key. */
  problem: string | null;
  /** What Resend itself said when asked. */
  resend: { status: number | null; ok: boolean; detail?: string };
  from: string;
  /** Domains Resend has verified for this account. */
  verifiedDomains: string[];
  /** False when `from` sits on a domain Resend has not verified → sends 403. */
  fromDomainVerified: boolean | null;
  verdict: string;
}

/**
 * Ask Resend directly whether the configured credential works.
 *
 * GET /domains sends no email, so this is safe to call at any time, and it
 * answers BOTH questions that break transactional email: is the key accepted,
 * and is the From address on a verified domain (an unverified sender is a 403
 * that reads nothing like a key problem).
 *
 * Written because three rounds were spent inspecting the stored value from the
 * outside. Vercel marks these variables sensitive, so `vercel env pull` returns
 * a placeholder and the real value is only visible to the running app — which
 * means the app has to be the one to answer.
 */
/**
 * Resend reports a bad credential as 400 validation_error, not only 401.
 * Matching 401 alone made the most common failure fall through to a generic
 * "Resend returned 400" with no guidance.
 */
function rejectedCredential(status: number | null, body: string): boolean {
  if (status === 401) return true;
  return status === 400 && /api key is invalid/i.test(body);
}

export async function probeEmailConfig(): Promise<EmailProbe> {
  const problem = resendKeyProblem();
  const from = emailFromAddress();
  const rawKey = (process.env.RESEND_API_KEY ?? "").trim();
  const base: EmailProbe = {
    configured: problem === null,
    keyShape: rawKey
      ? { length: rawKey.length, prefix: rawKey.slice(0, 3), plausibleLength: rawKey.length >= 30 }
      : null,
    problem,
    resend: { status: null, ok: false },
    from,
    verifiedDomains: [],
    fromDomainVerified: null,
    verdict: "",
  };

  if (problem) return { ...base, verdict: `Cannot send: ${problem}` };

  const apiKey = env("RESEND_API_KEY")!;
  let status: number | null = null;
  let payload: unknown;
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) {
      return {
        ...base,
        resend: { status, ok: false, detail: text.slice(0, 200) },
        verdict: rejectedCredential(status, text)
          ? `Resend rejected the key (${status}: "API key is invalid"). It is well-formed, so this is ` +
            `not a formatting problem. Stored length is ${rawKey.length} characters; a real Resend key ` +
            `is about 35. ` +
            (rawKey.length < 30
              ? "That is SHORT — the value was truncated on the way in, so re-pasting the same key by " +
                "the same route will truncate it again. Paste it in the Vercel dashboard instead."
              : "The length looks right, so the key itself is dead — it was revoked, regenerated, or " +
                "belongs to a different Resend account. Create a fresh key in the Resend dashboard.")
          : `Resend returned ${status}. ${text.slice(0, 120)}`,
      };
    }
    try { payload = JSON.parse(text); } catch { payload = null; }
  } catch (e) {
    return {
      ...base,
      resend: { status, ok: false, detail: e instanceof Error ? e.message : String(e) },
      verdict: "Could not reach Resend at all — network or DNS, not a credential problem.",
    };
  }

  const rows = (payload as { data?: { name?: string; status?: string }[] } | null)?.data ?? [];
  const verified = rows.filter((d) => d.status === "verified").map((d) => d.name!).filter(Boolean);

  // `from` may be "Name <addr@domain>" or a bare address.
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const domain = addr.split("@")[1]?.toLowerCase() ?? "";
  const fromOk = verified.some((d) => d.toLowerCase() === domain);

  return {
    configured: true,
    keyShape: base.keyShape,
    problem: null,
    resend: { status, ok: true },
    from,
    verifiedDomains: verified,
    fromDomainVerified: fromOk,
    verdict: fromOk
      ? "Email is working: the key is live and the From domain is verified."
      : `The key is live, but "${domain || from}" is not a verified sending domain` +
        (verified.length ? ` (verified: ${verified.join(", ")})` : " and this account has no verified domains") +
        ". Resend will reject sends with 403 until the domain is verified or From is changed to a verified one.",
  };
}
