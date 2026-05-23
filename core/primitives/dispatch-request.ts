/**
 * Primitive 3 — DispatchRequest
 *
 * The canonical contract for every AI call in Basil. Every generateText /
 * generateValidated call site that opts in emits a DispatchRequest, which
 * the dispatcher logs as a DispatchTrace — making AI reasoning fully observable.
 *
 * Design goals:
 *   - Observable: every AI call produces a traceable artifact
 *   - Auditable: inputs, model, latency, and output shape are persisted
 *   - Shadow-safe: dispatch_shadow logs traces without changing output
 *   - Typed: intent is a discriminated union, not a free string
 *
 * Migration path:
 *   dispatch_shadow  → existing call + trace log (no output change)
 *   dispatch_active  → all AI calls route through dispatcher (replaces direct calls)
 */

import type { ModelKind } from "@/lib/ai/model-config";

// ── Intent ────────────────────────────────────────────────────────────────────

/**
 * Discriminated intent — what task is this AI call performing?
 * Used for routing, cost attribution, and trace filtering.
 */
export type DispatchIntent =
  | "classify_email"
  | "classify_slack"
  | "classify_zoom"
  | "materialize_email"
  | "materialize_slack"
  | "materialize_zoom"
  | "generate_briefing"
  | "generate_digest"
  | "generate_meeting_prep"
  | "generate_reply"
  | "extract_contact_profile"
  | "discover_contact"
  | "repair_output";       // retry/repair pass from generateValidated

// ── Request ───────────────────────────────────────────────────────────────────

export interface DispatchRequest {
  /**
   * Unique request ID — sha256 of (intent + sourceRef + timestamp), 16 chars.
   * Stable within a retry chain; the repair attempt uses the same requestId.
   */
  requestId: string;

  /** What task this AI call is performing. */
  intent: DispatchIntent;

  /**
   * Source reference for the signal triggering this call.
   * e.g. "gmail:msg_abc123", "slack:C01ABC:123456.789"
   * null for non-signal-scoped calls (briefing, digest).
   */
  sourceRef: string | null;

  /** Model tier requested by the call site. */
  modelKind: ModelKind;

  /** The system prompt, truncated to 500 chars for the trace (no PII). */
  systemExcerpt: string;

  /** The user prompt, truncated to 500 chars for the trace (no PII). */
  promptExcerpt: string;

  /** ISO8601 — when this request was created. */
  requestedAt: string;

  /**
   * Username on whose behalf this call is made.
   * Used for per-user cost attribution in the trace log.
   */
  username: string;
}

// ── Result / Trace ────────────────────────────────────────────────────────────

export type DispatchStatus = "success" | "validation_error" | "provider_error" | "timeout";

export interface DispatchTrace {
  /** Matches DispatchRequest.requestId */
  requestId: string;

  intent: DispatchIntent;
  sourceRef: string | null;
  modelKind: ModelKind;

  /** Resolved model ID that was actually used (e.g. "anthropic/claude-haiku-4.5") */
  resolvedModelId: string;

  status: DispatchStatus;

  /** Wall-clock latency in milliseconds. */
  latencyMs: number;

  /** Input token count from the provider response (0 if unavailable). */
  inputTokens: number;

  /** Output token count from the provider response (0 if unavailable). */
  outputTokens: number;

  /** ISO8601 — when the call completed (or failed). */
  completedAt: string;

  /** Error message if status !== "success". null otherwise. */
  errorMessage: string | null;

  /**
   * Whether this was a repair (second attempt) call.
   * Repair calls share the requestId of the original attempt.
   */
  isRepair: boolean;
}

// ── Log storage ───────────────────────────────────────────────────────────────

export const DISPATCH_LOG_FILE = "sage-dispatch-log.json";
export const MAX_DISPATCH_TRACES = 1_000;
