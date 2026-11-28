/**
 * lib/email/to-user.ts — deliver one of Basil's own notices (the morning
 * briefing, a reminder) to the user (2026-11-28).
 *
 * Resend refused every send from the unverified basil-app.vercel.app domain,
 * so the briefing email and the notification fallback never arrived. Now the
 * notice goes from the user's own connected Gmail to their own address
 * (lib/google/gmail sendNoticeToSelf), and Resend is the fallback for users
 * without Gmail. Only ever addressed to the user's own account email.
 */
import "server-only";
import { isGoogleConnected } from "@/lib/google/auth";
import { sendNoticeToSelf } from "@/lib/google/gmail";
import { isEmailConfigured, sendEmail } from "@/lib/email/send";

export interface UserEmailResult { ok: boolean; via?: "gmail" | "resend"; error?: string }

export async function emailUser(username: string, msg: { to: string; subject: string; text: string; html?: string }): Promise<UserEmailResult> {
  const errors: string[] = [];
  if (await isGoogleConnected(username).catch(() => false)) {
    try {
      await sendNoticeToSelf(username, msg.to, msg.subject, msg.text, msg.html);
      return { ok: true, via: "gmail" };
    } catch (e) {
      errors.push(`gmail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }
  if (isEmailConfigured()) {
    const r = await sendEmail({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html ?? msg.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>") });
    if (r.ok) return { ok: true, via: "resend" };
    errors.push(`resend: ${r.error}`);
  }
  return { ok: false, error: errors.join("; ") || "no email channel (Gmail not connected, Resend not configured)" };
}
