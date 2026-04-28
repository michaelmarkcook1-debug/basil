import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

export async function POST(req: Request) {
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
    model: "anthropic/claude-sonnet-4.6",
    system,
    messages: modelMessages,
    tools: buildAssistantTools(username, firstName, timezone),
    stopWhen: stepCountIs(5),
    providerOptions: {
      gateway: { tags: ["feature:chat", "env:production"] },
    },
  });

  return result.toUIMessageStreamResponse();
}
