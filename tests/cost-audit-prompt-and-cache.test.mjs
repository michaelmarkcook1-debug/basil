/**
 * Cost audit (2026-09-26). Every AI call sent the full ~14.5k-token assistant
 * prompt — tool manuals, 40 memories and a personality line for every contact
 * (375 of them a WhatsApp "—" placeholder) — and nothing was cached. An email
 * classification cost ~20k tokens, ~2k of them the email.
 *
 * Real modules, storage mocked. Synthetic people only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const pricing = loadTs("lib/ai/pricing.ts", {
  "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 512, balanced: 1024, default: 2048, long: 8192 } },
});
const cache = loadTs("lib/ai/prompt-cache.ts");

// ── Fixtures ────────────────────────────────────────────────────────────────

const placeholder = (i) => ({
  id: `wa-${i}`, name: `Whatsapp Person${i}`, directory: "personal", tags: ["whatsapp"],
  personality: "—", whatMakesThemTick: "", watchOut: "",
});
const person = (id, name, note, lastInteraction) => ({
  id, name, title: "Director", directory: "work",
  personality: note, whatMakesThemTick: "Clear asks", watchOut: "Long emails", lastInteraction,
});
const BOOK = [
  ...Array.from({ length: 375 }, (_, i) => placeholder(i)),
  person("c1", "Jordan Avery", "Direct and numbers-first", "2026-09-20"),
  person("c2", "Priya Nandakumar", "Warm, detail-oriented", "2026-09-25"),
  person("c3", "Sam Hollis", "Strategic, big-picture", "2026-08-01"),
  person("c4", "Sam Okafor", "Operational, terse", "2026-09-24"),
  ...Array.from({ length: 20 }, (_, i) => person(`o${i}`, `Other Contact${i}`, "Has a real note", `2026-07-${String(i + 1).padStart(2, "0")}`)),
];

function systemPromptModule({ memoryCalls = [] } = {}) {
  return loadTs("lib/ai/system-prompt.ts", {
    "@/lib/contacts/user-store": { listUserContacts: async () => BOOK },
    "@/lib/memory/store": {
      memoriesForPrompt: async (_u, focus, max) => {
        memoryCalls.push({ focus, max });
        return max === 0 ? "" : "Preferences:\n- Prefers bullet points";
      },
    },
    "@/lib/settings/store": {
      getSettings: async () => ({ name: "Fixture Owner", timezone: "Europe/London", workStart: "09:00", workEnd: "18:00", videoTool: "Zoom", meetingUrl: "" }),
    },
    "@/lib/users": { findByUsername: async () => ({ profile: { jobTitle: "CEO", company: "Fixture Co" } }) },
  });
}

// ── Pricing ─────────────────────────────────────────────────────────────────

test("cost is cache-aware: cached reads bill at 10%, writes at 125%, uncached as before", () => {
  const plain = pricing.costUsd("opus55", { inputTokens: 100_000, outputTokens: 0 });
  assert.equal(plain.toFixed(4), "0.4000");
  const mostlyCached = pricing.costUsd("opus55", {
    inputTokens: 100_000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 90_000, cacheWriteTokens: 0 },
  });
  assert.equal(mostlyCached.toFixed(4), ((10_000 + 9_000) / 1e6 * 4).toFixed(4)); // $0.076, not $0.40
  const written = pricing.costUsd("opus55", {
    inputTokens: 10_000, outputTokens: 0, inputTokenDetails: { cacheWriteTokens: 10_000 },
  });
  assert.equal(written.toFixed(4), (12_500 / 1e6 * 4).toFixed(4));
  // OpenAI never charges a write premium.
  const oa = pricing.costUsd("gpt56sol", { inputTokens: 10_000, outputTokens: 0, inputTokenDetails: { cacheWriteTokens: 10_000 } });
  assert.equal(oa.toFixed(4), (10_000 / 1e6 * 5).toFixed(4));
  // A malformed split can never make the cost exceed the uncached price or go negative.
  const silly = pricing.costUsd("opus55", { inputTokens: 1_000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 5_000, cacheWriteTokens: 5_000 } });
  assert.ok(silly >= 0 && silly <= pricing.costUsd("opus55", { inputTokens: 1_000 }));
});

// ── Whose notes go in ───────────────────────────────────────────────────────

test("a placeholder dash is not a personality note", () => {
  const { realNote } = systemPromptModule();
  for (const s of ["—", "-", "", "  ", "...", "–", undefined]) assert.equal(realNote(s), "", `"${s}" must not count`);
  assert.equal(realNote("Direct and numbers-first"), "Direct and numbers-first");
});

test("persona selection: named people, then a few recent — never the whole book, never placeholders", () => {
  const { selectPersonaContacts } = systemPromptModule();
  const none = selectPersonaContacts(BOOK, "");
  assert.equal(none.length, 4, "no names → only the 4 most recent");
  assert.ok(none.every((c) => c.personality !== "—"));
  assert.equal(none.map((c) => c.id).join(","), "c2,c4,c1,c3", "most recent first");

  const named = selectPersonaContacts(BOOK, "Draft a note to Priya about the Jordan Avery deck", { recent: 0 });
  assert.equal(named.map((c) => c.id).sort().join(","), "c1,c2", "full name and unique first name both match");

  const ambiguous = selectPersonaContacts(BOOK, "tell Sam", { recent: 0 });
  assert.equal(ambiguous.length, 0, "two contacts called Sam — a bare first name picks neither");
  assert.equal(selectPersonaContacts(BOOK, "tell Sam Okafor", { recent: 0 }).map((c) => c.id).join(","), "c4");

  assert.equal(selectPersonaContacts(BOOK, "Priyanka", { recent: 0 }).length, 0, "names match on word boundaries");
});

// ── The chat prompt ─────────────────────────────────────────────────────────

test("chat instructions are byte-identical across messages; the clock, memories and people ride separately", async () => {
  const memoryCalls = [];
  const M = systemPromptModule({ memoryCalls });
  const a = await M.getChatPromptParts("u", "Europe/London", { text: "What's on with Priya?" });
  const b = await M.getChatPromptParts("u", "Europe/London", { text: "Remind me to call Jordan Avery" });
  assert.equal(a.instructions, b.instructions, "the cached block must not change between turns");
  assert.doesNotMatch(a.instructions, /Today is \*\*/, "the clock is not in the cached block");
  assert.doesNotMatch(a.instructions, /Prefers bullet points/, "memories are not in the cached block");
  assert.match(a.instructions, /## Scheduling Protocol/);

  assert.match(a.turnContext, /## Right Now/);
  assert.match(a.turnContext, /Prefers bullet points/);
  assert.match(a.turnContext, /Priya Nandakumar/);
  assert.doesNotMatch(a.turnContext, /Whatsapp Person/, "placeholder contacts never reach the prompt");
  assert.match(b.turnContext, /Jordan Avery/);
  assert.equal(memoryCalls[0].focus.text, "What's on with Priya?", "the turn steers which memories load");
  const n = personaCount(a.turnContext);
  assert.ok(n >= 1 && n <= 12, `1–12 people per message, got ${n}`);
});

test("the single-string chat prompt (Stig, drafts) is capped the same way", async () => {
  const { getSystemPrompt } = systemPromptModule();
  const s = await getSystemPrompt("u", "Europe/London");
  assert.doesNotMatch(s, /Whatsapp Person/);
  assert.equal(personaCount(s), 4, "no names → the 4 most recent only");
  assert.match(s, /## Right Now/);
});

test("background task prompt: no tool manuals, a few memories, notes only on named people", async () => {
  const memoryCalls = [];
  const M = systemPromptModule({ memoryCalls });
  const chat = await M.getSystemPrompt("u", "Europe/London");
  const task = await M.getTaskSystemPrompt("u", undefined, { memories: 8, focus: { text: "invoice from Fixture Co" } });
  for (const chatOnly of ["Scheduling Protocol", "searchEmails", "Loose Reminders", "Handling Approval Denials", "Contact Personality Profiles"]) {
    assert.ok(!task.includes(chatOnly), `task prompt must not carry "${chatOnly}"`);
  }
  assert.match(task, /Fixture Owner/);
  assert.match(task, /Never invent names/);
  assert.equal(memoryCalls.at(-1).max, 8);
  assert.ok(task.length < chat.length / 3, `task prompt ${task.length} chars vs chat ${chat.length}`);

  const briefing = await M.getTaskSystemPrompt("u", undefined, { personasFor: "10:00 Pipeline review with Jordan Avery" });
  assert.match(briefing, /Jordan Avery/);
  assert.equal(personaCount(briefing), 1, "only the person the data names");

  const none = await M.getTaskSystemPrompt("u", undefined, { memories: 0 });
  assert.doesNotMatch(none, /Prefers bullet points/);
});

test("no background feature sends the chat prompt any more", () => {
  const files = [
    "lib/email/classify-email.ts", "lib/slack/classify-slack.ts", "lib/zoom/extract-meeting.ts", "lib/zoom/process-meeting.ts",
    "app/api/generate/briefing/route.ts", "app/api/generate/meeting-prep/route.ts", "app/api/generate/digest/route.ts",
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/getSystemPrompt\(/.test(src), `${f} must use getTaskSystemPrompt`);
    assert.ok(/getTaskSystemPrompt\(/.test(src), `${f} must use getTaskSystemPrompt`);
  }
  const briefingPage = fs.readFileSync(path.join(ROOT, "app/dashboard/briefing/page.tsx"), "utf8");
  assert.ok(!briefingPage.includes("/api/ai/test-brain"), "opening the briefing page must not run a generation");
});

// ── Cache breakpoints ───────────────────────────────────────────────────────

const personaCount = (text) => text.split("\n").filter((l) => /^- \*\*[^*]+\*\* \(Director\):/.test(l)).length;
const bp = (o) => o?.providerOptions?.anthropic?.cacheControl?.type === "ephemeral";
const countBreakpoints = (msgs) => msgs.reduce((n, m) =>
  n + (bp(m) ? 1 : 0) + (Array.isArray(m.content) ? m.content.filter(bp).length : 0), 0);

test("turn context rides after the breakpoint, so the next turn's prefix still matches", () => {
  const turn1 = cache.withTurnContext([{ role: "user", content: "hello" }], "## Right Now\nMonday");
  const u = turn1[0];
  assert.equal(u.content.length, 2);
  assert.ok(bp(u.content[0]), "breakpoint on the user's own text");
  assert.match(u.content[1].text, /<basil_context>[\s\S]*Monday/);
  assert.ok(!bp(u.content[1]), "the context is after the breakpoint");

  // Next turn: the client resends the user's message WITHOUT the context.
  const turn2 = cache.withTurnContext([
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "and tomorrow?" }] },
  ], "## Right Now\nTuesday");
  assert.ok(bp(turn2[0]), "breakpoint 2: the previous user turn, re-read from cache");
  assert.equal(turn2[0].content, "hello", "earlier messages go out unchanged");
  assert.ok(bp(turn2[2].content[0]));
  assert.match(turn2[2].content[1].text, /Tuesday/);
  assert.ok(countBreakpoints(turn2) + 1 /* system */ + 1 /* step */ <= 4, "never more than Anthropic's 4");
});

test("an approval continuation (tool result last) gets the context as its own user message", () => {
  const msgs = [
    { role: "user", content: "add a task" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "addAction", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "addAction", output: { type: "text", value: "ok" } }] },
  ];
  const out = cache.withTurnContext(msgs, "ctx");
  assert.equal(out.length, 4);
  assert.ok(bp(out[2]), "breakpoint on the tool result");
  assert.equal(out[3].role, "user");
  assert.match(out[3].content[0].text, /<basil_context>/);
  assert.equal(msgs.length, 3, "input is not mutated");
});

test("each tool-loop step caches up to its newest message", () => {
  assert.equal(cache.cacheLatestStep({ stepNumber: 0, messages: [{ role: "user", content: "x" }] }), undefined);
  const r = cache.cacheLatestStep({ stepNumber: 2, messages: [{ role: "user", content: "x" }, { role: "tool", content: [] }] });
  assert.ok(bp(r.messages[1]));
  assert.ok(!bp(r.messages[0]));
  const [sys] = cache.cachedSystem("instructions");
  assert.equal(sys.role, "system");
  assert.ok(bp(sys));
});

test("chat route: cached system block, turn context on the last message, step caching, cache-aware commit", async () => {
  let args = null; const commits = [];
  const route = loadTs("app/api/chat/route.ts", {
    ai: { ...ai, streamText: (a) => { args = a; return { toUIMessageStreamResponse: () => new Response("ok"), consumeStream: async () => {} }; } },
    "@/lib/ai/model-config": { getChatModel: () => "mock-model", MAX_TOKENS: { default: 1 }, PROVIDER_MODE: "anthropic_direct" },
    "@/lib/ai/system-prompt": systemPromptModule(),
    "@/lib/ai/prompt-cache": cache,
    "@/lib/ai/tools": { buildAssistantTools: () => ({}) },
    "@/lib/auth": { getSessionUser: async () => "u" }, "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner" }) },
    "@/lib/timezone": { resolveTimezone: () => "Europe/London" }, "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/spend-guard": { reserveSpend: async () => ({ username: "u", feature: "chat", family: "opus55", reservedUsd: 0.3, heldKeys: [] }), commitSpend: async (_r, u) => { commits.push(u); }, releaseSpend: async () => {}, SpendCapError: class extends Error {}, spendCapResponse: () => new Response("cap", { status: 429 }) },
    "@/lib/billing/entitlement-store": { getEntitlement: async () => ({ plan: "pro", aiMonthlyUsd: 10 }) }, "@/lib/ai/tiering": { effectiveKind: () => "default" },
    "@/lib/ai/pricing": pricing,
    "@/lib/trust/ledger": { getDelegations: async () => new Set(), recordApprovalResponses: async () => 0, recordDelegatedRuns: async () => 0 },
  });
  const body = { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Prep me for Priya" }] }] };
  const res = await route.POST(new Request("http://x.invalid/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(res.status, 200);

  assert.ok(Array.isArray(args.system) && bp(args.system[0]), "instructions go out as a cached system block");
  assert.doesNotMatch(args.system[0].content, /Today is \*\*/);
  const last = args.messages.at(-1);
  assert.match(last.content.at(-1).text, /<basil_context>[\s\S]*Priya Nandakumar/);
  assert.equal(typeof args.prepareStep, "function");

  // The per-message ceiling prices cached steps at the cached rate: a step that
  // is 90% cache reads must not look like a full-price one.
  const stop = args.stopWhen[1];
  const cachedStep = { usage: { inputTokens: 60_000, outputTokens: 500, inputTokenDetails: { cacheReadTokens: 55_000, cacheWriteTokens: 0 } } };
  assert.equal(stop({ steps: [cachedStep] }), false, "$0.05 of cached step is under a $0.30 hold");
  assert.equal(stop({ steps: [{ usage: { inputTokens: 60_000, outputTokens: 500 } }, { usage: { inputTokens: 60_000, outputTokens: 500 } }] }), true);

  const totalUsage = { inputTokens: 60_000, outputTokens: 500, inputTokenDetails: { cacheReadTokens: 55_000, cacheWriteTokens: 0 } };
  args.onFinish({ totalUsage, finishReason: "stop", steps: [] });
  assert.equal(commits[0].inputTokenDetails.cacheReadTokens, 55_000, "the commit carries the cache split to the spend log");
});
