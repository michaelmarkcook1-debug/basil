/**
 * lib/auth/invite.ts — set a colleague up on Basil in one step.
 *
 * Self-registration stays closed in production (a stranger's account draws on
 * the AI budget). Instead the admin invites someone by name and email: Basil
 * creates the account with an unusable random password and makes a one-time
 * "choose your password" link that lasts a week. The link is emailed (when
 * email is configured) AND handed back to the admin, so it can be sent over
 * Slack if the email does not arrive. Choosing a password signs them in and
 * starts onboarding, which connects their own Google, Slack and Zoom.
 *
 * Their data is theirs: deployment credentials only ever serve the owner
 * (lib/auth/env-credential-owner.ts), so a new account starts empty until it
 * connects its own accounts.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { createUser, findByEmail, getUsers, type User } from "@/lib/users";
import { createResetToken } from "@/lib/auth/reset-tokens";
import { sendEmail } from "@/lib/email/send";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** "Ed.Baum+basil@talentgenius.io" → "ed.baum"; unique against existing usernames. */
export function usernameFor(email: string, taken: readonly string[]): string {
  const base = (email.split("@")[0] ?? "").split("+")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "") || "user";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The invite email — plain words, one button, what happens next. Exported for tests. */
export function inviteEmail(opts: { firstName: string; inviter: string; link: string }): { subject: string; text: string; html: string } {
  const subject = `${opts.inviter} has set you up on Basil`;
  const steps = [
    "Click the button and choose a password.",
    "Sign in to Google when asked — that lets Basil read your email, calendar and documents. Then Slack, and Zoom if you use it.",
    "That's it. Basil starts working through your week straight away; your morning briefing arrives tomorrow.",
  ];
  const text = `Hi ${opts.firstName},

${opts.inviter} has set you up on Basil, an assistant that keeps track of your meetings, emails and follow-ups so nothing slips.

Getting started takes about three minutes:
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Start here: ${opts.link}

The link works once and expires in 7 days. Only you can see your Basil — your email and messages are never shared with anyone else.`;
  const html = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#10213F;line-height:1.55">
<p>Hi ${esc(opts.firstName)},</p>
<p>${esc(opts.inviter)} has set you up on <strong>Basil</strong>, an assistant that keeps track of your meetings, emails and follow-ups so nothing slips.</p>
<p>Getting started takes about three minutes:</p>
<ol>${steps.map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join("")}</ol>
<p style="margin:28px 0"><a href="${esc(opts.link)}" style="background:#D4B978;color:#10213F;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-family:Helvetica,Arial,sans-serif">Set up my Basil</a></p>
<p style="font-size:13px;color:#5b6475">The link works once and expires in 7 days. Only you can see your Basil — your email and messages are never shared with anyone else.</p>
</div>`;
  return { subject, text, html };
}

export interface InviteResult { user: Pick<User, "username" | "email" | "name" | "surname">; link: string; emailed: boolean; emailError?: string }

export async function inviteUser(opts: { name: string; surname?: string; email: string; inviter: string; baseUrl: string }): Promise<InviteResult> {
  const email = opts.email.trim().toLowerCase();
  if (await findByEmail(email)) throw new Error(`${email} already has a Basil account.`);
  const username = usernameFor(email, (await getUsers()).map((u) => u.username));
  const user = await createUser({
    name: opts.name.trim(), surname: (opts.surname ?? "").trim(), country: "", email, username,
    // Unusable until they choose their own through the invite link.
    password: randomBytes(32).toString("hex"),
    onboardingCompleted: false,
  });
  const token = await createResetToken(user.username, user.email, INVITE_TTL_MS);
  const link = `${opts.baseUrl.replace(/\/$/, "")}/reset-password?token=${token}&welcome=1`;
  const mail = inviteEmail({ firstName: user.name || "there", inviter: opts.inviter, link });
  const sent = await sendEmail({ to: email, ...mail });
  if (!sent.ok) console.warn(`[invite] email to ${email} not sent: ${sent.error}`);
  return { user: { username: user.username, email: user.email, name: user.name, surname: user.surname }, link, emailed: sent.ok, emailError: sent.ok ? undefined : sent.error };
}
