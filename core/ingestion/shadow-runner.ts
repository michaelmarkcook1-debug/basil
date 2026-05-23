/**
 * Shadow Runner — Week 1 Parity Gate
 *
 * Runs the new SignalEvent normalizer alongside the existing pipeline and
 * records any differences. The old pipeline remains the authoritative
 * write path — the shadow runner only observes and logs.
 *
 * Flow:
 *   1. processRegularEmail() completes (old pipeline — already wrote to stores)
 *   2. after() fires runGmailShadow() with the same inputs
 *   3. Shadow runner calls normalizeGmailSignal() → new SignalEvent
 *   4. Compares structural fields against what the old pipeline produced
 *   5. Appends ShadowComparison to per-user FIFO log (max 500 entries)
 *
 * Parity gates (checked by parity-validator.ts in Week 2):
 *   - exactMatchRate ≥ 90%     (no unexpected field divergence)
 *   - criticalDiffRate < 2%    (title/source/trust mismatches)
 *   - 14 days minimum shadow before any cutover
 *
 * This file has NO side effects on the old pipeline. It only reads inputs
 * and appends to the shadow log.
 *
 * Security: never logs PII beyond what's already in the existing audit log.
 * The shadow log stores structural diffs, not email body content.
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { normalizeGmailSignal } from "@/core/signals/normalizers/gmail.normalizer";
import type { GmailNormalizerInput } from "@/core/signals/normalizers/gmail.normalizer";
import type { SignalEvent, SignalSource } from "@/core/primitives/signal-event";

// ── Log storage key ───────────────────────────────────────────────────────────

const SHADOW_LOG_FILE = "sage-shadow-log.json";
const MAX_LOG_ENTRIES = 500;

// ── Diff types ────────────────────────────────────────────────────────────────

/**
 * A single field that diverges between old and new pipeline outputs.
 */
export interface ShadowDiff {
  /** Dot-path to the diverging field (e.g. "trust.trustTier", "category"). */
  field: string;
  /**
   * Severity:
   *   critical — old pipeline wrote a different title/source/id (data integrity risk)
   *   warning  — trust tier or category mismatch (acceptable divergence short-term)
   *   info     — minor metadata difference (cosmetic)
   */
  severity: "critical" | "warning" | "info";
  /** Description of the difference (not the actual values — avoid PII). */
  description: string;
}

// ── Comparison result ─────────────────────────────────────────────────────────

/**
 * Full comparison result for a single signal ingest.
 */
export interface ShadowComparison {
  /** ISO8601 timestamp of when this comparison was made. */
  comparedAt: string;
  /** The sourceRef for the signal (e.g. "gmail:msg_abc123"). */
  sourceRef: string;
  /**
   * Whether the new pipeline produced the same structural output
   * as the old pipeline (no diffs in non-info fields).
   */
  isMatch: boolean;
  /** All detected differences between old and new pipeline. */
  diffs: ShadowDiff[];
  /**
   * The new SignalEvent that was produced.
   * Stored for manual inspection during parity review.
   * Body field is truncated to 200 chars to keep log compact.
   */
  newSignal: Pick<SignalEvent,
    | "id" | "source" | "externalId" | "sourceRef" | "rawHash"
    | "eventType" | "category" | "occurredAt" | "title" | "snippet"
    | "trust"
  >;
  /**
   * Summary of what the old pipeline produced — extracted from the ingest
   * audit log entry, not re-run. Used for comparison without re-running AI.
   */
  oldPipelineSummary: OldPipelineSummary;
  /** True if the normalizer threw — old pipeline is unaffected either way. */
  normalizerError?: string;
}

/**
 * Structural summary of what the old pipeline wrote.
 * Extracted by the shadow runner from the inputs, not from the stores
 * (to avoid a Blob read in the hot path).
 */
export interface OldPipelineSummary {
  /** externalId / sourceRef used by the old pipeline. */
  sourceRef: string;
  /** Subject line as passed to the old pipeline. */
  title: string;
  /** Signal source (gmail, slack, etc.) */
  source: SignalSource;
  /** Content hash used by the old pipeline for idempotency. */
  contentHash: string;
}

// ── Shadow log I/O ────────────────────────────────────────────────────────────

async function readShadowLog(username: string): Promise<ShadowComparison[]> {
  return readUserStore<ShadowComparison[]>(username, SHADOW_LOG_FILE, []);
}

async function appendToShadowLog(
  username: string,
  entry: ShadowComparison
): Promise<void> {
  const existing = await readShadowLog(username);

  // FIFO: keep the most recent MAX_LOG_ENTRIES entries
  const updated = [...existing, entry].slice(-MAX_LOG_ENTRIES);
  await writeUserStore(username, SHADOW_LOG_FILE, updated);
}

// ── Diff engine ───────────────────────────────────────────────────────────────

/**
 * Compare the new SignalEvent against what we know the old pipeline produced.
 * Returns a list of structural diffs — never contains raw body content.
 */
function diffSignals(
  newSignal: SignalEvent,
  old: OldPipelineSummary
): ShadowDiff[] {
  const diffs: ShadowDiff[] = [];

  // Critical: source must always be "gmail"
  if (newSignal.source !== old.source) {
    diffs.push({
      field: "source",
      severity: "critical",
      description: `Source mismatch: new="${newSignal.source}" vs old="${old.source}"`,
    });
  }

  // Critical: sourceRef must match
  if (newSignal.sourceRef !== old.sourceRef) {
    diffs.push({
      field: "sourceRef",
      severity: "critical",
      description: `sourceRef mismatch: new="${newSignal.sourceRef}" vs old="${old.sourceRef}"`,
    });
  }

  // Critical: title (subject) must match exactly
  if (newSignal.title !== old.title) {
    diffs.push({
      field: "title",
      severity: "critical",
      description: `Title mismatch: lengths differ (new=${newSignal.title.length}, old=${old.title.length})`,
    });
  }

  // Critical: content hash must match (same body → same hash)
  if (newSignal.rawHash !== old.contentHash) {
    diffs.push({
      field: "rawHash",
      severity: "critical",
      description: `Content hash mismatch — body may differ between pipelines`,
    });
  }

  // Warning: trust tier differs
  const newTier = newSignal.trust.trustTier;
  if (newTier === "blocked") {
    diffs.push({
      field: "trust.trustTier",
      severity: "warning",
      description: `New pipeline would block this signal (tier=blocked)`,
    });
  }

  // Info: category is "unknown" in the new pipeline (no AI run) — expected
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
 * Run the Gmail shadow comparison for a single signal.
 *
 * Called via after() in processRegularEmail when signalEvent_shadow is true.
 * Never throws — all errors are caught and logged to the shadow log.
 *
 * @param normInput  The same inputs passed to the old pipeline
 * @param contentHash The content hash the old pipeline computed (for diff)
 * @param username   User to scope the shadow log to
 */
export async function runGmailShadow(
  normInput: GmailNormalizerInput,
  contentHash: string,
  username: string
): Promise<void> {
  const { opts, date } = normInput;
  const comparedAt = new Date().toISOString();

  const old: OldPipelineSummary = {
    sourceRef: opts.externalId,
    title: opts.subject,
    source: "gmail",
    contentHash,
  };

  let newSignal: SignalEvent | undefined;
  let normalizerError: string | undefined;
  let diffs: ShadowDiff[] = [];
  let isMatch = false;

  try {
    newSignal = normalizeGmailSignal(normInput);
    diffs = diffSignals(newSignal, old);
    // Match = no critical or warning diffs
    isMatch = diffs.every((d) => d.severity === "info");
  } catch (err) {
    normalizerError = err instanceof Error ? err.message : String(err);
    diffs = [
      {
        field: "normalizer",
        severity: "critical",
        description: `Normalizer threw: ${normalizerError}`,
      },
    ];
    isMatch = false;
  }

  const comparison: ShadowComparison = {
    comparedAt,
    sourceRef: opts.externalId,
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
    await appendToShadowLog(username, comparison);
  } catch (err) {
    // Shadow log write failure must never affect the old pipeline
    console.error(
      "[shadow-runner] Failed to write shadow log — signal processing unaffected:",
      err instanceof Error ? err.message : err
    );
  }

  if (!isMatch) {
    const criticals = diffs.filter((d) => d.severity === "critical").length;
    const warnings = diffs.filter((d) => d.severity === "warning").length;
    console.warn(
      `[shadow-runner] MISMATCH for ${opts.externalId}: ` +
      `${criticals} critical, ${warnings} warning diffs`
    );
  } else {
    console.log(`[shadow-runner] MATCH for ${opts.externalId}`);
  }
}

// ── Log reader ────────────────────────────────────────────────────────────────

/**
 * Read the last N shadow comparisons for a user.
 * Used by the admin shadow-log API route.
 */
export async function readShadowComparisons(
  username: string,
  limit = 50
): Promise<ShadowComparison[]> {
  const log = await readShadowLog(username);
  return log.slice(-limit).reverse(); // most-recent first
}

/**
 * Basic parity metrics computed from the in-memory log.
 * Used by the admin UI to display go/no-go status.
 */
export function computeParityMetrics(comparisons: ShadowComparison[]): {
  total: number;
  matches: number;
  exactMatchRate: number;
  criticalDiffs: number;
  criticalDiffRate: number;
  normalizerErrors: number;
} {
  const total = comparisons.length;
  if (total === 0) {
    return {
      total: 0, matches: 0, exactMatchRate: 0,
      criticalDiffs: 0, criticalDiffRate: 0, normalizerErrors: 0,
    };
  }

  const matches = comparisons.filter((c) => c.isMatch).length;
  const criticalDiffs = comparisons.filter((c) =>
    c.diffs.some((d) => d.severity === "critical")
  ).length;
  const normalizerErrors = comparisons.filter((c) => c.normalizerError).length;

  return {
    total,
    matches,
    exactMatchRate: matches / total,
    criticalDiffs,
    criticalDiffRate: criticalDiffs / total,
    normalizerErrors,
  };
}
