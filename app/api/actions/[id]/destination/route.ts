/**
 * GET /api/actions/[id]/destination — where the user can actually do this
 * action ("Take me there"). See lib/actions/destination.ts.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listActions } from "@/lib/actions/store";
import { baseDestination, pickActionLink, type ActionLink } from "@/lib/actions/destination";
import { getEmailBody } from "@/lib/google/gmail";
import { getSlackUserClientForUser } from "@/lib/slack/client";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await ctx.params;
  const action = (await listActions(username)).find((a) => a.id === id);
  if (!action) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const dest = baseDestination(action);
  const extra: ActionLink[] = [];
  const ref = action.sourceRef ?? "";

  if (dest.emailId) {
    // The work may live in another app the email links to (an RFI's Evidence tab).
    try {
      const mail = await getEmailBody(username, dest.emailId);
      const link = pickActionLink(mail.body, action.text);
      if (link) extra.push(link);
    } catch (e) {
      console.warn(`[actions/${id}/destination] email unreadable:`, e instanceof Error ? e.message : String(e));
    }
  } else if (ref.startsWith("slack:")) {
    const [, channel, ts] = ref.split(":");
    try {
      const web = channel && ts ? await getSlackUserClientForUser(username) : null;
      const r = web ? (await web.chat.getPermalink({ channel, message_ts: ts })) as { permalink?: string } : null;
      if (r?.permalink) extra.push({ href: r.permalink, label: "Open in Slack", external: true });
    } catch (e) {
      console.warn(`[actions/${id}/destination] Slack permalink unavailable:`, e instanceof Error ? e.message : String(e));
    }
  }
  return NextResponse.json({ emailId: dest.emailId ?? null, links: [...extra, ...dest.links] });
}
