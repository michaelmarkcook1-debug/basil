/**
 * lib/ai/prompt-cache.ts — Anthropic prompt caching for Ask Basil.
 *
 * Every Ask Basil step resends the tool definitions (~4.5k tokens), the
 * instructions (~3.5k) and the whole conversation. Cached input is billed at
 * 10% of the normal rate (writing it costs 125%, once), so marking where the
 * stable prefix ends is the single biggest lever on the cost of a message.
 *
 * The provider caches everything BEFORE a breakpoint, in the order
 * tools → system → messages. Breakpoints used (Anthropic allows 4):
 *   1. the instructions         → tools + instructions, reused on every turn
 *   2. the previous user turn   → re-reads what the last turn cached
 *   3. the latest message       → cached for the next turn and later steps
 *   4. the last message of a tool-loop step (prepareStep) → step N+1 reads step N
 *
 * The per-turn context (clock, relevant memories and people) is attached AFTER
 * breakpoint 3, so it never alters a prefix the next turn needs to match.
 * Other providers ignore providerOptions.anthropic.
 */

import type { ModelMessage, SystemModelMessage } from "ai";

type ProviderOptions = NonNullable<SystemModelMessage["providerOptions"]>;

/** 5-minute ephemeral breakpoint. */
const EPHEMERAL = { cacheControl: { type: "ephemeral" } } as const;

function withBreakpoint(existing: ProviderOptions | undefined): ProviderOptions {
  const anthropic = (existing?.anthropic ?? {}) as Record<string, unknown>;
  return { ...existing, anthropic: { ...anthropic, ...EPHEMERAL } } as ProviderOptions;
}

/** The instructions as a cached system block (breakpoint 1). */
export function cachedSystem(instructions: string): SystemModelMessage[] {
  return [{ role: "system", content: instructions, providerOptions: withBreakpoint(undefined) }];
}

/** Mark a whole message: the provider applies it to the message's last part. */
function markMessage<M extends ModelMessage>(m: M): M {
  return { ...m, providerOptions: withBreakpoint(m.providerOptions) };
}

/**
 * Add breakpoints 2 and 3 and attach this turn's context after them.
 *
 * When the latest message is the user's, the context becomes an extra text part
 * on it and the breakpoint goes on the user's own last part — so next turn,
 * when the same message is resent WITHOUT the context, the prefix still matches.
 * When the latest message is a tool result (an approval continuation), the
 * context follows as its own user message.
 */
export function withTurnContext(messages: ModelMessage[], turnContext: string): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const lastIdx = out.length - 1;

  // Breakpoint 2: the user message before the latest one.
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (out[i].role === "user") { out[i] = markMessage(out[i]); break; }
  }

  const block = { type: "text" as const, text: `<basil_context>\n${turnContext}\n</basil_context>` };
  const last = out[lastIdx];
  if (last.role === "user") {
    const parts = typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : [...last.content];
    const i = parts.length - 1;
    parts[i] = { ...parts[i], providerOptions: withBreakpoint(parts[i].providerOptions) };
    out[lastIdx] = { ...last, content: [...parts, ...(turnContext ? [block] : [])] };
  } else {
    out[lastIdx] = markMessage(last);
    if (turnContext) out.push({ role: "user", content: [block] });
  }
  return out;
}

/**
 * prepareStep hook (breakpoint 4): from the second step on, cache up to the
 * newest message so the next step reads the previous step's tool results at
 * the cached rate instead of paying for them again.
 */
export function cacheLatestStep({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }):
  { messages: ModelMessage[] } | undefined {
  if (stepNumber === 0 || messages.length === 0) return undefined;
  const out = messages.slice();
  out[out.length - 1] = markMessage(out[out.length - 1]);
  return { messages: out };
}
