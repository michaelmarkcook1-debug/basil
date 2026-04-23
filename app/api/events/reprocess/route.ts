import { NextResponse, after } from "next/server";
import { listEvents } from "@/lib/events/store";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { processRegularEmail } from "@/lib/email/process-gmail-message";
import { getOutlookMessageBody } from "@/lib/microsoft/outlook-mail";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

/**
 * POST /api/events/reprocess
 *
 * Backfill classifier: finds email events that were ingested but never
 * materialized into the actions/decisions stores, then re-runs classification
 * on them using `after()` so the response returns immediately.
 *
 * An event is considered "unclassified" if its externalId does not appear as
 * a sourceRef on any existing action or decision.
 *
 * Auth: requires CRON_SECRET header (same as the renew-subscriptions cron).
 * Safe to call multiple times — createAction/createDecision dedup via Jaccard
 * similarity so no duplicates are created.
 *
 * Usage:
 *   curl -X POST https://your-domain/api/events/reprocess \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Or call unauthenticated from Settings when CRON_SECRET is not set.
 */

export async function POST(req: Request) {
  // Auth: same CRON_SECRET gate as the renew-subscriptions cron.
  const authHeader = req.headers.get("authorization");
  const expected   = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return new NextResponse("forbidden", { status: 403 });
  }

  // ── Gather existing sourceRefs so we can skip already-classified events ──
  const [actions, decisions] = await Promise.all([
    listActions(),
    listDecisions(),
  ]);

  const classifiedRefs = new Set<string>();
  for (const a of actions)   if (a.sourceRef) classifiedRefs.add(a.sourceRef);
  for (const d of decisions) if (d.sourceRef) classifiedRefs.add(d.sourceRef);

  // ── Find email events that have never been classified ───────────────────
  const allEvents = await listEvents();

  // Only reprocess email sources from the last 14 days — older than that
  // is rarely actionable and keeps the AI workload manageable.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;

  const toClassify = allEvents.filter((ev) => {
    if (ev.source !== "email") return false;
    if (!ev.externalId) return false;
    const age = new Date(ev.createdAt).getTime();
    if (age < cutoff) return false;
    // Skip if already produced at least one action/decision
    return !classifiedRefs.has(ev.externalId);
  });

  if (toClassify.length === 0) {
    return NextResponse.json({ queued: 0, message: "All recent email events already classified." });
  }

  // ── Queue classification via after() ─────────────────────────────────────
  // Each event is re-run through processRegularEmail which handles dedup
  // internally (Jaccard similarity on sourceRef + text).
  after(async () => {
    let processed = 0;
    for (const ev of toClassify) {
      try {
        const externalId = ev.externalId!;
        const isOutlook  = externalId.startsWith("outlook:");
        const msgId      = isOutlook
          ? externalId.replace("outlook:", "")
          : externalId.replace("gmail:", "");

        await processRegularEmail({
          gmailId:         msgId,
          externalId,
          eventId:         ev.id,
          subject:         (ev.payload as { title?: string })?.title || ev.headline || "",
          from:            ev.entityName || "",
          dateFallback:    ev.createdAt,
          snippetFallback: (ev.payload as { body?: string })?.body || ev.context?.slice(0, 200) || "",
          bodyFetcher:     isOutlook ? () => getOutlookMessageBody(msgId) : undefined,
        });
        processed++;
      } catch (err) {
        console.error(`[reprocess] failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }
    console.log(`[reprocess] completed: ${processed}/${toClassify.length} events classified`);
    // Explicit flush so BASIL_DATA is updated before Vercel recycles the function.
    await forceFlushSnapshot();
  });

  return NextResponse.json({
    queued:  toClassify.length,
    message: `Queued ${toClassify.length} unclassified email event(s) for background classification.`,
  });
}
