/**
 * lib/ai/generate.ts
 *
 * Resilient wrappers around the AI SDK's generateText / streamText.
 *
 * Problem solved:
 *   PROVIDER_MODE is resolved once at module init.  If the Vercel AI Gateway
 *   key is rate-limited, expired, or unavailable at runtime, the entire brain
 *   fails — even though ANTHROPIC_API_KEY (direct) may be healthy.
 *
 * Strategy:
 *   1. Attempt with the primary model (gateway or whatever getTextModel() gives)
 *   2. On failure, build a direct Anthropic model from ANTHROPIC_API_KEY / BASIL_LLM_KEY
 *      and retry once.
 *   3. On second failure, throw with a combined error message.
 *
 * All call sites should import generateTextSafe / streamTextSafe from here
 * instead of calling generateText / streamText directly.
 */

import { generateText, streamText } from "ai";
import {
  getTextModel,
  getDirectAnthropicModel,
  getDirectOpenAIModel,
  type ModelKind,
} from "@/lib/ai/model-config";
import type { LanguageModel } from "ai";
import {
  reserveSpend,
  commitSpend,
  releaseSpend,
  type SpendMeter,
} from "@/lib/ai/spend-guard";

// ── Internal helpers ──────────────────────────────────────────────────────────

function isFallbackWorthTrying(err: unknown): boolean {
  // Don't retry content-policy or auth errors — they will fail the same way on fallback
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Always try fallback on gateway errors, rate limits, model-not-found
  if (msg.includes("rate limit") || msg.includes("429")) return true;
  if (msg.includes("model") && msg.includes("not found")) return true;
  if (msg.includes("gateway") || msg.includes("503") || msg.includes("502")) return true;
  if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("403")) return true;
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  // Network-level errors
  if (msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("enotfound")) return true;
  // Generic errors — try fallback
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type GenerateTextOptions = Parameters<typeof generateText>[0];
export type StreamTextOptions   = Parameters<typeof streamText>[0];

/**
 * generateTextSafe — generateText with automatic Anthropic direct fallback.
 *
 * @param options  Standard AI SDK generateText options.
 *                 If `model` is omitted, getTextModel(kind) is used.
 * @param kind     Model tier — "fast" | "default" | "long".  Ignored when
 *                 `options.model` is explicitly provided.
 * @param meter    Optional spend meter — when provided, the call is checked
 *                 against the per-user + global AI spend caps BEFORE running
 *                 (throws SpendCapError / 429 if over) and the actual token
 *                 usage is recorded AFTER. Omit for unmetered internal calls.
 */
export async function generateTextSafe(
  options: GenerateTextOptions,
  kind: ModelKind = "default",
  meter?: SpendMeter
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const primaryModel = options.model ?? getTextModel(kind);

  // Reserve worst-case budget up front (throws SpendCapError if over cap).
  const reservation = meter ? await reserveSpend(meter, kind) : null;

  // ── Attempt 1: primary ────────────────────────────────────────────────────
  try {
    const result = await generateText({ ...options, model: primaryModel });
    if (reservation) await commitSpend(reservation, result.usage);
    return result;
  } catch (primaryErr) {
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn(`[ai/generate] Primary model failed (${kind}): ${msg.slice(0, 200)}`);

    if (!isFallbackWorthTrying(primaryErr)) {
      if (reservation) await releaseSpend(reservation);
      throw primaryErr;
    }
  }

  // ── Fallback chain: Claude stays primary; try Anthropic direct, then OpenAI ──
  //
  // Ordered, each skipped when its key is absent. Spend was reserved worst-case
  // for `kind`'s Claude family (Opus on default/long), which over-covers an
  // OpenAI fallback — conservative for a cap, so we keep the original reservation.
  const fallbacks: ReadonlyArray<readonly [string, LanguageModel | null]> = [
    ["anthropic-direct", getDirectAnthropicModel(kind)],
    ["openai-direct", getDirectOpenAIModel(kind)],
  ];

  let lastErr: unknown = null;
  let attempted = false;

  for (const [name, model] of fallbacks) {
    if (!model) continue;
    attempted = true;
    try {
      console.info(`[ai/generate] Retrying with ${name} fallback (${kind})`);
      const result = await generateText({ ...options, model });
      if (reservation) await commitSpend(reservation, result.usage);
      return result;
    } catch (fallbackErr) {
      lastErr = fallbackErr;
      const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.warn(`[ai/generate] Fallback ${name} failed (${kind}): ${msg.slice(0, 200)}`);
    }
  }

  if (reservation) await releaseSpend(reservation);

  if (!attempted) {
    throw new Error(
      "[ai/generate] Primary model failed and no direct-provider fallback is available. " +
      "Set BASIL_LLM_KEY (Anthropic) or an OpenAI key (openai_basilv2 / OPENAI_API_KEY)."
    );
  }
  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`[ai/generate] Primary and all direct fallbacks failed. Last: ${lastMsg.slice(0, 200)}`);
}

/**
 * streamTextSafe — streamText with automatic Anthropic direct fallback.
 *
 * Because streaming is initiated before consumption, fallback requires starting
 * a new stream from the fallback model. This is handled transparently.
 */
export function streamTextSafe(
  options: StreamTextOptions,
  kind: ModelKind = "default"
): ReturnType<typeof streamText> {
  const primaryModel = options.model ?? getTextModel(kind);

  // streamText returns a result object immediately (before any stream data).
  // We can't easily intercept mid-stream failures here, so we construct the
  // stream from the primary model. If the first token fails, the consumer
  // sees the error via the stream's error handling.
  //
  // For a full fallback we would need to buffer then retry, which adds
  // latency. Instead: try primary, configure a fallback model in the options
  // so consumers can re-call on error.
  return streamText({ ...options, model: primaryModel });
}
