/**
 * Signal Pipeline
 *
 * Orchestrates the full enrichment and write sequence for a new SignalEvent:
 *
 *   1. Resolve identities   (gated on canonicalIdentity_active)
 *      → populates EntityRef.canonicalId for each participant
 *      → returns sender's CanonicalIdentity for ranking
 *
 *   2. Rank signal          (gated on ranking_active)
 *      → produces RankedSignal, attached to signal.ranking
 *
 *   3. Write signal event   (always — gated by caller on signalEvent_active)
 *      → persists to sage-signal-events.json
 *
 *   4. Upsert thread        (gated on signalThread_active)
 *      → creates or updates SignalThread in sage-signal-threads.json
 *
 * This replaces direct calls to writeSignalEvent() in the dual-write blocks.
 * The caller is responsible for normalization and for checking signalEvent_active.
 *
 * Guardrails:
 *   - Never throws — all stage errors are caught and logged
 *   - Each stage is independently fault-tolerant: a ranking failure does not
 *     block the store write; a thread upsert failure does not lose the signal
 *   - All writes are gated on their respective flags
 */

import type { SignalEvent } from "@/core/primitives/signal-event";
import type { FeatureFlags } from "@/core/feature-flags";
import { resolveParticipants } from "@/core/storage/canonical-identity-store";
import { rankSignal } from "@/core/ingestion/signal-ranker";
import { writeSignalEvent } from "@/core/storage/signal-event-store";
import { upsertThread } from "@/core/storage/signal-thread-store";

export interface PipelineResult {
  /** true if the signal was written to the store */
  written: boolean;
  /** true if identity resolution ran (may still have partial results) */
  identitiesResolved: boolean;
  /** true if ranking was attached */
  ranked: boolean;
  /** true if thread was upserted */
  threaded: boolean;
  /** Error messages from any failed stage (non-fatal) */
  stageErrors: string[];
}

/**
 * Run the full signal enrichment and write pipeline.
 *
 * @param username  User scope
 * @param signal    A fully-assembled SignalEvent (category, actionIds, etc. already set)
 * @param flags     Current feature flags for the user
 */
export async function enrichAndWriteSignal(
  username: string,
  signal: SignalEvent,
  flags: FeatureFlags
): Promise<PipelineResult> {
  const result: PipelineResult = {
    written: false,
    identitiesResolved: false,
    ranked: false,
    threaded: false,
    stageErrors: [],
  };

  // ── Stage 1: Identity resolution ──────────────────────────────────────────
  let senderIdentity = null;
  if (flags.canonicalIdentity_active) {
    try {
      senderIdentity = await resolveParticipants(username, signal);
      result.identitiesResolved = true;
    } catch (err) {
      const msg = `identity resolution failed: ${err instanceof Error ? err.message : err}`;
      result.stageErrors.push(msg);
      console.error(`[signal-pipeline] ${msg} for ${signal.sourceRef}`);
    }
  }

  // ── Stage 2: Ranking ──────────────────────────────────────────────────────
  if (flags.ranking_active) {
    try {
      signal.ranking = rankSignal(signal, senderIdentity);
      result.ranked = true;
    } catch (err) {
      const msg = `ranking failed: ${err instanceof Error ? err.message : err}`;
      result.stageErrors.push(msg);
      console.error(`[signal-pipeline] ${msg} for ${signal.sourceRef}`);
      // Signal continues without ranking — not a blocking error
    }
  }

  // ── Stage 3: Write signal event ───────────────────────────────────────────
  try {
    const written = await writeSignalEvent(username, signal);
    result.written = written !== null;
  } catch (err) {
    const msg = `signal write failed: ${err instanceof Error ? err.message : err}`;
    result.stageErrors.push(msg);
    console.error(`[signal-pipeline] ${msg} for ${signal.sourceRef}`);
    // If write fails, skip thread upsert (nothing to thread)
    return result;
  }

  // ── Stage 4: Thread upsert ────────────────────────────────────────────────
  if (flags.signalThread_active) {
    try {
      await upsertThread(username, signal);
      result.threaded = true;
    } catch (err) {
      const msg = `thread upsert failed: ${err instanceof Error ? err.message : err}`;
      result.stageErrors.push(msg);
      console.error(`[signal-pipeline] ${msg} for ${signal.sourceRef}`);
    }
  }

  return result;
}
