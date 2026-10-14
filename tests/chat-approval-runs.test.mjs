/**
 * An action the user approves in Ask Basil must actually run.
 *
 * From 2026-09-26 (prompt caching) the turn's context was pushed AFTER the
 * approval as a new user message. ai@6 only executes approved tools when the
 * final message is the tool message carrying the approval, so the booking never
 * ran, and Claude rejected the history: "tool_use ids were found without
 * tool_result blocks". Seen 2026-10-14 on "Book this meeting include my zoom url".
 *
 * This drives the real SDK — convertToModelMessages → withTurnContext →
 * streamText — with a mock model, exactly as app/api/chat/route.ts does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamText, convertToModelMessages, tool, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { loadTs } from "./_helpers/load-ts.mjs";

const cache = loadTs("lib/ai/prompt-cache.ts");

const FINISH = {
  type: "finish",
  finishReason: { unified: "stop", raw: undefined },
  logprobs: undefined,
  usage: { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } },
};

function approvedBookingHistory(approved) {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Book Greg for Friday 16:00 with my Zoom" }] },
    { id: "a1", role: "assistant", parts: [
      { type: "step-start" },
      { type: "tool-scheduleMeeting", toolCallId: "call-1", state: "approval-responded",
        input: { title: "Greg / Michael", attendees: ["greg@example.com"], date: "2026-10-17", startTime: "16:00", duration: 30 },
        approval: { id: "appr-1", approved } },
    ] },
  ];
}

async function run(uiMessages) {
  const runs = [];
  const prompts = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return { stream: simulateReadableStream({ chunks: [
        { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" }, FINISH,
      ] }) };
    },
  });
  const messages = cache.withTurnContext(await convertToModelMessages(uiMessages), "It is Tuesday 14 October, 08:40 London.");
  const result = streamText({
    model,
    messages,
    tools: {
      scheduleMeeting: tool({
        inputSchema: z.object({ title: z.string(), attendees: z.array(z.string()), date: z.string(), startTime: z.string(), duration: z.number() }),
        needsApproval: true,
        execute: async (input) => { runs.push(input); return { status: "meeting_scheduled", eventId: "evt-1" }; },
      }),
    },
  });
  await result.consumeStream();
  return { runs, prompts, messages };
}

function toolResultsSentToModel(prompt) {
  return prompt.filter((m) => m.role === "tool").flatMap((m) => m.content).filter((p) => p.type === "tool-result");
}

test("an approved booking runs, and the model is sent its result", async () => {
  const { runs, prompts, messages } = await run(approvedBookingHistory(true));
  assert.equal(messages.at(-1).role, "tool", "the approval stays the last message");
  assert.equal(runs.length, 1, "the booking ran exactly once");
  assert.equal(runs[0].startTime, "16:00");
  assert.equal(prompts.length, 1);
  const results = toolResultsSentToModel(prompts[0]);
  assert.equal(results.length, 1, "the model sees the booking's result next to the call");
  assert.equal(results[0].toolCallId, "call-1");
});

test("the turn's context still reaches the model, on the user's message", async () => {
  const { prompts } = await run(approvedBookingHistory(true));
  const user = prompts[0].filter((m) => m.role === "user").at(-1);
  const text = user.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  assert.match(text, /Book Greg/);
  assert.match(text, /<basil_context>[\s\S]*Tuesday 14 October/);
});

test("a declined booking does not run, and the model is told it was declined", async () => {
  const { runs, prompts } = await run(approvedBookingHistory(false));
  assert.equal(runs.length, 0);
  const results = toolResultsSentToModel(prompts[0]);
  assert.equal(results.length, 1);
  assert.equal(results[0].output.type, "execution-denied");
});
