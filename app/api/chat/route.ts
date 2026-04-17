import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { assistantTools } from "@/lib/ai/tools";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const [system, modelMessages] = await Promise.all([
    getSystemPrompt(),
    convertToModelMessages(messages),
  ]);

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    messages: modelMessages,
    tools: assistantTools,
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
