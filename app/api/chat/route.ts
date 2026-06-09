export const maxDuration = 60;

import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { getTextModel, MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import { reserveSpend, commitSpend, releaseSpend, SpendCapError } from "@/lib/ai/spend-guard";
import { getEntitlement } from "@/lib/billing/entitlement-store";
import { effectiveKind, familyForKind } from "@/lib/ai/tiering";

// 200 KB limit — covers very long chat histories while preventing abuse
const MAX_BODY_BYTES = 200_000;
// Per-user: 30 AI calls per minute (generous for normal use, blocks runaway loops)
const CHAT_RATE_LIMIT = 30;

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large (max 200 KB)" }, { status: 413 });
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
        family: familyForKind(chatKind),
        userMonthlyUsd: entitlement.aiMonthlyUsd,
        maxSteps: 8, // matches stopWhen: stepCountIs(8) below
      },
      chatKind
    );
  } catch (err) {
    if (err instanceof SpendCapError) {
      return Response.json(
        { error: `AI budget reached (${err.scope}). Try again next month or contact support.` },
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

  const [settings, modelMessages] = await Promise.all([
    getSettings(username),
    convertToModelMessages(messages),
  ]);

  const firstName = settings.name.split(" ")[0] ?? settings.name;
  const timezone  = resolveTimezone(settings, req);
  const system    = await getSystemPrompt(username, timezone);

  // Settle the spend reservation exactly once — onFinish (success) and onError
  // (failure) are mutually exclusive, but guard so we never both commit AND
  // release the same reservation (which would corrupt the counter).
  let spendSettled = false;
  const result = streamText({
    model: getTextModel(chatKind),
    maxOutputTokens: MAX_TOKENS[chatKind],
    system,
    messages: modelMessages,
    tools: buildAssistantTools(username, firstName, timezone),
    stopWhen: stepCountIs(8),
    // Reconcile the reservation to ACTUAL token usage once the stream finishes.
    // totalUsage aggregates across all tool-loop steps.
    onFinish: ({ totalUsage }) => {
      if (spendSettled) return;
      spendSettled = true;
      void commitSpend(reservation, {
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
      });
    },
    // If the model errors before producing usage, return the reservation so a
    // failed call costs nothing.
    onError: () => {
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
