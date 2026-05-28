/**
 * POST /api/signals/backfill
 *
 * Backfills the signal event store from historical Basil events.
 * Safe to call multiple times — existing signals are deduplicated by sourceRef.
 *
 * This is needed because signalEvent_active defaulted to false for users who
 * were set up before v2 schema migration, meaning all historical email/slack
 * events were never normalised into SignalEvents.
 *
 * Process:
 *   1. Read all events from the event store (up to `days` days back)
 *   2. Collect already-known sourceRefs to avoid re-writing existing signals
 *   3. For each email event: construct GmailNormalizerInput and normalise
 *   4. For each slack event: construct SlackNormalizerInput and normalise
 *   5. For each normalised signal: run enrichAndWriteSignal with current flags
 *
 * No AI calls are made — classification stays as "unknown". Ranking is applied
 * by enrichAndWriteSignal if ranking_active is true.
 *
 * Returns: { processed, skipped, errors, total }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listEvents } from "@/lib/events/store";
import { readSignalEvents } from "@/core/storage/signal-event-store";
import { getFlags } from "@/core/feature-flags";
import { enrichAndWriteSignal } from "@/core/ingestion/signal-pipeline";
import { normalizeGmailSignal } from "@/core/signals/normalizers/gmail.normalizer";
import { normalizeSlackSignal } from "@/core/signals/normalizers/slack.normalizer";
import type { SignalEvent } from "@/core/primitives/signal-event";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const rawDays = Number(body.days ?? DEFAULT_DAYS);
  const days = Math.min(Math.max(1, isNaN(rawDays) ? DEFAULT_DAYS : rawDays), MAX_DAYS);
  const dryRun = body.dryRun === true;

  const flags = await getFlags(username);
  // Force flags to allow writing for the backfill — we're explicitly backfilling
  // signals regardless of the current write flag state (the whole point is to
  // populate the store for users whose flags were off during ingestion).
  const backfillFlags = {
    ...flags,
    signalEvent_active: true,
    ranking_active: true,
  };

  // ── Cutoff date ──────────────────────────────────────────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();

  // ── Load events and existing signals ─────────────────────────────────────────
  const [allEvents, existingSignals] = await Promise.all([
    listEvents(username),
    readSignalEvents(username, { limit: 500 }),
  ]);

  const existingSourceRefs = new Set(existingSignals.map((s) => s.sourceRef));

  // Filter events to the window and supported sources
  const candidates = allEvents.filter((ev) => {
    if (!ev.createdAt || ev.createdAt < cutoffIso) return false;
    return ev.source === "email" || ev.source === "slack";
  });

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const ev of candidates) {
    const sourceRef = ev.externalId ?? ev.sourceRef;

    // Skip if already in signal store
    if (sourceRef && existingSourceRefs.has(sourceRef)) {
      skipped++;
      continue;
    }

    try {
      let signal: SignalEvent;

      if (ev.source === "email") {
        // Reconstruct GmailNormalizerInput from stored BasilEvent fields.
        // The body comes from ev.context (full context Basil classified from).
        // The subject comes from ev.headline (short summary, or payload.subject if present).
        const payloadSubject =
          (ev.payload?.subject as string | undefined) ??
          (ev.payload?.title as string | undefined);
        const subject = payloadSubject ?? ev.headline ?? "(no subject)";
        const from =
          (ev.payload?.from as string | undefined) ??
          ev.entityName ??
          "Unknown";
        const externalId = sourceRef ?? `gmail:backfill:${ev.id}`;
        const body = ev.context ?? "";
        const date = (ev.payload?.date as string | undefined) ?? ev.createdAt;
        const gmailId =
          (ev.payload?.gmailId as string | undefined) ??
          externalId.replace(/^gmail:/, "");

        signal = normalizeGmailSignal({
          opts: {
            username,
            gmailId,
            externalId,
            eventId: ev.id,
            subject,
            from,
          },
          body,
          date,
          senderIsKnown: true,
        });
      } else if (ev.source === "slack") {
        // Reconstruct SlackNormalizerInput from stored BasilEvent fields.
        const payload = ev.payload ?? {};
        const externalId = sourceRef ?? `slack:backfill:${ev.id}`;
        const from =
          (payload.from as string | undefined) ??
          ev.entityName ??
          "Unknown";
        const channelName =
          (payload.channelName as string | undefined) ?? "unknown-channel";
        const messageTs = (payload.messageTs as string | undefined) ?? ev.id;
        const isDM = Boolean(payload.isDM);
        const isGroupDM = Boolean(payload.isGroupDM);
        const isMention = Boolean(payload.isMention);
        const date = (payload.date as string | undefined) ?? ev.createdAt;
        const transcript = ev.context ?? (payload.bodyFallback as string | undefined) ?? "";

        signal = normalizeSlackSignal({
          payload: {
            channelId: (payload.channelId as string | undefined) ?? channelName,
            messageTs,
            externalId,
            eventId: ev.id,
            channelName,
            from,
            date,
            isDM,
            isGroupDM,
            isMention,
          },
          transcript,
          senderIsKnown: true,
        });
      } else {
        skipped++;
        continue;
      }

      if (!dryRun) {
        await enrichAndWriteSignal(username, signal, backfillFlags);
        existingSourceRefs.add(signal.sourceRef);
      }
      processed++;
    } catch (err) {
      const msg = `[backfill] error processing event ${ev.id}: ${err instanceof Error ? err.message : err}`;
      console.error(msg);
      errors.push(msg);
      skipped++;
    }
  }

  const elapsed = Date.now() - t0;
  console.info(
    `[signals/backfill] ${username} processed=${processed} skipped=${skipped} errors=${errors.length} dry=${dryRun} ${elapsed}ms`
  );

  return NextResponse.json({
    processed,
    skipped,
    errors: errors.slice(0, 20), // cap error list in response
    total: candidates.length,
    dryRun,
    days,
    elapsedMs: elapsed,
  });
}
