/**
 * POST /api/admin/model-bench — compare models on the admin's own recent work.
 *
 * Owner rule (2026-10-29): a new Anthropic model is tested on Basil's own
 * prompts, through the production code path, before any tier is switched to it.
 * The production key cannot be read back, so the comparison runs here.
 *
 *   { task: "slack" | "email", variants: [...], limit?, offset? }
 *     Re-classifies the admin's most recent Slack threads / emails once per
 *     variant, from the same text, through the live classifier.
 *   { task: "read", variants: [...] }
 *     Writes the Briefing page's operational read once per variant.
 * (The daily briefing has its own switch: POST /api/generate/briefing?bench=[…].)
 *
 * Nothing is filed, sent or marked as seen, and no briefing or read is stored.
 * The model calls are real: each is metered and traced like any other.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { parseBenchVariants, runModelBench, type BenchCall, type BenchVariant } from "@/lib/ai/model-config";
import { listEvents } from "@/lib/events/store";
import { getSelfIdentity } from "@/lib/self-identity";
import { fetchSlackThread, formatThreadTranscript } from "@/lib/slack/fetch-thread";
import { classifySlack, shouldMaterializeSlack } from "@/lib/slack/classify-slack";
import { classifyEmail, shouldMaterialize } from "@/lib/email/classify-email";
import { stripHtml } from "@/lib/email/process-gmail-message";
import { getEmailBody } from "@/lib/google/gmail";
import { benchStigBriefing } from "@/lib/stig/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface TriageRun { label: string; files: boolean; failed: boolean; output: unknown; calls: BenchCall[] }
interface TriageItem { ref: string; where: string; chars: number; text: string; runs: TriageRun[] }

/** How much of each thread or email comes back for a human to judge a disagreement by. */
const PREVIEW_CHARS = 1_500;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { task?: string; variants?: unknown; limit?: number; offset?: number };
  const variants = parseBenchVariants(body.variants);
  if (!variants) return NextResponse.json({ error: "variants must be 1–5 of { label, model?, effort? }" }, { status: 400 });

  if (body.task === "read") {
    return NextResponse.json({ task: "read", runs: await benchStigBriefing(username, variants) });
  }
  if (body.task !== "slack" && body.task !== "email") {
    return NextResponse.json({ error: "task must be slack, email or read" }, { status: 400 });
  }

  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const prefix = body.task === "slack" ? "slack:" : "gmail:";
  const events = (await listEvents(username))
    .filter((ev) => ev.source === body.task && ev.externalId?.startsWith(prefix))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit);

  const items: TriageItem[] = [];
  if (body.task === "slack") {
    const selfName = (await getSelfIdentity(username).catch(() => ({ names: [] as string[] }))).names[0] ?? undefined;
    for (const ev of events) {
      // Same transcript the morning reprocess pass builds.
      const [channelId = "", messageTs = ""] = ev.externalId!.replace("slack:", "").split(":");
      const channelName = (ev.payload as { channel?: string })?.channel || ev.entityName || "Unknown";
      const thread = await fetchSlackThread(username, channelId, messageTs);
      const transcript = thread.length > 0
        ? formatThreadTranscript(thread, channelName, selfName)
        : `Channel: ${channelName}\n\n${ev.entityName || "Unknown"}: ${(ev.payload as { body?: string })?.body || ev.context || ""}`;
      const runs = await eachVariant(variants, async () => {
        const intel = await classifySlack({ username, channelName, transcript, isDM: channelName.startsWith("DM:"), isMention: false, date: ev.createdAt });
        return { files: shouldMaterializeSlack(intel), failed: Boolean(intel.classificationFailed), output: intel };
      });
      items.push({ ref: ev.externalId!, where: channelName, chars: transcript.length, text: transcript.slice(0, PREVIEW_CHARS), runs });
    }
  } else {
    for (const ev of events) {
      // Same subject, sender and stripped body the live email path classifies.
      const subject = (ev.payload as { title?: string })?.title || ev.headline || "";
      const full = await getEmailBody(username, ev.externalId!.replace("gmail:", "")).catch((e) => {
        console.warn(`[model-bench] could not read ${ev.externalId}:`, e instanceof Error ? e.message : e);
        return null;
      });
      if (!full?.body) continue;
      const emailBody = full.body.includes("<") ? stripHtml(full.body) : full.body;
      const runs = await eachVariant(variants, async () => {
        const intel = await classifyEmail({ username, subject, from: ev.entityName || "", date: full.date || ev.createdAt, snippet: "", body: emailBody });
        return { files: shouldMaterialize(intel), failed: Boolean((intel as { classificationFailed?: boolean }).classificationFailed), output: intel };
      });
      items.push({ ref: ev.externalId!, where: `${ev.entityName || ""} — ${subject}`, chars: emailBody.length, text: emailBody.slice(0, PREVIEW_CHARS), runs });
    }
  }
  return NextResponse.json({ task: body.task, offset, count: items.length, items });
}

/** Run one classification per variant, side by side on the same text. */
async function eachVariant(
  variants: BenchVariant[],
  classify: () => Promise<Omit<TriageRun, "label" | "calls">>,
): Promise<TriageRun[]> {
  return Promise.all(variants.map(async (v) => {
    const { result, calls } = await runModelBench("balanced", v, classify);
    return { label: v.label, ...result, calls };
  }));
}
