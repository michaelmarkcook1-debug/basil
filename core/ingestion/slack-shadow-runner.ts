/**
 * Slack Shadow Runner
 *
 * Same role as gmail-shadow-runner but for Slack signals. Appends to the
 * same "sage-shadow-log.json" per user — the parity validator reads all
 * entries regardless of source, giving a unified view across Gmail + Slack.
 *
 * Called from inside processSlackStep (a "use step" function) — no additional
 * after() wrapper needed since we're already in a durable step context.
 *
 * Guardrails:
 *   - Never throws into the step — all errors are caught and logged
 *   - Never affects the old pipeline — read-only on existing stores
 *   - Shadow log write failure is logged but does not fail the step
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { normalizeSlackSignal } from "@/core/signals/normalizers/slack.normalizer";
import type { SlackNormalizerInput } from "@/core/signals/normalizers/slack.normalizer";
import type { SignalEvent } from "@/core/primitives/signal-event";
import type { ShadowComparison, ShadowDiff, OldPipelineSummary } from "./shadow-runner";

const SHADOW_LOG_FILE = "sage-shadow-log.json";
const MAX_LOG_ENTRIES = 500;

// ── Shadow log I/O ────────────────────────────────────────────────────────────

async function appendToSlackShadowLog(
  username: string,
  entry: ShadowComparison
): Promise<void> {
  const existing = await readUserStore<ShadowComparison[]>(username, SHADOW_LOG_FILE, []);
  const updated = [...existing, entry].slice(-MAX_LOG_ENTRIES);
  await writeUserStore(username, SHADOW_LOG_FILE, updated);
}

// ── Diff engine ───────────────────────────────────────────────────────────────

function diffSlackSignals(
  newSignal: SignalEvent,
  old: OldPipelineSummary
): ShadowDiff[] {
  const diffs: ShadowDiff[] = [];

  if (newSignal.source !== old.source) {
    diffs.push({
      field: "source",
      severity: "critical",
      description: `Source mismatch: new="${newSignal.source}" vs old="${old.source}"`,
    });
  }

  if (newSignal.sourceRef !== old.sourceRef) {
    diffs.push({
      field: "sourceRef",
      severity: "critical",
      description: `sourceRef mismatch — externalId binding diverged`,
    });
  }

  // For Slack, title is derived (channel/DM context) not an exact subject line,
  // so title mismatch is a warning not critical
  if (newSignal.title !== old.title) {
    diffs.push({
      field: "title",
      severity: "warning",
      description: `Title mismatch: new length=${newSignal.title.length}, old length=${old.title.length}`,
    });
  }

  if (newSignal.rawHash !== old.contentHash) {
    diffs.push({
      field: "rawHash",
      severity: "critical",
      description: `Content hash mismatch — transcript may differ between pipelines`,
    });
  }

  if (newSignal.trust.trustTier === "blocked") {
    diffs.push({
      field: "trust.trustTier",
      severity: "warning",
      description: `New pipeline would block this Slack signal (tier=blocked)`,
    });
  }

  if (newSignal.category === "unknown") {
    diffs.push({
      field: "category",
      severity: "info",
      description: `Category is "unknown" — AI classification not yet run in new pipeline`,
    });
  }

  return diffs;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the Slack shadow comparison for a single signal.
 *
 * Called at the end of processSlackStep when signalEvent_shadow is true.
 * The caller provides contentHash (already computed by the step) to avoid
 * re-hashing the transcript.
 *
 * @param normInput   The same inputs used to normalize the signal
 * @param contentHash The contentHash the old pipeline computed
 * @param username    User to scope the shadow log to
 */
export async function runSlackShadow(
  normInput: SlackNormalizerInput,
  contentHash: string,
  username: string
): Promise<void> {
  const { payload } = normInput;
  const comparedAt = new Date().toISOString();

  // Derive the "old pipeline" title the same way the old pipeline does —
  // it uses channelName as the sourceRef title for Slack
  const old: OldPipelineSummary = {
    sourceRef: payload.externalId,
    title: payload.channelName,
    source: "slack",
    contentHash,
  };

  let newSignal: SignalEvent | undefined;
  let normalizerError: string | undefined;
  let diffs: ShadowDiff[] = [];
  let isMatch = false;

  try {
    newSignal = normalizeSlackSignal(normInput);
    diffs = diffSlackSignals(newSignal, old);
    isMatch = diffs.every((d) => d.severity === "info");
  } catch (err) {
    normalizerError = err instanceof Error ? err.message : String(err);
    diffs = [{
      field: "normalizer",
      severity: "critical",
      description: `Slack normalizer threw: ${normalizerError}`,
    }];
    isMatch = false;
  }

  const comparison: ShadowComparison = {
    comparedAt,
    sourceRef: payload.externalId,
    isMatch,
    diffs,
    newSignal: newSignal
      ? {
          id: newSignal.id,
          source: newSignal.source,
          externalId: newSignal.externalId,
          sourceRef: newSignal.sourceRef,
          rawHash: newSignal.rawHash,
          eventType: newSignal.eventType,
          category: newSignal.category,
          occurredAt: newSignal.occurredAt,
          title: newSignal.title,
          snippet: newSignal.snippet,
          trust: newSignal.trust,
        }
      : ({} as ShadowComparison["newSignal"]),
    oldPipelineSummary: old,
    ...(normalizerError ? { normalizerError } : {}),
  };

  try {
    await appendToSlackShadowLog(username, comparison);
  } catch (err) {
    console.error(
      "[slack-shadow-runner] Failed to write shadow log — signal processing unaffected:",
      err instanceof Error ? err.message : err
    );
  }

  if (!isMatch) {
    const criticals = diffs.filter((d) => d.severity === "critical").length;
    const warnings = diffs.filter((d) => d.severity === "warning").length;
    console.warn(
      `[slack-shadow-runner] MISMATCH for ${payload.externalId}: ` +
      `${criticals} critical, ${warnings} warning diffs`
    );
  } else {
    console.log(`[slack-shadow-runner] MATCH for ${payload.externalId}`);
  }
}
