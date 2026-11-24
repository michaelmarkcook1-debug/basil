/**
 * lib/meetings/follow-up.ts — draft the recap email after a recorded meeting
 * and queue it for approval (audit 2026-11-24, Part 3 entry 13; rules in
 * lib/meetings/follow-up-shape.ts). One AI call per qualifying meeting. It is
 * never sent without the user's yes. Never throws to the ingestion pipeline.
 */
import "server-only";
import type { MeetingRecord } from "@/lib/meetings/history";
import { followUpPrompt, followUpRecipients, wantsFollowUp } from "@/lib/meetings/follow-up-shape";
import { getSelfIdentity } from "@/lib/self-identity";
import { getSettings } from "@/lib/settings/store";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { draftStyleFor } from "@/lib/drafts/style-store";
import { createEventIfNew } from "@/lib/events/store";
import { notifyUser } from "@/lib/notify";

export async function draftMeetingFollowUp(username: string, rec: Omit<MeetingRecord, "recordedAt">): Promise<"queued" | "skipped" | "exists" | "error"> {
  try {
    const full: MeetingRecord = { ...rec, recordedAt: new Date().toISOString() };
    const self = await getSelfIdentity(username);
    const own = new Set(self.emails.map((e) => e.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d));
    if (!wantsFollowUp(full, own)) return "skipped";
    const to = followUpRecipients(full, own);
    const settings = await getSettings(username);
    const firstName = settings.name?.trim().split(/\s+/)[0] || username;
    const style = await draftStyleFor(username, { address: to[0] }, firstName).catch((e) => {
      console.warn("[meetings/follow-up] learned style unreadable:", e instanceof Error ? e.message : e);
      return "";
    });
    const { text } = await generateTextSafe({
      model: getTextModel("balanced"),
      maxOutputTokens: MAX_TOKENS.balanced,
      messages: [{ role: "user", content: followUpPrompt(full, firstName, to, style) }],
    }, "balanced", { username, feature: "meeting-follow-up" });
    const body = text.trim();
    if (!body) return "error";
    const { created } = await createEventIfNew(username, {
      sourceRef: `followup:${rec.id}`,
      source: rec.id.startsWith("upload:") ? "upload" : "zoom",
      headline: `Follow-up email for "${rec.title}" is ready to send`,
      context: rec.summary || rec.title,
      entityName: rec.attendees[0],
      disposition: "draft",
      priority: "normal",
      status: "pending",
      actionType: "send_email",
      rationale: `Drafted after the meeting from its notes: ${rec.decisions.length} decision(s), ${rec.actions.length} action(s). Goes to the outside attendees only when you approve.`,
      confidence: 0.8,
      tags: ["meeting", "follow-up"],
      draft: { channel: "email", to: to.join(", "), subject: `Follow-up: ${rec.title}`, body, generatedAt: new Date().toISOString() },
    });
    if (!created) return "exists";
    await notifyUser(username, {
      kind: "meetings",
      title: `Follow-up drafted: ${rec.title}`.slice(0, 80),
      body: `Recap to ${to.slice(0, 2).join(", ")}${to.length > 2 ? ` +${to.length - 2}` : ""}: decisions, owners and dates. Review and send.`,
      url: "/dashboard",
      tag: `followup:${rec.id}`,
    }, { onceKeys: [`followup:${rec.id}`] }).catch((e) => console.warn("[meetings/follow-up] push failed:", e instanceof Error ? e.message : e));
    console.log(`[meetings/follow-up] ${username}: queued a follow-up for ${rec.id}`);
    return "queued";
  } catch (e) {
    console.warn("[meetings/follow-up] not drafted:", e instanceof Error ? e.message : e);
    return "error";
  }
}
