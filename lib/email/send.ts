/**
 * lib/email/send.ts — transactional email via Resend.
 *
 * No-op (returns ok:false) when RESEND_API_KEY is unset, so callers can treat
 * email as a best-effort channel. Configure RESEND_API_KEY and (optionally)
 * RESEND_FROM_EMAIL to enable.
 *
 * server-only.
 */

import "server-only";

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "email-not-configured" };

  const from = process.env.RESEND_FROM_EMAIL || "Basil <noreply@basil-app.vercel.app>";
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
