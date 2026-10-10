/**
 * GET  /api/email/[id]/reply — the message (from the view cache when warm) and who a reply goes to.
 *                              ?fresh=1 skips the cache.
 * POST /api/email/[id]/reply — send it. Body: { body: string, replyAll?: boolean, actionId?: string,
 *                              to?, cc?, bcc? } — each recipient field a string ("a@x.com, Name <b@y.com>")
 *                              or an array of them; given, it replaces the default for that field.
 *
 * Sends IN the original thread (lib/google/gmail.ts replyToEmail). Sending only
 * ever happens on this explicit POST from the user's Send button. With
 * actionId, the action that asked for the reply is closed as "you replied".
 */
import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { replyToEmail } from "@/lib/google/gmail";
import { parseRecipientField } from "@/lib/email/recipients";
import { loadEmailView } from "@/lib/email/view-cache";
import { updateAction } from "@/lib/actions/store";
import { emitAuditEvent } from "@/lib/events/audit";
import { checkRateLimitDurable } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const MAX_BODY = 20_000;
const MAX_RECIPIENTS = 50;

async function guard(): Promise<{ username: string } | NextResponse> {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) return NextResponse.json({ error: "Gmail not connected." }, { status: 401 });
  return { username };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(); if (g instanceof NextResponse) return g;
  const { id } = await params;
  try {
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    return NextResponse.json(await loadEmailView(g.username, id, { fresh }));
  } catch (e) {
    console.error("[email/reply] context failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not open that email." }, { status: 502 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(); if (g instanceof NextResponse) return g;
  const rl = await checkRateLimitDurable(`email:reply:${g.username}`, 20);
  if (!rl.allowed) return NextResponse.json({ error: "Too many emails in a minute — try again shortly." }, { status: 429 });
  const { id } = await params;
  let body: { body?: unknown; replyAll?: unknown; actionId?: unknown; to?: unknown; cc?: unknown; bcc?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const text = typeof body.body === "string" ? body.body : "";
  if (!text.trim()) return NextResponse.json({ error: "Write a reply first." }, { status: 400 });
  if (text.length > MAX_BODY) return NextResponse.json({ error: "That reply is too long." }, { status: 400 });

  const fields = { to: parseRecipientField(body.to), cc: parseRecipientField(body.cc), bcc: parseRecipientField(body.bcc) };
  const bad = Object.values(fields).flatMap((f) => (f.ok ? [] : f.bad));
  if (bad.length) return NextResponse.json({ error: `Not an email address: ${bad.join(", ")}` }, { status: 400 });
  const [to, cc, bcc] = [fields.to, fields.cc, fields.bcc].map((f) => (f.ok ? f.list : undefined));
  if (to && to.length === 0) return NextResponse.json({ error: "Add at least one recipient." }, { status: 400 });
  if ((to?.length ?? 0) + (cc?.length ?? 0) + (bcc?.length ?? 0) > MAX_RECIPIENTS) {
    return NextResponse.json({ error: `At most ${MAX_RECIPIENTS} recipients.` }, { status: 400 });
  }

  let sent: Awaited<ReturnType<typeof replyToEmail>>;
  try {
    sent = await replyToEmail(g.username, id, text, { replyAll: body.replyAll === true, to, cc, bcc });
  } catch (e) {
    console.error("[email/reply] send failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The reply was not sent." }, { status: 502 });
  }
  const recipients = [...sent.to, ...sent.cc].map((a) => a.email).join(", ")
    + (sent.bcc.length ? ` · Bcc: ${sent.bcc.map((a) => a.email).join(", ")}` : "");
  if (typeof body.actionId === "string" && body.actionId) {
    await updateAction(g.username, body.actionId, { status: "done", archivedReason: "reply-sent" }).catch((e) =>
      console.warn("[email/reply] sent, but could not close the action:", e instanceof Error ? e.message : e));
  }
  await emitAuditEvent({
    username: g.username,
    source: "email",
    headline: `Replied to ${sent.to.map((a) => a.name || a.email).join(", ")}`,
    context: `To: ${recipients}\n\n${text.slice(0, 300)}`,
    rationale: "Sent from Basil's reply composer.",
    tags: ["email", "reply"],
  }).catch((e) => console.warn("[email/reply] audit failed:", e instanceof Error ? e.message : e));
  return NextResponse.json({ success: true, id: sent.id, threadId: sent.threadId, to: sent.to, cc: sent.cc, bcc: sent.bcc });
}
