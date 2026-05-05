export const maxDuration = 300;

import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

// 200 KB limit — covers very long chat histories while preventing abuse
const MAX_BODY_BYTES = 200_000;

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large (max 200 KB)" }, { status: 413 });
  }

  let messages: UIMessage[];
  try {
    ({ messages } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = (await getSessionUser());
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

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
    providerOptions: {
      gateway: { tags: ["feature:chat", "env:production"] },
    },
  });

  return result.toUIMessageStreamResponse();
}
