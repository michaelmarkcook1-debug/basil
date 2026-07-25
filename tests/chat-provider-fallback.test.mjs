/**
 * tests/chat-provider-fallback.test.mjs
 *
 * Guards the fix for the RECURRING "AI still not working" outage.
 *
 * Ask Basil is pinned to gpt-5.6-sol. Background classification survives an
 * OpenAI outage because generateTextSafe falls to Claude — but the assistant
 * drove a RAW streamText with no fallback, so the instant OpenAI hit its quota
 * (a repeat billing failure) chat died outright while the healthy Anthropic key
 * sat unused.
 *
 * The fix: getChatModel() now wraps the pinned model with a language-model
 * middleware that, when the provider REQUEST rejects (doStream/doGenerate throw
 * before any token — exactly how a 429 quota / auth / outage surfaces),
 * transparently re-issues the identical call against direct Claude. One message
 * gets a different voice instead of a dead assistant; Sol resumes automatically.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const cfg = read("lib/ai/model-config.ts");

test("getChatModel wraps the pinned model with a fallback (not a bare model)", () => {
  const fn = cfg.slice(cfg.indexOf("export function getChatModel"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(/withChatFallback\(/.test(body),
    "getChatModel must return the pinned model wrapped in a Claude fallback");
});

test("the fallback wrap uses the AI SDK middleware + a DISTINCT cross-provider model", () => {
  assert.ok(/wrapLanguageModel\(/.test(cfg),
    "must use the AI SDK's wrapLanguageModel to wrap the pinned model");
  // Since 2026-07-23 the assistant is pinned to Opus 5, so the fallback is the
  // OpenAI side. The invariant that matters is that it is the OTHER provider.
  assert.ok(/getDirectOpenAIModel\(kind\)/.test(cfg.slice(cfg.indexOf("function withChatFallback"))),
    "the fallback must be the opposite provider to the pinned primary");
  const wrap = cfg.slice(cfg.indexOf("function withChatFallback"));
  const wrapBody = wrap.slice(0, wrap.indexOf("\n}\n"));
  assert.ok(/modelId === fallback\.modelId\) return primary/.test(wrapBody),
    "must NOT wrap a Claude primary with itself (no distinct fallback → return as-is)");
});

test("the middleware retries on request rejection for BOTH stream and generate", () => {
  const mw = cfg.slice(cfg.indexOf("function chatFallbackMiddleware"));
  const body = mw.slice(0, mw.indexOf("\n}\n\n"));
  // stream path: try primary doStream, on throw delegate to fallback.doStream
  assert.ok(/wrapStream/.test(body) && /return fallback\.doStream\(params\)/.test(body),
    "wrapStream must fall back to fallback.doStream(params) on a primary stream error");
  // generate path: same for mobile chat (generateTextSafe) + any non-stream caller
  assert.ok(/wrapGenerate/.test(body) && /return fallback\.doGenerate\(params\)/.test(body),
    "wrapGenerate must fall back to fallback.doGenerate(params) on a primary generate error");
  // Both must be inside a try/catch so a rejected request is what triggers the swap.
  assert.ok((body.match(/try \{/g) || []).length >= 2 && (body.match(/catch \(err\)/g) || []).length >= 2,
    "each wrap must guard the primary call in try/catch");
});

test("wrapStream ALSO handles an in-stream error part, not just a request rejection", () => {
  // The bug the first fix missed: OpenAI's insufficient_quota ACCEPTS the stream
  // then emits an `error` PART — a plain try/catch never sees it, so it reached
  // streamText.onError and crashed Ask Basil. wrapStream must probe the leading
  // parts and fall back when an error arrives before any answer content.
  const mw = cfg.slice(cfg.indexOf("function chatFallbackMiddleware"));
  const body = mw.slice(0, mw.indexOf("\n}\n\n"));
  assert.ok(/primary\.stream\.getReader\(\)/.test(body),
    "wrapStream must read the primary stream to inspect its leading parts");
  assert.ok(/value\.type === "error"/.test(body),
    "wrapStream must detect an `error` stream part");
  assert.ok(/PROBE_BENIGN_PARTS/.test(cfg) && /"stream-start"/.test(cfg),
    "only benign lead-in parts (stream-start/response-metadata) may be buffered before committing");
  // Committing to the primary must replay the buffered lead-in so no content is lost.
  assert.ok(/for \(const part of buffered\) controller\.enqueue\(part\)/.test(body),
    "on commit, the buffered lead-in parts must be replayed into the returned stream");
});
