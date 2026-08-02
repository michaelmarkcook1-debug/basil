/**
 * Centralised AI model configuration.
 *
 * Single source of truth for model selection. All generateText / streamText
 * call sites import `getTextModel` from here — zero hardcoded model IDs elsewhere.
 *
 * Tiering policy (verified live against ai-gateway.vercel.sh/v1/models):
 *   fast    → Haiku 4.5  — data-fetch shaped work: classification, light
 *                         extraction, structured JSON. The model is just
 *                         routing or labelling, not reasoning.
 *   default → Opus 4.8   — chat (Ask Basil), contact profile generation,
 *                         anything where reasoning quality matters more than
 *                         latency or token cost.
 *   long    → Opus 4.8   — daily briefings, digests, meeting prep. Same model
 *                         as default but with a higher max-output token cap.
 *
 * TIERING POLICY — pick the tier by the NATURE OF THE WORK, not by how hot the
 * path is. (See OPENAI_MODEL_IDS below for the concrete models + rates.)
 *
 *   model: getTextModel("fast"),      // basic DATA GATHERING — pulling known
 *                                     //   fields out of text, connectivity probes
 *   model: getTextModel("balanced"),  // CATEGORIZATION — deciding what a thing IS
 *                                     //   (classify email / Slack / actions / Zoom)
 *   model: getTextModel(),            // CONTEXTUAL + REASONING — drafts, compose,
 *                                     //   ad-hoc generation
 *   model: getTextModel("long"),      // CONTEXTUAL + REASONING, long context —
 *                                     //   briefings, digests, meeting prep
 *
 * The assistant (Ask Basil) does NOT use these — its model is pinned; see
 * getChatModel().
 *
 * Provider resolution order:
 *   1. VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY  → Vercel AI Gateway (preferred)
 *   2. BASIL_LLM_KEY                           → Anthropic direct fallback
 *   3. openai_basilv2                          → OpenAI direct fallback
 *
 *   Locally:  run `vercel env pull .env.local` to provision VERCEL_OIDC_TOKEN.
 *   OIDC provides automatic token rotation — AI_GATEWAY_API_KEY is the manual alternative.
 */

import { gateway, wrapLanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelKind = "fast" | "balanced" | "default" | "long";

// Keep ProviderMode as a string alias for back-compat with call sites that read it
export type ProviderMode = "vercel_gateway" | "anthropic_direct" | "openai_direct";

/**
 * Whether the Vercel AI Gateway should be used. It's available only when it's
 * configured (OIDC token or gateway key) AND not explicitly disabled.
 *
 * Set AI_GATEWAY_DISABLED=1 to bypass the gateway — e.g. when the gateway
 * account is out of credits — and fall straight through to a direct provider
 * key (BASIL_LLM_KEY → OpenAI). EVERY provider-selection path honours this, so
 * the bypass actually takes effect (previously getTextModel ignored it and kept
 * hitting the dead gateway).
 */
export function isGatewayEnabled(): boolean {
  const disabled =
    process.env.AI_GATEWAY_DISABLED === "1" ||
    process.env.AI_GATEWAY_DISABLED === "true";
  return !disabled && !!(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

/**
 * Whether OpenAI should be the PRIMARY direct provider (ahead of Anthropic).
 *
 * Default is false → Claude (Anthropic direct) is primary, OpenAI is the
 * resilience fallback. Set AI_PREFER_OPENAI=1 to flip it: OpenAI becomes the
 * brain for chat (personality), briefings, and task structuring, with Anthropic
 * as the fallback. Used while Anthropic quota is exhausted, or as a deliberate
 * product choice. Flip the env var back to return to Claude-primary — no deploy
 * logic change needed beyond the redeploy that picks up the new env value.
 */
export function preferOpenAI(): boolean {
  return process.env.AI_PREFER_OPENAI === "1" || process.env.AI_PREFER_OPENAI === "true";
}

function resolveProviderMode(): ProviderMode {
  if (isGatewayEnabled()) return "vercel_gateway";
  const _ak = ["ANTHROPIC", "API", "KEY"].join("_");
  const _ok = ["OPENAI", "API", "KEY"].join("_");
  const hasAnthropic = !!(process.env.BASIL_LLM_KEY ?? process.env[_ak]);
  const hasOpenAI = !!(process.env.openai_basilv2 ?? process.env[_ok]);
  // When OpenAI is the preferred primary AND a key is present, report it as such.
  if (preferOpenAI() && hasOpenAI) return "openai_direct";
  if (hasAnthropic) return "anthropic_direct";
  if (hasOpenAI) return "openai_direct";
  return "anthropic_direct"; // will throw at call time
}

export const PROVIDER_MODE: ProviderMode = resolveProviderMode();

// ── Model IDs ─────────────────────────────────────────────────────────────────

/**
 * Vercel AI Gateway model slugs — "provider/model" with dots for version segments.
 */
export const GATEWAY_MODEL_IDS = {
  fast:    "anthropic/claude-haiku-4.5",
  // Sonnet 5 — the interactive/generation model across every user-facing surface
  // (Ask Basil chat, briefings, profiling) AND the down-tier target for
  // Free/trial plans. Verified live against ai-gateway.vercel.sh/v1/models.
  balanced: "anthropic/claude-sonnet-5",
  // default/long also run Sonnet 5 so "Ask Basil" is Sonnet 5 for every plan
  // (pro previously got Opus 4.8; switched per owner request to Sonnet 5).
  default: "anthropic/claude-sonnet-5",
  long:    "anthropic/claude-sonnet-5",
} as const satisfies Record<ModelKind, string>;

/**
 * Anthropic DIRECT model IDs — hyphenated, exactly as api.anthropic.com expects.
 * NOTE: these are NOT the gateway slugs. The gateway uses dotted versions
 * (anthropic/claude-opus-4.8); the direct Anthropic API uses hyphens
 * (claude-opus-4-8). Using the dotted form here makes the direct fallback 404
 * with model-not-found — which only surfaces once the gateway is disabled.
 */
export const ANTHROPIC_MODEL_IDS: Record<ModelKind, string> = {
  // fast (data-gathering: extraction, connectivity probes) stays on Haiku — the
  // work is mechanical, and Opus there would be pure waste.
  fast:     process.env.ANTHROPIC_MODEL_FAST     ?? "claude-haiku-4-5-20251001",
  // OWNER POLICY 2026-07-23: Anthropic is now the PRIMARY provider and Opus 5
  // serves the user-facing tiers.
  //   top  (default/long — Ask Basil, meeting prep, briefings) → Opus 5 @ HIGH
  // "claude-opus-5" is the direct-API form of the gateway's
  // anthropic/claude-opus-5 (both verified live against
  // ai-gateway.vercel.sh/v1/models — model ids are NEVER written from memory
  // here; guessing them caused a full outage once already).
  //
  // REVISED 2026-07-30 (owner-approved, cost): the mid tier no longer runs
  // Opus 5. Measured from the real spend log, classify:slack alone was 2,438
  // calls / 19.4M input / 387K output in a month — $60 and 79% of a single
  // day's $18.53, on a day the owner did not touch the app. The shape is the
  // giveaway: ~7,957 input → 159 output tokens, i.e. "what IS this Slack
  // thread", a bulk categorisation the cron runs 96×/day. Opus-grade reasoning
  // changes that verdict very little and costs 5× the input rate.
  //
  // The WORKLOAD→TIER policy is unchanged — categorisation still dispatches at
  // "balanced" (never "fast"), keeping its own tier, effort level and override.
  // Only what that tier RESOLVES to moved. Dial it back up with
  // ANTHROPIC_MODEL_BALANCED (claude-sonnet-5 ≈ $3/$15, claude-opus-5 ≈ $5/$25)
  // with no deploy if classification quality regresses.
  balanced: process.env.ANTHROPIC_MODEL_BALANCED ?? "claude-haiku-4-5-20251001",
  default:  process.env.ANTHROPIC_MODEL_DEFAULT  ?? "claude-opus-5",
  long:     process.env.ANTHROPIC_MODEL_LONG     ?? "claude-opus-5",
};

/**
 * Per-tier Anthropic reasoning EFFORT (`providerOptions.anthropic.effort`).
 *
 * Only set where we deliberately want deeper reasoning on the fallback — the
 * user-facing tiers now falling back to Opus 4.8. `effort` is an Opus-4.8-era
 * control, so it is intentionally NOT applied to the Haiku/Sonnet tiers (where
 * it would be meaningless or rejected). Env-overridable per tier.
 */
type AnthropicEffort = "low" | "medium" | "high" | "max";
const ANTHROPIC_EFFORT: Partial<Record<ModelKind, AnthropicEffort>> = {
  // NO `balanced` ENTRY — and this is load-bearing, not an omission.
  //
  // `effort` is an Opus-era parameter. Haiku 4.5 REJECTS it outright with
  // "This model does not support the effort parameter", which fails the call —
  // it does not degrade. `fast` has always been left out for exactly this
  // reason; when the mid tier moved to Haiku on 2026-07-30 it inherited the
  // same constraint. Leaving balanced: "low" here broke every Slack/email
  // classification in production within minutes of that deploy: primary AND
  // anthropic-direct fallback both failed on the parameter, and openai-direct
  // then failed on exhausted credits, so classification returned nothing at all.
  //
  // Rule: only tiers whose model actually supports `effort` may appear here.
  // If ANTHROPIC_MODEL_BALANCED is raised back to an Opus model, re-add
  // balanced: "low" alongside it — the two settings move together.
  //
  // Top tier is what a human reads: think hard.
  // Top tier is what a human reads: think hard.
  default:  (process.env.ANTHROPIC_EFFORT_DEFAULT  as AnthropicEffort) ?? "high",
  long:     (process.env.ANTHROPIC_EFFORT_LONG     as AnthropicEffort) ?? "high",
};

/**
 * OpenAI direct model IDs — the PRIMARY path (AI_PREFER_OPENAI is set).
 *
 * ── THE TIERING POLICY (owner-defined) ───────────────────────────────────────
 *   fast     → basic DATA GATHERING   → gpt-5.6-luna  ($1 / $6 per M)
 *   balanced → CATEGORIZATION         → gpt-5.6-terra ($2.50 / $15 per M)
 *   default  → CONTEXTUAL + REASONING → gpt-5.6-sol   ($5 / $30 per M)
 *   long     → CONTEXTUAL + REASONING → gpt-5.6-sol   (same, long context)
 *
 * Pick the tier by the NATURE OF THE WORK, not by how hot the path is:
 *   • Pulling/structuring known fields out of text → "fast".
 *   • Deciding what something IS (a label/category) → "balanced".
 *   • Producing judgement or prose a human reads   → "default"/"long".
 *
 * All three ids verified against the live ai-gateway.vercel.sh/v1/models list.
 * NOTE: a bare "gpt-5.6" DOES NOT EXIST — the series ships only as
 * luna/sol/terra. Guessing model ids is what caused a prior full AI outage
 * (the old defaults "gpt-5.5" and "gpt-5.4-mini" were phantoms and 404'd every
 * call), so every id here is copied from that live list.
 *
 * Each tier is independently env-overridable — retune cost without a deploy:
 *   OPENAI_MODEL_FAST · OPENAI_MODEL_BALANCED · OPENAI_MODEL_DEFAULT · OPENAI_MODEL_LONG
 *   OPENAI_MODEL — legacy global override, applied to any tier whose specific var is unset.
 */
export const OPENAI_MODEL_IDS: Record<ModelKind, string> = {
  fast:     process.env.OPENAI_MODEL_FAST     ?? process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? process.env.OPENAI_MODEL ?? "gpt-5.6-terra",
  default:  process.env.OPENAI_MODEL_DEFAULT  ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
  long:     process.env.OPENAI_MODEL_LONG     ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
};

// ── Token defaults ─────────────────────────────────────────────────────────────

/**
 * Hard output ceiling handed to the model (`maxOutputTokens`).
 *
 * ⚠️ THE GPT-5.6 TIERS ARE **REASONING** MODELS. Per the AI SDK OpenAI docs,
 * `maxOutputTokens` maps to `max_completion_tokens`, which for reasoning models
 * covers REASONING TOKENS **plus** the visible answer. So this ceiling is a
 * shared budget: if reasoning eats it, the user's answer is truncated
 * mid-sentence with no error — the response still returns 200 and looks
 * "successful".
 *
 * That is exactly what happened: 4_096 was fine for gpt-4o (not a reasoning
 * model), but on gpt-5.6-sol an 8-step tool loop spent the whole budget
 * thinking and cut Ask Basil off after "I found **10 demo sessions".
 *
 * These are generous on purpose (the 5.6 series supports max_tokens 128_000).
 * Reserving budget does NOT use these — see RESERVE_OUTPUT_TOKENS.
 */
export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:     8_000,
  balanced: 8_000,
  default:  32_000,
  long:     32_000,
};

/**
 * Realistic per-call output used only to RESERVE spend before a call.
 *
 * Deliberately DECOUPLED from MAX_TOKENS. The reservation is
 * worstCaseCostUsd(kind) × steps, so reserving at the raised ceiling would hold
 * ~$7.68 for a single 8-step chat message and trip the monthly cap with 429s
 * long before any real money was spent. The ceiling has to be generous for
 * reasoning headroom; the BUDGET only needs to be a sane estimate, because
 * commitSpend() reconciles to ACTUAL token usage the moment the call finishes.
 */
export const RESERVE_OUTPUT_TOKENS: Record<ModelKind, number> = {
  fast:     2_000,
  balanced: 3_000,
  default:  6_000,
  long:     8_000,
};

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that at least one AI provider is reachable.
 * Called from GET /api/system/health so misconfigurations surface early.
 */
export function validateModelConfig(): void {
  // isGatewayEnabled() (not raw token presence) so a DISABLED gateway doesn't
  // mask the absence of a usable direct key — the same condition getTextModel uses.
  const hasGateway  = isGatewayEnabled();
  const _ak         = ["ANTHROPIC", "API", "KEY"].join("_");
  const hasAnthropic = !!(process.env.BASIL_LLM_KEY ?? process.env[_ak]);
  const _ok         = ["OPENAI", "API", "KEY"].join("_");
  const hasOpenAI   = !!(process.env.openai_basilv2 ?? process.env[_ok]);
  if (!hasGateway && !hasAnthropic && !hasOpenAI) {
    throw new Error(
      "[ai/model-config] No usable AI provider. Set BASIL_LLM_KEY (Anthropic) or " +
      "OPENAI_API_KEY / openai_basilv2 (OpenAI), or enable the gateway " +
      "(unset AI_GATEWAY_DISABLED with VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY present)."
    );
  }
}

// ── Helpers kept for call-sites that imported them ────────────────────────────

/** @deprecated — use getTextModel() directly */
export function getOpenAIKey(): string | undefined { return undefined; }

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier.
 *
 * Resolution order:
 *   1. Vercel AI Gateway  — preferred; OIDC auto-injected on Vercel deployments.
 *   2. Anthropic direct   — BASIL_LLM_KEY fallback (e.g. when gateway not yet configured).
 *   3. OpenAI direct      — openai_basilv2 fallback (e.g. when Anthropic quota is exhausted).
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  // 1. Vercel AI Gateway — UNLESS disabled (AI_GATEWAY_DISABLED). Honouring the
  //    flag here is what lets a dead/credit-less gateway be bypassed: every AI
  //    call (chat's streamText, generateTextSafe, briefings) routes through this.
  if (isGatewayEnabled()) {
    return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
  }

  // 2 & 3. Direct providers, ordered by preference. Default: Anthropic (Claude)
  //         primary, OpenAI fallback. With AI_PREFER_OPENAI set: OpenAI primary
  //         (gpt-5.5 for chat/briefing/structuring), Anthropic fallback.
  if (preferOpenAI()) {
    const openaiModel = getDirectOpenAIModel(kind);
    if (openaiModel) return openaiModel;
    const anthropicModel = getDirectAnthropicModel(kind);
    if (anthropicModel) return anthropicModel;
  } else {
    const anthropicModel = getDirectAnthropicModel(kind);
    if (anthropicModel) return anthropicModel;
    const openaiModel = getDirectOpenAIModel(kind);
    if (openaiModel) return openaiModel;
  }

  throw new Error(
    "[ai/model-config] No usable AI provider. The gateway is " +
    (process.env.AI_GATEWAY_DISABLED ? "disabled via AI_GATEWAY_DISABLED" : "not configured") +
    " and no direct key is set. Set BASIL_LLM_KEY (Anthropic direct) or " +
    "OPENAI_API_KEY / openai_basilv2 (OpenAI direct), or re-enable the gateway."
  );
}

/**
 * ASSISTANT MODEL — "Ask Basil" (web chat, mobile chat, Siri/voice).
 *
 * Pinned to GPT-5.6 Sol (owner-specified): the flagship of the 5.6 series,
 * built for exactly the long-horizon agentic tool-loops Ask Basil runs
 * (calendar / email / Slack / Linear / web across up to 8 steps).
 *
 * Why the assistant does NOT resolve via getTextModel():
 *   1. getTextModel() resolves by TIER, and effectiveKind() down-tiers Free/
 *      trial plans — which would silently drop the assistant onto a cheaper
 *      model than the one specified.
 *   2. It honours AI_PREFER_OPENAI, a GLOBAL bulk-provider switch. Which model
 *      the assistant speaks with is a product decision, not a bulk-cost one.
 *   Pinning here makes "Ask Basil runs Sol" true regardless of either.
 *
 * ID FORMS DIFFER (this exact trap caused a prior outage): the gateway wants
 * "openai/gpt-5.6-sol"; the direct OpenAI API wants the bare "gpt-5.6-sol".
 * Both verified against the live ai-gateway.vercel.sh/v1/models list. NOTE:
 * plain "gpt-5.6" does NOT exist — the series ships as luna/sol/terra only.
 * Both are env-overridable so the model can change without a code deploy.
 */
/**
 * OWNER POLICY 2026-07-23: the assistant is pinned to **Claude Opus 5 @ effort
 * high**. GPT-5.6 Sol is now the resilience FALLBACK (the inverse of the prior
 * arrangement) — OpenAI ran out of credit three times in a week, so the model
 * that has to answer the user sits on the provider that stayed up.
 *
 * ID FORMS DIFFER (this exact trap caused a prior outage): the gateway wants
 * "anthropic/claude-opus-5", the direct Anthropic API wants the bare
 * "claude-opus-5". Both verified live against ai-gateway.vercel.sh/v1/models.
 * All three are env-overridable so the model can change without a deploy.
 */
export const CHAT_MODEL_GATEWAY_ID   = process.env.CHAT_MODEL_GATEWAY   ?? "anthropic/claude-opus-5";
export const CHAT_MODEL_ANTHROPIC_ID = process.env.CHAT_MODEL_ANTHROPIC ?? "claude-opus-5";
/** The assistant's FALLBACK model, used only when the pinned Opus 5 call fails. */
export const CHAT_MODEL_OPENAI_ID    = process.env.CHAT_MODEL_OPENAI    ?? "gpt-5.6-sol";
/** Reasoning effort for the pinned assistant model. */
export const CHAT_EFFORT: AnthropicEffort =
  (process.env.CHAT_EFFORT as AnthropicEffort) ?? "high";

/** One-line, readable cause for a failed provider call (AI SDK errors are often
 *  plain objects, so String(err) yields "[object Object]"). */
function briefProviderError(err: unknown): string {
  if (err instanceof Error) return (err.message || String(err.cause ?? "unknown Error")).slice(0, 300);
  try { return JSON.stringify(err).slice(0, 300); } catch { return String(err).slice(0, 300); }
}

/**
 * Fallback middleware for the PINNED assistant model.
 *
 * The trap this closes: Ask Basil is pinned to gpt-5.6-sol with NO fallback, so
 * the instant OpenAI is unreachable (the recurring quota/credit exhaustion) the
 * whole assistant dies — while the healthy Anthropic key sits unused. Background
 * classification already survives an OpenAI outage (generateTextSafe falls to
 * Claude); chat did not, because it drives a raw streamText.
 *
 * A quota/auth/outage error surfaces when the provider request is MADE — i.e.
 * `doStream()` / `doGenerate()` REJECT before any token is produced — so we can
 * transparently re-issue the identical call (same prompt, same tools, same
 * params) against Claude with nothing buffered and nothing lost. The user gets a
 * slightly different voice for that message instead of a dead chat, and the
 * pinned Sol model resumes automatically the moment OpenAI recovers.
 *
 * Only the request-time rejection is caught here (the quota case). A mid-stream
 * failure after tokens have flowed is not retried — that would double output.
 */
// Stream parts that carry no answer content — safe to buffer while we're still
// deciding whether the primary is really answering or about to error out.
const PROBE_BENIGN_PARTS = new Set(["stream-start", "response-metadata"]);

function chatFallbackMiddleware(fallback: LanguageModelV3): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream, params, model }) {
      const toFallback = (reason: string) => {
        console.error(
          `[ai/chat-fallback] ${model.modelId} stream failed → ${fallback.modelId}: ${reason}`
        );
        return fallback.doStream(params);
      };

      // (1) Request-time rejection — the SDK throws (e.g. a 429 before the stream
      //     even opens). Straightforward: nothing was emitted, swap to Claude.
      let primary;
      try {
        primary = await doStream();
      } catch (err) {
        return toFallback(briefProviderError(err));
      }

      // (2) In-stream failure — the harder case that made the first fix
      //     incomplete: OpenAI's insufficient_quota ACCEPTS the request, then
      //     emits an `error` STREAM PART (seen live as stream-start → error).
      //     A try/catch never sees that, so it reached streamText.onError and
      //     Ask Basil crashed. Probe the leading parts: if an error arrives
      //     before ANY answer content, switch to Claude with nothing lost; the
      //     instant real content appears, commit to the primary and pass through.
      const reader = primary.stream.getReader();
      const buffered: LanguageModelV3StreamPart[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break; // clean end after only benign parts → commit
          if (value.type === "error") {
            reader.releaseLock();
            return toFallback(briefProviderError(value.error));
          }
          buffered.push(value);
          if (!PROBE_BENIGN_PARTS.has(value.type)) break; // real content → commit
        }
      } catch (err) {
        reader.releaseLock();
        return toFallback(briefProviderError(err));
      }

      // Commit to the primary: replay the buffered lead-in, then the remainder.
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of buffered) controller.enqueue(part);
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            // Mid-stream failure AFTER content already flowed — retrying would
            // duplicate output, so surface it as a normal stream error.
            controller.error(err);
            reader.releaseLock();
          }
        },
        cancel(reason) {
          reader.cancel(reason).catch(() => {}); // ci-ok: cancelling an already-settled/errored upstream reader is a no-op
        },
      });

      return { ...primary, stream };
    },
    async wrapGenerate({ doGenerate, params, model }) {
      try {
        return await doGenerate();
      } catch (err) {
        console.error(
          `[ai/chat-fallback] ${model.modelId} generate failed → ${fallback.modelId}: ${briefProviderError(err)}`
        );
        return fallback.doGenerate(params);
      }
    },
  };
}

/** Wrap a resolved assistant model with a direct-Claude fallback, when one is
 *  available and distinct from the primary. A gateway model is returned as a
 *  string only in never-hit legacy paths; concrete provider models are objects. */
function withChatFallback(primary: LanguageModel, kind: ModelKind): LanguageModel {
  if (typeof primary === "string") return primary; // can't wrap a bare slug
  // The assistant is pinned to Opus 5, so the FALLBACK is now the OpenAI side
  // (this pair was the other way round until 2026-07-23).
  const fallback = getDirectOpenAIModel(kind);
  if (!fallback || typeof fallback === "string") return primary; // no OpenAI key
  // Primary already IS this Claude model (no OpenAI key path) → no distinct fallback.
  if (primary.modelId === fallback.modelId) return primary;
  // Both direct providers (and the gateway) are spec v3 at runtime; the union
  // only widens to include V2 because LanguageModel is version-agnostic.
  return wrapLanguageModel({
    model: primary as LanguageModelV3,
    middleware: chatFallbackMiddleware(fallback as LanguageModelV3),
  });
}

/** Resolve the PINNED assistant primary model (no fallback wrapping). */
function resolveChatPrimaryModel(kind: ModelKind): LanguageModel {
  if (isGatewayEnabled()) {
    return gateway(CHAT_MODEL_GATEWAY_ID as Parameters<typeof gateway>[0]);
  }
  const _ak = ["ANTHROPIC", "API", "KEY"].join("_");
  const anthropicKey = process.env.BASIL_LLM_KEY ?? process.env[_ak];
  if (anthropicKey) {
    // Pinned Opus 5 at CHAT_EFFORT. Effort is applied via transformParams so it
    // rides along on every call without each route passing providerOptions.
    return wrapLanguageModel({
      model: createAnthropic({ apiKey: anthropicKey })(CHAT_MODEL_ANTHROPIC_ID) as LanguageModelV3,
      middleware: anthropicEffortMiddleware(CHAT_EFFORT),
    });
  }
  // No Anthropic key configured — keep the assistant alive on OpenAI rather than
  // throwing. (Different model, but a working assistant beats a dead one.)
  const openaiModel = getDirectOpenAIModel(kind);
  if (openaiModel) return openaiModel;
  return getTextModel(kind);
}

export function getChatModel(kind: ModelKind = "default"): LanguageModel {
  // The assistant model is PINNED (gpt-5.6-sol), but wrapped with a transparent
  // Claude fallback so an OpenAI outage degrades the voice for one message
  // instead of killing Ask Basil entirely. See chatFallbackMiddleware.
  return withChatFallback(resolveChatPrimaryModel(kind), kind);
}

// ── Direct-provider factories (used by generateTextSafe's fallback chain) ──────
//
// These live here, in the one file the model-usage guard allowlists, so call
// sites (generate.ts) never import a provider SDK directly. Each returns null
// when its key is absent, letting the caller skip to the next fallback.

/**
 * Direct Anthropic model for a tier — generateTextSafe's FIRST fallback when the
 * primary (gateway) model fails. Returns null when no Anthropic key is set.
 */
export function getDirectAnthropicModel(kind: ModelKind = "default"): LanguageModel | null {
  const _ak = ["ANTHROPIC", "API", "KEY"].join("_");
  const key = process.env.BASIL_LLM_KEY ?? process.env[_ak];
  if (!key) return null;
  const model = createAnthropic({ apiKey: key })(ANTHROPIC_MODEL_IDS[kind]);

  // Apply reasoning EFFORT where configured. Baked into the model itself so it
  // applies at EVERY call site — generateTextSafe, and the chat middleware's
  // fallback.doStream(params) — without each caller passing providerOptions.
  const effort = ANTHROPIC_EFFORT[kind];
  if (!effort) return model;
  return wrapLanguageModel({
    model: model as LanguageModelV3,
    middleware: anthropicEffortMiddleware(effort),
  });
}

/** Middleware that pins `providerOptions.anthropic.effort` on every call. */
function anthropicEffortMiddleware(effort: AnthropicEffort): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => ({
      ...params,
      providerOptions: {
        ...params.providerOptions,
        anthropic: { ...(params.providerOptions?.anthropic ?? {}), effort },
      },
    }),
  };
}

/**
 * Direct OpenAI model for a tier — generateTextSafe's SECOND fallback (after
 * Anthropic direct), so Claude stays primary and OpenAI is the resilience
 * option. Returns null when no OpenAI key is set.
 */
export function getDirectOpenAIModel(kind: ModelKind = "default"): LanguageModel | null {
  const _ok = ["OPENAI", "API", "KEY"].join("_");
  const key = process.env.openai_basilv2 ?? process.env[_ok];
  if (!key) return null;
  return createOpenAI({ apiKey: key })(OPENAI_MODEL_IDS[kind]);
}
