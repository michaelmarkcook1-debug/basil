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
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// 200 KB limit — covers very long chat histories while preventing abuse
const MAX_BODY_BYTES = 200_000;
// Per-user: 30 AI calls per minute (generous for normal use, blocks runaway loops)
const CHAT_RATE_LIMIT = 30;

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large (max 200 KB)" }, { status: 413 });
  }

  // Auth first — rate-limit key is the user IP
  const username = await getSessionUser();
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const ip = getClientIp(req);
  const rl = checkRateLimit(`chat:${ip}`, CHAT_RATE_LIMIT);
  if (!rl.allowed) {
    return Response.json(
      { error: "Too many requests — slow down" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
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

  const result = streamText({
    model: getTextModel(),
    maxOutputTokens: MAX_TOKENS.default,
    system,
    messages: modelMessages,
    tools: buildAssistantTools(username, firstName, timezone),
    stopWhen: stepCountIs(8),
    ...(PROVIDER_MODE === "vercel_gateway" && {
      providerOptions: {
        gateway: { tags: ["feature:chat", "env:production"] },
      },
    }),
  });

  return result.toUIMessageStreamResponse();
}
