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

import { generateText, stepCountIs, type ModelMessage } from "ai";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

interface IncomingMessage {
  id?: string;
  role: "user" | "assistant";
  parts?: Array<{ type: string; text?: string }>;
  content?: string;
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
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

    const result = await generateText({
      model: getTextModel(),
      maxOutputTokens: MAX_TOKENS.default,
      system,
      messages,
      tools: buildAssistantTools(username, firstName, timezone),
      stopWhen: stepCountIs(5),
      providerOptions: {
        gateway: { tags: ["feature:chat", "env:production", "platform:mobile"] },
      },
    });

    return Response.json({ text: result.text });
  } catch (e) {
    console.error("[api/chat/mobile] generateText failed:", e);
    return Response.json(
      { error: "AI request failed. Please try again." },
      { status: 500 }
    );
  }
}
