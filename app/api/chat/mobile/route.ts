/**
 * POST /api/chat/mobile
 *
 * Non-streaming chat endpoint for the mobile app. Same message history as
 * /api/chat, plain JSON back.
 *
 * Response: { text, approvals, assistantMessage }
 *
 *   text             — the reply
 *   approvals        — tools the model wants to run that need the user's say-so
 *                      ({ approvalId, toolName, toolCallId, input })
 *   assistantMessage — the assistant turn as a UI message. Echo it back in the
 *                      next request with each approval part's state set to
 *                      "approval-responded" and `approval: { id, approved }`;
 *                      the tool then runs (or the model is told it was denied).
 *
 * Until 2026-09-15 this route flattened every incoming part to text and
 * returned only `text`, so an approval request came back as `{ text: "" }`,
 * and a client could not answer it — approval-required tools were silently
 * unusable from mobile. Messages now keep their parts and go through the same
 * convertToModelMessages path as the web route.
 */

export const maxDuration = 300;

import { stepCountIs, convertToModelMessages, type UIMessage } from "ai";
import { generateTextSafe } from "@/lib/ai/generate";
import { repairOrphanedToolCalls } from "@/lib/ai/repair-history";
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
  /** UI message parts — text, tool parts (including approval-responded), files. */
  parts?: Array<Record<string, unknown> & { type: string }>;
  /** Legacy clients send a bare string; it becomes a single text part. */
  content?: string;
}

export interface MobileApproval {
  approvalId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
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

  // Keep parts intact — an approval decision is a tool part, not text.
  const uiMessages: UIMessage[] = rawMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      id: m.id ?? `m-${i}`,
      role: m.role,
      parts: (m.parts && m.parts.length > 0
        ? m.parts
        : [{ type: "text", text: m.content ?? "" }]) as UIMessage["parts"],
    }))
    .filter((m) => m.parts.some((p) => (p as { type: string }).type !== "text" || ((p as { text?: string }).text ?? "").trim().length > 0));

  if (uiMessages.length === 0) {
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

    const { messages: safeMessages } = repairOrphanedToolCalls(uiMessages);
    const messages = await convertToModelMessages(safeMessages);

    const result = await generateTextSafe({
      model: getChatModel(chatKind),
      maxOutputTokens: MAX_TOKENS[chatKind],
      system,
      messages,
      tools: buildAssistantTools(username, firstName, timezone),
      // generateTextSafe appends the spend ceiling: the loop stops when its
      // accumulated cost reaches the one-step reservation, whatever this says.
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

    // Approval requests come back as content parts, not as a paused call.
    const approvals: MobileApproval[] = [];
    for (const part of result.content as ReadonlyArray<Record<string, unknown>>) {
      if (part.type !== "tool-approval-request") continue;
      const call = part.toolCall as { toolName: string; toolCallId: string; input: unknown };
      approvals.push({ approvalId: String(part.approvalId), toolName: call.toolName, toolCallId: call.toolCallId, input: call.input });
    }
    const assistantMessage = {
      id: `asst-${Date.now().toString(36)}`,
      role: "assistant" as const,
      parts: [
        ...(result.text ? [{ type: "text", text: result.text }] : []),
        ...approvals.map((a) => ({
          type: `tool-${a.toolName}`,
          toolCallId: a.toolCallId,
          state: "approval-requested",
          input: a.input,
          approval: { id: a.approvalId },
        })),
      ],
    };

    return Response.json({ text: result.text, approvals, assistantMessage });
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
