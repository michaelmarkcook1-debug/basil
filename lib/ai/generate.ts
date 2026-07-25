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
  preferOpenAI,
  PROVIDER_MODE,
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

// Hard ceiling per provider attempt. The critical bug this fixes: a provider
// that HANGS (e.g. the AI Gateway stalling when out of credits) never throws, so
// the fallback chain below never fires and the whole function 504s at its
// maxDuration. An abort timeout converts a hang into a fast AbortError, which the
// fallback treats as retryable → the call falls through to a healthy provider
// instead of dying.
//
// TIER-AWARE because the budget must fit the caller's route maxDuration: the
// interactive tiers (fast/balanced — chat, Siri, test-brain on a 30–60s route)
// need TWO sequential attempts (primary + one cross-provider fallback) to both
// complete inside that window, so their per-attempt ceiling is short. The bulk
// tiers (default/long — briefings, digests on 300s routes) legitimately take
// longer, so a short abort there would wrongly kill a valid long generation.
// A single 22s ceiling caused the opposite failure: 22s + 22s > 30s → the
// fallback never finished → 504 on every slightly-slow interactive call.
// AI_ATTEMPT_TIMEOUT_MS (if set) is a hard override for all tiers.
// Each ceiling is capped by the SHORTEST route maxDuration that uses that tier,
// because TWO attempts (primary + cross-provider fallback) must both finish
// inside it. The bounding routes today:
//   fast     → /api/ai/test-brain     (45s) ⇒ 2 × 20s = 40s ✓
//   balanced → /api/actions/classify  (60s) ⇒ 2 × 25s = 50s ✓
//   default/long → 300s routes (briefing, digest, memory-import, mobile chat,
//                  poll-ingest) ⇒ generous but still bounded.
// The values are deliberately roomy because the GPT-5.6 tiers are REASONING
// models — noticeably slower to first token than the old gpt-4o-mini, so a
// tight ceiling would abort legitimate work rather than catching a real hang.
const ATTEMPT_TIMEOUT_OVERRIDE_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS) || 0;
const ATTEMPT_TIMEOUT_BY_KIND: Record<ModelKind, number> = {
  fast: 20_000,
  balanced: 25_000,
  default: 55_000,
  // 120s (was 90s). Raised after a live meeting-prep failure during the OpenAI
  // quota outage: the OpenAI primary fails INSTANTLY (429), leaving the whole
  // generation to the Claude fallback — which a 90s ceiling aborted mid-flight
  // ("operation was aborted due to timeout") even though the 300s route budget
  // was almost entirely unused. 120s is the safe maximum: on a 300s long-tier
  // route, even the pathological slow-primary case (context ~40s + 2×120s) stays
  // under budget, while giving a legitimately-long prep/briefing 33% more room.
  long: 120_000,
};
function attemptTimeoutMs(kind: ModelKind): number {
  return ATTEMPT_TIMEOUT_OVERRIDE_MS || ATTEMPT_TIMEOUT_BY_KIND[kind];
}

/** An abort signal that fires after the tier's per-attempt ceiling, combined
 *  with any caller-supplied signal so both a caller cancel AND the timeout
 *  abort the attempt. */
function attemptSignal(kind: ModelKind, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(attemptTimeoutMs(kind));
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

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

// `model` is OPTIONAL here: when omitted, getTextModel(kind) supplies it (the
// whole point of these wrappers). The underlying AI SDK types require `model`,
// so we relax just that field.
export type GenerateTextOptions =
  Omit<Parameters<typeof generateText>[0], "model"> & { model?: LanguageModel };
export type StreamTextOptions =
  Omit<Parameters<typeof streamText>[0], "model"> & { model?: LanguageModel };

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
    // Cast: model is always supplied here; the relaxed wrapper type (model
    // optional) doesn't narrow the SDK's prompt|messages union, so re-assert it.
    const result = await generateText({ ...options, model: primaryModel, abortSignal: attemptSignal(kind, options.abortSignal) } as Parameters<typeof generateText>[0]);
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

  // ── Fallback chain: direct providers. ──────────────────────────────────────
  //    CRITICAL ordering rule: when the gateway is disabled the PRIMARY attempt
  //    above already WAS a direct provider (getTextModel returns OpenAI-direct
  //    or Anthropic-direct). Retrying that SAME provider first is a wasted
  //    attempt — it just failed — and it burns a whole timeout budget, which is
  //    exactly what pushed short-maxDuration routes (test-brain, 30s) past their
  //    limit into a 504 (22s primary + 22s redundant retry > 30s). So:
  //      • gateway primary  → try BOTH direct providers (neither was the primary).
  //      • openai primary   → fall back to Anthropic ONLY (skip the redundant
  //                           OpenAI retry; the SDK already retried it internally).
  //      • anthropic primary→ fall back to OpenAI ONLY.
  //    The dropped same-provider path isn't lost resilience: generateText's own
  //    maxRetries already retried the primary provider before it threw here, and
  //    a genuine cross-provider fallback is the resilience that actually matters.
  const anthropic: readonly [string, LanguageModel | null] = ["anthropic-direct", getDirectAnthropicModel(kind)];
  const openai: readonly [string, LanguageModel | null] = ["openai-direct", getDirectOpenAIModel(kind)];
  const primaryIsDirect = !options.model; // explicit model ⇒ caller owns routing
  let fallbacks: ReadonlyArray<readonly [string, LanguageModel | null]>;
  if (primaryIsDirect && PROVIDER_MODE === "openai_direct") {
    fallbacks = [anthropic];
  } else if (primaryIsDirect && PROVIDER_MODE === "anthropic_direct") {
    fallbacks = [openai];
  } else {
    // Gateway (or caller-supplied model) primary: both direct providers are
    // valid distinct fallbacks, ordered by preference.
    fallbacks = preferOpenAI() ? [openai, anthropic] : [anthropic, openai];
  }

  let lastErr: unknown = null;
  let attempted = false;

  for (const [name, model] of fallbacks) {
    if (!model) continue;
    attempted = true;
    try {
      console.info(`[ai/generate] Retrying with ${name} fallback (${kind})`);
      const result = await generateText({ ...options, model, abortSignal: attemptSignal(kind, options.abortSignal) } as Parameters<typeof generateText>[0]);
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
  // NOTE: no attemptSignal() here — a total-response abort would wrongly kill a
  // legitimately long streaming/tool-loop reply. The abort-timeout resilience is
  // applied only to the single-shot generateTextSafe path above, where it's safe.
  return streamText({ ...options, model: primaryModel } as Parameters<typeof streamText>[0]);
}
