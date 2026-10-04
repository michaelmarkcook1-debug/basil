/**
 * GET  /api/email/[id]/reply — who a reply goes to, and the message being answered.
 * POST /api/email/[id]/reply — send it. Body: { body: string, replyAll?: boolean, actionId?: string }
 *
 * Sends IN the original thread (lib/google/gmail.ts replyToEmail). Sending only
 * ever happens on this explicit POST from the user's Send button. With
 * actionId, the action that asked for the reply is closed as "you replied".
 */
import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { getReplyContext, replyToEmail } from "@/lib/google/gmail";
import { updateAction } from "@/lib/actions/store";
import { emitAuditEvent } from "@/lib/events/audit";
import { checkRateLimitDurable } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const MAX_BODY = 20_000;

async function guard(): Promise<{ username: string } | NextResponse> {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) return NextResponse.json({ error: "Gmail not connected." }, { status: 401 });
  return { username };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(); if (g instanceof NextResponse) return g;
  const { id } = await params;
  try {
    const ctx = await getReplyContext(g.username, id);
    return NextResponse.json({
      subject: ctx.subject, date: ctx.date, from: ctx.from,
      replyTo: ctx.replyTo, replyAllCc: ctx.replyAllCc,
      body: ctx.body.slice(0, 8_000),
    });
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
  let body: { body?: unknown; replyAll?: unknown; actionId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const text = typeof body.body === "string" ? body.body : "";
  if (!text.trim()) return NextResponse.json({ error: "Write a reply first." }, { status: 400 });
  if (text.length > MAX_BODY) return NextResponse.json({ error: "That reply is too long." }, { status: 400 });

  let sent: Awaited<ReturnType<typeof replyToEmail>>;
  try {
    sent = await replyToEmail(g.username, id, text, { replyAll: body.replyAll === true });
  } catch (e) {
    console.error("[email/reply] send failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The reply was not sent." }, { status: 502 });
  }
  const recipients = [...sent.to, ...sent.cc].map((a) => a.email).join(", ");
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
  return NextResponse.json({ success: true, id: sent.id, threadId: sent.threadId, to: sent.to, cc: sent.cc });
}
