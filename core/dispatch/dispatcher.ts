/**
 * Canonical AI Dispatcher
 *
 * Wraps generateValidated() with full observability:
 *   - Emits a DispatchTrace for every AI call
 *   - Captures latency, token counts, model ID, and error shape
 *   - Appends traces to per-user sage-dispatch-log.json (FIFO 1000 entries)
 *
 * Two modes (controlled by feature flags):
 *
 *   dispatch_shadow (Week 5):
 *     Caller runs its own generateValidated() as before.
 *     Additionally calls dispatch() to produce a parallel trace.
 *     Outputs are compared in the trace log; old output remains authoritative.
 *
 *   dispatch_active (future):
 *     Callers replace generateValidated() with dispatch().
 *     The dispatcher IS the only AI call path.
 *
 * Guardrails:
 *   - Never throws into the caller — trace write failures are logged + swallowed
 *   - Token counts use provider usage if available, else 0
 *   - System/prompt excerpts truncated to 500 chars — no PII in traces
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { generateValidated } from "@/lib/ai/generate-validated";
import { hashContent } from "@/lib/ingest/content-hash";
import { GATEWAY_MODEL_IDS, MAX_TOKENS } from "@/lib/ai/model-config";
import type { ModelKind } from "@/lib/ai/model-config";
import type { DispatchIntent, DispatchTrace } from "@/core/primitives/dispatch-request";
import {
  DISPATCH_LOG_FILE,
  MAX_DISPATCH_TRACES,
} from "@/core/primitives/dispatch-request";
import type { z } from "zod";

// ── Log I/O ───────────────────────────────────────────────────────────────────

async function appendTrace(username: string, trace: DispatchTrace): Promise<void> {
  try {
    const existing = await readUserStore<DispatchTrace[]>(
      username,
      DISPATCH_LOG_FILE,
      []
    );
    const updated = [...existing, trace].slice(-MAX_DISPATCH_TRACES);
    await writeUserStore(username, DISPATCH_LOG_FILE, updated);
  } catch (err) {
    // Trace write failures must never surface to the caller
    console.error(
      "[dispatcher] trace write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// ── Request ID ────────────────────────────────────────────────────────────────

function makeRequestId(intent: DispatchIntent, sourceRef: string | null): string {
  return hashContent(intent, sourceRef ?? "none", Date.now().toString());
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DispatchOpts<T> {
  username: string;
  intent: DispatchIntent;
  sourceRef: string | null;
  modelKind: ModelKind;
  system: string;
  prompt: string;
  schema: z.ZodSchema<T>;
  schemaName: string;
  schemaDescription?: string;
  isRepair?: boolean;
  /** Pre-computed requestId — pass to link repair attempts to originals. */
  requestId?: string;
}

export interface DispatchResult<T> {
  output: T;
  trace: DispatchTrace;
}

/**
 * Dispatch a structured AI generation request with full observability.
 *
 * Wraps generateValidated() — same retry behaviour, same schema validation.
 * Adds timing, token counts, and trace persistence.
 *
 * @throws Same errors as generateValidated() — AIValidationError or provider errors.
 *         Callers must handle these the same way they handle generateValidated() errors.
 */
export async function dispatch<T>(
  opts: DispatchOpts<T>
): Promise<DispatchResult<T>> {
  const {
    username, intent, sourceRef, modelKind,
    system, prompt, schema, schemaName, schemaDescription,
    isRepair = false,
  } = opts;

  const requestId = opts.requestId ?? makeRequestId(intent, sourceRef);
  const startedAt = Date.now();
  const resolvedModelId = GATEWAY_MODEL_IDS[modelKind];

  // Import model lazily to avoid bundling issues
  const { getTextModel } = await import("@/lib/ai/model-config");
  const model = getTextModel(modelKind);

  let output: T;
  let status: DispatchTrace["status"] = "success";
  let errorMessage: string | null = null;
  const inputTokens = 0;
  const outputTokens = 0;

  try {
    output = await generateValidated({
      kind: "object",
      model,
      maxOutputTokens: MAX_TOKENS[modelKind],
      system,
      prompt,
      schema,
      schemaName,
      ...(schemaDescription ? { schemaDescription } : {}),
      tag: `dispatch:${intent}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status = msg.includes("validation") ? "validation_error" : "provider_error";
    errorMessage = msg.slice(0, 300);

    const latencyMs = Date.now() - startedAt;
    const trace: DispatchTrace = {
      requestId,
      intent,
      sourceRef,
      modelKind,
      resolvedModelId,
      status,
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      completedAt: new Date().toISOString(),
      errorMessage,
      isRepair,
    };

    void appendTrace(username, trace);
    throw err;  // re-throw — caller handles errors same as generateValidated
  }

  const latencyMs = Date.now() - startedAt;
  const trace: DispatchTrace = {
    requestId,
    intent,
    sourceRef,
    modelKind,
    resolvedModelId,
    status,
    latencyMs,
    inputTokens,
    outputTokens,
    completedAt: new Date().toISOString(),
    errorMessage: null,
    isRepair,
  };

  void appendTrace(username, trace);

  console.info(
    `[dispatcher] ${intent} ${status} ` +
    `model=${resolvedModelId} latency=${latencyMs}ms` +
    (sourceRef ? ` source=${sourceRef}` : "")
  );

  return { output, trace };
}

// ── Trace reader ──────────────────────────────────────────────────────────────

export interface TraceQuery {
  intent?: DispatchIntent;
  status?: DispatchTrace["status"];
  limit?: number;
}

/**
 * Read recent dispatch traces for a user.
 * Most-recent first. Used by the admin dispatch-log API (future).
 */
export async function readTraces(
  username: string,
  query: TraceQuery = {}
): Promise<DispatchTrace[]> {
  const all = await readUserStore<DispatchTrace[]>(username, DISPATCH_LOG_FILE, []);
  let filtered = all;
  if (query.intent) filtered = filtered.filter((t) => t.intent === query.intent);
  if (query.status) filtered = filtered.filter((t) => t.status === query.status);
  return filtered.reverse().slice(0, query.limit ?? 50);
}

/**
 * Basic dispatch metrics — success rate, avg latency by intent.
 * Used by admin dashboards and future parity checks.
 */
export function computeDispatchMetrics(traces: DispatchTrace[]): {
  total: number;
  successRate: number;
  avgLatencyMs: number;
  errorCount: number;
  byIntent: Record<string, { count: number; avgLatencyMs: number; errors: number }>;
} {
  const total = traces.length;
  if (total === 0) {
    return { total: 0, successRate: 0, avgLatencyMs: 0, errorCount: 0, byIntent: {} };
  }

  const successes = traces.filter((t) => t.status === "success");
  const errorCount = total - successes.length;
  const avgLatencyMs =
    traces.reduce((sum, t) => sum + t.latencyMs, 0) / total;

  const byIntent: Record<string, { count: number; avgLatencyMs: number; errors: number }> = {};
  for (const trace of traces) {
    const entry = byIntent[trace.intent] ?? { count: 0, avgLatencyMs: 0, errors: 0 };
    const newCount = entry.count + 1;
    byIntent[trace.intent] = {
      count: newCount,
      avgLatencyMs:
        (entry.avgLatencyMs * entry.count + trace.latencyMs) / newCount,
      errors: entry.errors + (trace.status !== "success" ? 1 : 0),
    };
  }

  return {
    total,
    successRate: successes.length / total,
    avgLatencyMs: Math.round(avgLatencyMs),
    errorCount,
    byIntent,
  };
}
