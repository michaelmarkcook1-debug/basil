/**
 * lib/ai/openai.ts
 *
 * Server-side OpenAI direct adapter.
 * Used for diagnostics, the "Test Brain" endpoint, and simple one-shot completions
 * that do not require streaming or AI SDK tool use.
 *
 * For full chat/Stig AI calls, use getTextModel() from model-config.ts —
 * it returns a LanguageModel compatible with generateText/streamText regardless of provider.
 */

import "server-only";

export interface OpenAIResult {
  ok: boolean;
  text?: string;
  model?: string;
  provider: "openai";
  durationMs?: number;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Make a single completion request to OpenAI directly.
 * Server-side only — never call from client components.
 *
 * @param prompt  User message to complete
 * @param system  Optional system prompt
 */
export async function callOpenAIDirect(
  prompt: string,
  system?: string
): Promise<OpenAIResult> {
  const apiKey = process.env.openai_basilv2 ?? process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o";

  if (!apiKey) {
    return {
      ok: false,
      provider: "openai",
      error: {
        code: "OPENAI_KEY_MISSING",
        message: "OpenAI API key is not set. Add `openai_basilv2` or `OPENAI_API_KEY` in Vercel environment variables.",
      },
    };
  }

  if (!model) {
    return {
      ok: false,
      provider: "openai",
      error: {
        code: "OPENAI_MODEL_MISSING",
        message: "OPENAI_MODEL is not set. Add it in Vercel environment variables (e.g. gpt-4o).",
      },
    };
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const start = Date.now();

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 256,
        temperature: 0.3,
      }),
    });

    const durationMs = Date.now() - start;

    if (!res.ok) {
      let errMsg = `OpenAI API returned ${res.status}`;
      try {
        const body = await res.json() as { error?: { message?: string; code?: string } };
        errMsg = body?.error?.message ?? errMsg;
      } catch { /* ignore */ }

      const isAuthErr = res.status === 401;
      const isModelErr = res.status === 404;

      return {
        ok: false,
        provider: "openai",
        durationMs,
        error: {
          code: isAuthErr ? "OPENAI_AUTH_FAILED" : isModelErr ? "OPENAI_MODEL_INVALID" : "OPENAI_API_ERROR",
          message: errMsg,
        },
      };
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const text = data?.choices?.[0]?.message?.content ?? "";

    if (!text) {
      return {
        ok: false,
        provider: "openai",
        durationMs,
        error: { code: "OPENAI_EMPTY_RESPONSE", message: "OpenAI returned an empty response." },
      };
    }

    return {
      ok: true,
      provider: "openai",
      text,
      model: data.model ?? model,
      durationMs,
    };
  } catch (e) {
    return {
      ok: false,
      provider: "openai",
      durationMs: Date.now() - start,
      error: {
        code: "OPENAI_NETWORK_ERROR",
        message: e instanceof Error ? e.message : "Network error contacting OpenAI.",
      },
    };
  }
}

/**
 * Quick connectivity test — sends a minimal prompt to verify the API key and model work.
 */
export async function testOpenAIConnection(): Promise<OpenAIResult> {
  return callOpenAIDirect("Reply with the single word: ready", "You are a connectivity test. Reply with exactly one word.");
}
