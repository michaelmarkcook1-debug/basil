/**
 * 300s — the heaviest tool loop in the app needs it.
 *
 * This was 60s, which SILENTLY TRUNCATED Ask Basil: a real question ("tell me
 * about all the ag demos") fans out ~20 calendar/email/Slack tool calls across
 * up to 8 steps on a REASONING model, blows past 60s, and Vercel kills the
 * function mid-stream. Because the stream had already started, the request
 * still returns 200 — so the user just sees the answer stop mid-sentence with
 * no error anywhere ("I found **10 demo sessions" … and nothing).
 *
 * Every other AI route here (briefing, digest, meeting-prep, mobile chat) was
 * already 300s; chat — the one with the biggest tool loop — was the outlier.
 */
export const maxDuration = 300;

import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { getChatModel, MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import { repairOrphanedToolCalls } from "@/lib/ai/repair-history";
import { reserveSpend, commitSpend, releaseSpend, SpendCapError } from "@/lib/ai/spend-guard";
import { getEntitlement } from "@/lib/billing/entitlement-store";
import { effectiveKind } from "@/lib/ai/tiering";
import { CHAT_PRICE_FAMILY, costUsd } from "@/lib/ai/pricing";

/**
 * Body ceiling. Was 200 KB, sized for text-only histories — far too small the
 * moment anyone attaches an image.
 *
 * Attachments are inlined as base64 (~1.33× the raw bytes) AND useChat resends
 * the ENTIRE conversation every turn, so one screenshot didn't just fail its own
 * send — it sat in history and broke every later message, including plain text.
 * That is why "attach an image" and "paste a URL" both appeared broken: same
 * trapped image.
 *
 * Images are now downscaled client-side (lib/images/downscale.ts) so typical
 * payloads are small; this ceiling is the backstop, set below Vercel's ~4.5 MB
 * serverless body limit so we reject with a readable message rather than having
 * the platform sever the request.
 */
const MAX_BODY_BYTES = 4_000_000;
// Per-user: 30 AI calls per minute (generous for normal use, blocks runaway loops)
const CHAT_RATE_LIMIT = 30;

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large — try a smaller image, or start a new chat to clear attachment history" }, { status: 413 });
  }

  // Auth first — the rate-limit key is the authenticated USERNAME (not the
  // spoofable x-forwarded-for IP), so a single user can't multiply their quota
  // by rotating IPs. IP is kept only as a fallback for the unauthenticated case
  // (which can't happen here — we 401 above).
  const username = await getSessionUser();
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const rl = await checkRateLimitDurable(`chat:${username}`, CHAT_RATE_LIMIT);
  if (!rl.allowed) {
    return Response.json(
      { error: "Too many requests — slow down" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  // Plan-aware model tier: Pro/admin get Opus on chat; Free/trial-expired get
  // Sonnet ("balanced"). The per-user spend cap comes from the plan's AI quota.
  const entitlement = await getEntitlement(username);
  const chatKind = effectiveKind("default", entitlement.plan);

  // Spend cap — reserve worst-case budget before the call. A 429 here means the
  // per-user (plan quota) or global monthly AI ceiling has been hit.
  let reservation;
  try {
    reservation = await reserveSpend(
      {
        username,
        feature: "chat",
        // The assistant's model is PINNED (getChatModel → gpt-5.6-sol), so its
        // cost is priced from the pinned family, not inferred from the tier.
        family: CHAT_PRICE_FAMILY,
        userMonthlyUsd: entitlement.aiMonthlyUsd,
        maxSteps: 8, // matches stopWhen: stepCountIs(8) below
      },
      chatKind
    );
  } catch (err) {
    if (err instanceof SpendCapError) {
      // Say WHEN it resets, derived from the scope that actually fired.
      // This read "Try again next month" for every scope including the DAILY
      // ones, which sent the owner hunting through their Anthropic billing for
      // a limit that was Basil's own and reset at midnight. A wrong recovery
      // instruction costs more than a vague one: it points you at the wrong
      // system entirely.
      const resetsIn =
        err.scope === "user-daily" || err.scope === "daily"
          ? `resets at midnight UTC (about ${Math.max(1, Math.round(err.retryAfterSec / 3600))}h)`
          : err.scope === "hard-stop"
            ? "AI is switched off by the AI_SPEND_HARD_STOP kill switch"
            : "resets at the start of next month";
      return Response.json(
        {
          error:
            `Basil's own AI budget is spent (${err.scope}) — this is Basil's cap, ` +
            `not your provider's credit. It ${resetsIn}.`,
        },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  let messages: UIMessage[];
  try {
    const body = await req.json() as { messages?: unknown };
    if (!Array.isArray(body?.messages)) {
      return Response.json({ error: "messages must be an array" }, { status: 400 });
    }
    messages = body.messages as UIMessage[];
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // A tool call that never returned leaves an orphaned tool_use in history with
  // no tool_result. Providers reject that outright ("Tool result is missing for
  // tool call toolu_…"), and because the whole history is resent every turn, ONE
  // interrupted tool call permanently bricks the conversation — every later
  // message fails too. Repair before converting.
  const { messages: safeMessages, repaired } = repairOrphanedToolCalls(messages);
  if (repaired > 0) {
    console.warn(
      `[api/chat] repaired ${repaired} orphaned tool call(s) — a prior turn was ` +
      `interrupted mid-tool; without this the conversation would be unusable`
    );
  }

  const [settings, modelMessages] = await Promise.all([
    getSettings(username),
    convertToModelMessages(safeMessages),
  ]);

  const firstName = settings.name.split(" ")[0] ?? settings.name;
  const timezone  = resolveTimezone(settings, req);
  const system    = await getSystemPrompt(username, timezone);

  // Settle the spend reservation exactly once — onFinish (success) and onError
  // (failure) are mutually exclusive, but guard so we never both commit AND
  // release the same reservation (which would corrupt the counter).
  let spendSettled = false;

  // Log the model that ACTUALLY serves this reply. The assistant's own claims
  // about which model it is are unreliable (LLMs guess at their identity), and
  // the dispatch traces were separately mislabelling everything as Haiku — so
  // this line is the single source of truth for "what is Ask Basil running?".
  const chatModel = getChatModel(chatKind);
  console.info(
    `[api/chat] model=${typeof chatModel === "string" ? chatModel : chatModel.modelId} ` +
    `provider=${PROVIDER_MODE} tier=${chatKind}`
  );

  // ── The reservation is a ceiling, not a guess ────────────────────────────
  // reserveSpend() holds ONE step's worst case. That is only safe because the
  // loop is not allowed to outspend the hold: this condition halts it as soon as
  // its accumulated cost reaches what was reserved. Without it the loop could run
  // all 8 steps against a 1-step hold and sail past the daily cap before
  // commitSpend() ever reconciles.
  //
  // The bound is reserved + ONE step, not reserved exactly — a step's cost is
  // only known once it has been paid for, so the stop always trails by one.
  // Worst case is 2 × $0.27 rather than 8 × $0.27, which is the point.
  //
  // reservedUsd === 0 means observe-only (no cap configured) — never stop then,
  // or an unconfigured install would truncate every reply after one step.
  const ceilingUsd = reservation.reservedUsd;
  let ceilingStopped = false;
  const spentAcross = (
    steps: readonly { usage?: { inputTokens?: number; outputTokens?: number } }[],
  ) =>
    steps.reduce(
      (sum, st) => sum + costUsd(CHAT_PRICE_FAMILY, {
        inputTokens:  st.usage?.inputTokens,
        outputTokens: st.usage?.outputTokens,
      }),
      0,
    );

  const result = streamText({
    model: chatModel,
    maxOutputTokens: MAX_TOKENS[chatKind],
    system,
    messages: modelMessages,
    tools: buildAssistantTools(username, firstName, timezone),
    stopWhen: [
      stepCountIs(8),
      // Declared inline so TypeScript contextually types `steps` from the real
      // tool set — an explicit StopCondition<ToolSet> annotation widens the
      // generic and stops assigning.
      ({ steps }) => {
        if (ceilingUsd <= 0) return false;             // observe-only: no ceiling
        if (spentAcross(steps) < ceilingUsd) return false;
        ceilingStopped = true;
        return true;
      },
    ],
    // Reconcile the reservation to ACTUAL token usage once the stream finishes.
    // totalUsage aggregates across all tool-loop steps.
    onFinish: ({ totalUsage, finishReason }) => {
      // finishReason === "length" means the answer was CUT OFF by the output
      // ceiling — it still returns 200 and looks fine, so without this line a
      // truncated reply is indistinguishable from a complete one. (This is what
      // silently chopped Ask Basil mid-sentence: the GPT-5.6 reasoning tokens
      // consumed the whole maxOutputTokens budget before it could answer.)
      const reasoning = (totalUsage as { reasoningTokens?: number } | undefined)?.reasoningTokens;
      const log = finishReason === "length" || ceilingStopped ? console.warn : console.info;
      log(
        `[api/chat] finish=${finishReason} tier=${chatKind} ` +
        `in=${totalUsage?.inputTokens} out=${totalUsage?.outputTokens}` +
        (reasoning !== undefined ? ` reasoning=${reasoning}` : "") +
        (finishReason === "length" ? " ⚠️ TRUNCATED — raise MAX_TOKENS" : "") +
        // Distinct from the maxOutputTokens truncation above: the answer was cut
        // short because the tool loop exhausted its RESERVED BUDGET, not its token
        // ceiling. Same symptom for the reader, completely different fix — one
        // wants MAX_TOKENS raised, this one wants the daily cap raised.
        (ceilingStopped ? ` ⚠️ BUDGET-STOPPED — loop hit its $${reservation.reservedUsd.toFixed(2)} reservation; raise AI_PER_USER_DAILY_USD` : "")
      );
      if (spendSettled) return;
      spendSettled = true;
      void commitSpend(reservation, {
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
      });
    },
    // If the model errors before producing usage, return the reservation so a
    // failed call costs nothing. LOG the error — previously this was silent, so
    // a model failure (bad id, provider outage) surfaced only as a client-side
    // crash with a bare 200 and no server trace to diagnose from.
    onError: ({ error }) => {
      // AI SDK errors are often plain objects (not Error), so String(error)
      // yields a useless "[object Object]". Serialise non-Error values —
      // including non-enumerable props — so the real cause is readable.
      let detail: string;
      if (error instanceof Error) {
        detail = error.message || String(error.cause ?? "");
        if (!detail) {
          try { detail = JSON.stringify(error, Object.getOwnPropertyNames(error)); } catch { detail = "unknown Error"; }
        }
      } else {
        try { detail = JSON.stringify(error); } catch { detail = String(error); }
      }
      console.error(`[api/chat] streamText error (${chatKind}/${PROVIDER_MODE}): ${detail?.slice(0, 600)}`);
      if (spendSettled) return;
      spendSettled = true;
      void releaseSpend(reservation);
    },
    ...(PROVIDER_MODE === "vercel_gateway" && {
      providerOptions: {
        gateway: { tags: ["feature:chat", "env:production"] },
      },
    }),
  });

  // Pull the stream to completion on the SERVER regardless of the client. If the
  // client disconnects mid-stream, onFinish would otherwise never fire and the
  // spend reservation would leak (stay counted at worst-case forever). consumeStream
  // guarantees onFinish (commit) or onError (release) runs. Fire-and-forget.
  void Promise.resolve(result.consumeStream()).catch(() => {
    if (!spendSettled) {
      spendSettled = true;
      void releaseSpend(reservation);
    }
  });

  return result.toUIMessageStreamResponse();
}
