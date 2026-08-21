/**
 * POST /api/chat/mobile
 *
 * Non-streaming chat endpoint for the mobile app.
 * Accepts the same message history format as /api/chat but returns a simple
 * JSON { text: string } response instead of a streaming UI message stream.
 *
 * Mobile clients don't benefit from streaming in the same way web clients do,
 * so this approach is simpler, more reliable, and easier to handle offline.
 */

export const maxDuration = 300;

import { stepCountIs, type ModelMessage } from "ai";
import { generateTextSafe } from "@/lib/ai/generate";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { getEntitlement } from "@/lib/billing/entitlement-store";
import { effectiveKind } from "@/lib/ai/tiering";
import { CHAT_PRICE_FAMILY } from "@/lib/ai/pricing";
import { getChatModel, MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";
import { checkRateLimitDurable } from "@/lib/rate-limit";

interface IncomingMessage {
  id?: string;
  role: "user" | "assistant";
  parts?: Array<{ type: string; text?: string }>;
  content?: string;
}

// Match the web chat route's protections (this endpoint previously had neither).
// Kept in step with app/api/chat/route.ts — see the reasoning there. 200 KB was
// sized for text-only histories and broke the moment an image was attached.
const MAX_BODY_BYTES = 4_000_000;
const MOBILE_CHAT_RATE_LIMIT = 30; // per user per minute — shared with web chat

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large — try a smaller image, or start a new chat to clear attachment history" }, { status: 413 });
  }

  const username = await getSessionUser();
  if (!username) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }

  const rl = await checkRateLimitDurable(`chat:${username}`, MOBILE_CHAT_RATE_LIMIT);
  if (!rl.allowed) {
    return Response.json(
      { error: "Too many requests — slow down" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let rawMessages: IncomingMessage[];
  try {
    ({ messages: rawMessages } = await req.json());
    if (!Array.isArray(rawMessages)) throw new Error("messages must be an array");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Normalise to ModelMessage format (AI SDK v6) — handle both parts[] and content string
  const messages: ModelMessage[] = rawMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content:
        m.content ??
        m.parts?.find((p) => p.type === "text")?.text ??
        "",
    }))
    .filter((m) => m.content.trim().length > 0);

  if (messages.length === 0) {
    return Response.json({ error: "No valid messages provided" }, { status: 400 });
  }

  try {
    const settings = await getSettings(username);
    const timezone = resolveTimezone(settings, req);
    const firstName = settings.name.split(" ")[0] ?? settings.name;
    const system = await getSystemPrompt(username, timezone);

    // Plan-aware tier (mirror the web chat route): Pro/admin → Opus, Free → Sonnet.
    const entitlement = await getEntitlement(username);
    const chatKind = effectiveKind("default", entitlement.plan);

    const result = await generateTextSafe({
      model: getChatModel(chatKind),
      maxOutputTokens: MAX_TOKENS[chatKind],
      system,
      messages,
      tools: buildAssistantTools(username, firstName, timezone),
      stopWhen: stepCountIs(5),
      ...(PROVIDER_MODE === "vercel_gateway" && {
        providerOptions: {
          gateway: { tags: ["feature:chat", "env:production", "platform:mobile"] },
        },
      }),
    }, chatKind, {
      username,
      feature: "chat:mobile",
      // Assistant model is PINNED (getChatModel → gpt-5.6-sol) — price from the
      // pinned family rather than inferring it from the tier.
      family: CHAT_PRICE_FAMILY,
      userMonthlyUsd: entitlement.aiMonthlyUsd,
      maxSteps: 5,
    });

    return Response.json({ text: result.text });
  } catch (e) {
    if (e instanceof SpendCapError) {
      return spendCapResponse(e);
    }
    console.error("[api/chat/mobile] generateText failed:", e);
    return Response.json(
      { error: "AI request failed. Please try again." },
      { status: 500 }
    );
  }
}
