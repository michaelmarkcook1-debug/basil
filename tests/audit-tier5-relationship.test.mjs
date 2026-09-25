/**
 * Relationship-centric optimisations (2026-09-25): trust ledger and delegation,
 * approval meta, cadence rules and importance, memory lifecycle and relevance,
 * confirmations as learning, draft edits as signal, modes that travel.
 *
 * Real modules throughout, boundaries mocked. Several cases are run against
 * HEAD's versions of the files by the pre-fix harness to prove they fail there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const plain = (v) => structuredClone(v);
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

/** In-memory user store with a real per-key lock (updateUserStore semantics). */
function userStore(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [k, plain(v)]));
  const lock = makeLock();
  const key = (u, f) => `${u}/${f}`;
  const readUserStore = async (u, f, fallback) => plain(files.has(key(u, f)) ? files.get(key(u, f)) : fallback);
  const writeUserStore = async (u, f, v) => { files.set(key(u, f), plain(v)); };
  const updateUserStore = (u, f, mut, fallback) => lock.withLock(key(u, f), async () => { const next = mut(await readUserStore(u, f, fallback)); await writeUserStore(u, f, next); return next; });
  return { mocks: { readUserStore, writeUserStore, updateUserStore }, files, get: (u, f) => plain(files.get(key(u, f)) ?? null) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Trust ledger
// ═════════════════════════════════════════════════════════════════════════════

const ledgerMod = (store) => loadTs("lib/trust/ledger.ts", { "@/lib/storage/user-store": store.mocks });

test("ledger: a resent chat history records each decision once", async () => {
  const st = userStore(); const L = ledgerMod(st);
  const msgs = [{ role: "assistant", parts: [
    { type: "tool-addAction", toolCallId: "tc-1", state: "approval-responded", approval: { id: "a1", approved: true }, input: {} },
    { type: "tool-draftEmail", toolCallId: "tc-2", state: "approval-responded", approval: { id: "a2", approved: false }, input: {} },
    { type: "tool-getCalendarEvents", toolCallId: "tc-3", state: "output-available", input: {} },
  ] }];
  assert.equal(await L.recordApprovalResponses("u", msgs), 2);
  assert.equal(await L.recordApprovalResponses("u", msgs), 0, "the same history again adds nothing");
  const s = L.summarize(await L.getLedger("u"));
  assert.equal(s.addAction.approved, 1); assert.equal(s.draftEmail.denied, 1); assert.equal(s.getCalendarEvents, undefined);
});

test("ledger: the delegation offer needs a streak, and only for reversible tools", async () => {
  const st = userStore(); const L = ledgerMod(st);
  for (let i = 0; i < 10; i++) await L.recordDecision("u", { tool: "addAction", decision: "approved", source: "chat", ref: `a${i}` });
  for (let i = 0; i < 12; i++) await L.recordDecision("u", { tool: "sendSlackMessage", decision: "approved", source: "chat", ref: `s${i}` });
  await L.recordDecision("u", { tool: "logDecision", decision: "approved", source: "chat", ref: "d1" });
  const s = L.summarize(await L.getLedger("u"));
  assert.equal(s.addAction.streak, 10); assert.equal(s.addAction.offer, true);
  assert.equal(s.sendSlackMessage.offer, false, "outward-facing tools never qualify");
  assert.equal(s.logDecision.offer, false, "one approval is not a streak");
  await L.recordDecision("u", { tool: "addAction", decision: "denied", source: "chat", ref: "a-deny" });
  assert.equal(L.summarize(await L.getLedger("u")).addAction.streak, 0, "a denial resets the streak");
});

test("ledger: delegate → tool stops asking; runs are receipts; revoke restores asking", async () => {
  const st = userStore(); const L = ledgerMod(st);
  await assert.rejects(L.setDelegation("u", "draftEmail", true), /not reversible/);
  await L.setDelegation("u", "addAction", true);
  assert.ok((await L.getDelegations("u")).has("addAction"));
  const n = await L.recordDelegatedRuns("u", [{ content: [{ type: "tool-result", toolName: "addAction", toolCallId: "tc-9" }, { type: "text", text: "hi" }] }], new Set(["addAction"]));
  assert.equal(n, 1);
  assert.equal(L.summarize(await L.getLedger("u")).addAction.auto, 1);
  await L.setDelegation("u", "addAction", false);
  assert.equal((await L.getDelegations("u")).has("addAction"), false);
});

test("ledger: edit distance is 0 for an unchanged draft and grows with the change", () => {
  const L = ledgerMod(userStore());
  assert.equal(L.editDistance("Hello Jane, attached is the proposal.", "Hello Jane, attached is the proposal."), 0);
  const small = L.editDistance("Hello Jane, attached is the proposal.", "Hi Jane, attached is the proposal.");
  const big = L.editDistance("Hello Jane, attached is the proposal.", "Completely different text about something else entirely.");
  assert.ok(small > 0 && small < 0.2, `small edit ${small}`); assert.ok(big > 0.6, `rewrite ${big}`);
});

test("ledger: months bucket approvals, denials, runs and edits — the Month 1 vs Month 6 view", async () => {
  const st = userStore(); const L = ledgerMod(st);
  await L.recordDecision("u", { tool: "addAction", decision: "approved", source: "chat" });
  await L.recordDecision("u", { tool: "event:send_email", decision: "approved", source: "event", edited: true, editDistance: 0.3 });
  await L.recordDecision("u", { tool: "event:send_email", decision: "denied", source: "event" });
  const [m] = L.monthly(await L.getLedger("u"));
  assert.equal(m.month, new Date().toISOString().slice(0, 7));
  assert.deepEqual([m.approved, m.denied, m.edits], [2, 1, 1]);
  assert.ok(Math.abs(m.approvalRate - 2 / 3) < 1e-9); assert.ok(Math.abs(m.meanEditDistance - 0.3) < 1e-9);
});

// ═════════════════════════════════════════════════════════════════════════════
// Tools: approval meta and delegation
// ═════════════════════════════════════════════════════════════════════════════

function toolsModule() {
  const noop = new Proxy({}, { get: () => async () => ({}) });
  return loadTs("lib/ai/tools.ts", {
    ai, zod: require("zod"),
    "@/lib/security/sensitive": loadTs("lib/security/sensitive.ts"),
    "@/lib/web/search": noop, "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/google/calendar": noop, "@/lib/google/gmail": noop, "@/lib/google/drive": noop, "@/lib/slack/client": noop,
    "@/lib/memory/store": noop, "@/lib/actions/store": noop, "@/lib/decisions/store": noop,
    "@/lib/events/audit": { emitAuditEvent: async () => {} }, "@/lib/linear/sync-actions": noop, "@/lib/linear/client": noop,
    "@/lib/contacts-lookup": { findContactByName: () => undefined, timezoneFromLocation: () => undefined }, "@/lib/contacts/user-store": noop,
  });
}

test("tools: every approval tool accepts why + confidence, and a delegated tool stops asking", () => {
  const T = toolsModule();
  const asking = T.buildAssistantTools("u", "Fixture", "Europe/London");
  const delegated = T.buildAssistantTools("u", "Fixture", "Europe/London", { delegated: new Set(["addAction"]) });
  const approvalTools = Object.entries(asking).filter(([, t]) => t.needsApproval === true).map(([n]) => n);
  assert.ok(approvalTools.length >= 10, `found ${approvalTools}`);
  for (const name of approvalTools) {
    const parsed = asking[name].inputSchema.safeParse({ ...minimalInput(asking[name].inputSchema), why: "Because you asked.", confidence: 0.8 });
    assert.equal(parsed.success, true, `${name}: ${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`);
  }
  assert.equal(delegated.addAction.needsApproval, false, "delegated: no approval");
  assert.equal(delegated.draftEmail.needsApproval, true, "everything else still asks");
});
/**
 * Build the smallest input a tool schema accepts, from the schema itself — so
 * the test does not have to know every tool's required fields by heart.
 */
function minimalInput(schema) {
  const out = {};
  for (const [key, field] of Object.entries(schema.shape ?? {})) {
    if (field.safeParse(undefined).success) continue; // optional / defaulted
    const candidates = ["x", "2026-09-26", "09:00", 1, true, ["x"], ...(field.options ?? []), ...Object.values(field.enum ?? {})];
    const hit = candidates.find((c) => field.safeParse(c).success);
    if (hit === undefined) throw new Error(`no minimal value for ${key}`);
    out[key] = hit;
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Relationships: importance, cadence, silence
// ═════════════════════════════════════════════════════════════════════════════

function computeModule() {
  return loadTs("lib/delta/compute.ts", {
    "./types": loadTs("lib/delta/types.ts"),
    "@/lib/delta/types": loadTs("lib/delta/types.ts"),
  });
}
const contact = (id, name, daysAgo, extra = {}) => ({
  id, name, initials: "", color: "", title: "", company: "", tags: [], status: "verified", type: "external",
  directory: "external", relationship: "", companyContext: "", personality: "", whatMakesThemTick: "", watchOut: "",
  recentActivity: "", activitySource: "", lastInteraction: iso(daysAgo), ...extra,
});
const NOISE = Array.from({ length: 12 }, (_, i) => contact(`n${i}`, `Person ${i}`, i));
const silence = (changes, id) => changes.find((c) => c.entityId === id && c.title === "Stakeholder has gone quiet");

test("a tagged key contact who has gone quiet is surfaced, not buried by recency", () => {
  const C = computeModule();
  const jane = contact("jane", "Jane Doe", 21, { tags: ["key"] });
  const { changes } = C.computeDeltas({ actions: [], decisions: [], contacts: [...NOISE, jane], since: new Date(Date.now() - 7 * DAY) });
  const s = silence(changes, "jane");
  assert.ok(s, "Jane is key by declaration and 21 days quiet — this must surface");
  assert.equal(s.severity, "high");
  assert.equal(s.observedAt, jane.lastInteraction, "the evidence carries its own date");
});

test("a contact outside the recency quartile still registers after twice the threshold", () => {
  const C = computeModule();
  const omar = contact("omar", "Omar Haddad", 20);
  const { changes } = C.computeDeltas({ actions: [], decisions: [], contacts: [...NOISE, omar], since: new Date(Date.now() - 7 * DAY) });
  assert.ok(silence(changes, "omar"), "20 days ≥ 2×7: non-key silence used to be graded 'low' and then dropped entirely");
});

test("a cadence the user set becomes that person's threshold and outranks everything", () => {
  const C = computeModule();
  const jane = contact("jane", "Jane Doe", 25);
  const { changes } = C.computeDeltas({
    actions: [], decisions: [], contacts: [...NOISE, jane], since: new Date(Date.now() - 7 * DAY),
    cadenceRules: [{ contactId: "jane", name: "Jane Doe", everyDays: 14 }],
  });
  const s = silence(changes, "jane");
  assert.ok(s); assert.equal(s.severity, "critical", "25d ≥ 1.5 × 14d");
  assert.match(s.context, /every 14 days/);
});

test("cadence rules parse the ways people actually phrase them, and resolve to one contact", () => {
  const R = loadTs("lib/contacts/cadence-rules.ts");
  const cases = [
    ["Keep in touch with Jane Doe every 3 weeks", "Jane Doe", 21],
    ["check in with Omar monthly", "Omar", 30],
    ["Jane Doe — fortnightly catch-up", "Jane Doe", 14],
    ["Monthly check-in with Priya Natarajan", "Priya Natarajan", 30],
    ["Talk to Jane each quarter", "Jane", 90],
  ];
  for (const [text, name, days] of cases) assert.deepEqual(plain(R.parseCadence(text)), { name, everyDays: days }, text);
  assert.equal(R.parseCadence("Jane prefers short emails"), null);
  const contacts = [{ id: "j", name: "Jane Doe" }, { id: "o", name: "Omar Haddad" }, { id: "o2", name: "Omar Ali" }];
  const rules = R.extractCadenceRules([{ id: "m1", content: "Keep in touch with Jane every 2 weeks" }, { id: "m2", content: "check in with Omar monthly" }], contacts);
  assert.deepEqual(plain(rules), [{ contactId: "j", name: "Jane Doe", everyDays: 14, memoryId: "m1" }], "ambiguous first name 'Omar' resolves to nobody");
});

// ═════════════════════════════════════════════════════════════════════════════
// Memory: pin, expire, relevance
// ═════════════════════════════════════════════════════════════════════════════

function memoryModule(seed) {
  const st = userStore({ "u/sage-memory.json": seed });
  return { M: loadTs("lib/memory/store.ts", { "@/lib/events/lock": makeLock(), "@/lib/storage/user-store": st.mocks, "@/lib/security/sensitive": loadTs("lib/security/sensitive.ts") }), st };
}
const mem = (id, kind, content, daysOld, extra = {}) => ({ id, kind, content, source: "chat", createdAt: iso(daysOld), updatedAt: iso(daysOld), ...extra });

test("memory: a pinned preference from month one survives forty newer memories", async () => {
  // Twelve newer preferences: the per-kind cap is ten, so newest-first (the old
  // policy) drops the month-one rule; pinned-first keeps it.
  const seed = [mem("old-rule", "preference", "Never book meetings before 10am", 180, { pinned: true }),
    ...Array.from({ length: 12 }, (_, i) => mem(`p${i}`, "preference", `Preference number ${i} about something`, i))];
  const { M } = memoryModule(seed);
  const prompt = await M.memoriesForPrompt("u");
  assert.match(prompt, /Never book meetings before 10am/, "pinned memories are the last to be cut");
});

test("memory: expired context is kept but not loaded; pinning exempts it; touching renews it", async () => {
  const { M, st } = memoryModule([
    mem("c-old", "context", "Preparing the board pack for the 12th", 10, { expiresAt: iso(3) }),
    mem("c-pinned", "context", "Fundraise is live until year end", 10, { expiresAt: iso(3), pinned: true }),
  ]);
  const prompt = await M.memoriesForPrompt("u");
  assert.doesNotMatch(prompt, /board pack/); assert.match(prompt, /Fundraise is live/);
  assert.equal(st.get("u", "sage-memory.json").length, 2, "nothing was deleted");
  const renewed = await M.updateMemory("u", "c-old", { content: "Preparing the board pack for the 19th" });
  assert.ok(new Date(renewed.expiresAt).getTime() > Date.now() + 6 * DAY, "edit renews the week");
  const created = await M.createMemory("u", { kind: "context", content: "Travelling next week" });
  assert.ok(created.expiresAt, "new context memories get a clock");
});

test("memory: the current turn steers which memories load", () => {
  const { M } = memoryModule([]);
  const items = [
    mem("a", "person", "Prefers decisions in writing", 1, { entity: "Jane Doe" }),
    mem("b", "person", "Likes a call before any proposal", 2, { entity: "Omar Haddad" }),
    mem("c", "fact", "The pricing proposal is due Friday", 3),
  ];
  const ranked = M.rankForPrompt(items, { text: "Draft the pricing proposal email to Omar Haddad" });
  assert.deepEqual(ranked.map((m) => m.id).slice(0, 2).sort(), ["b", "c"], "entity and topic matches come first; recency alone no longer decides");
});

// ═════════════════════════════════════════════════════════════════════════════
// Routes: confirmations, draft edits, modes
// ═════════════════════════════════════════════════════════════════════════════

test("actions PATCH: clearing needsReview records a `confirmed` interaction, a plain edit does not", async () => {
  const recorded = [];
  const items = [{ id: "a1", text: "t", source: "email", category: "task", needsReview: true, confidence: 0.55 }, { id: "a2", text: "t", source: "email", needsReview: false }];
  const route = loadTs("app/api/actions/[id]/route.ts", {
    "next/server": nextServer, zod: require("zod"),
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/api/respond": { parseBody: async (req, schema) => { const d = schema.safeParse(await req.json()); return d.success ? { ok: true, data: d.data } : { ok: false, response: { status: 400 } }; } },
    "@/lib/actions/store": { listActions: async () => plain(items), updateAction: async (_u, id, patch) => ({ ...items.find((a) => a.id === id), ...patch }), deleteAction: async () => true },
    "@/lib/learning/store": { recordInteraction: async (_u, e) => { recorded.push(e); } },
  });
  const patch = (id, body) => route.PATCH({ json: async () => body }, { params: Promise.resolve({ id }) });
  assert.equal((await patch("a1", { needsReview: false })).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(recorded.length, 1); assert.equal(recorded[0].action, "confirmed"); assert.equal(recorded[0].inferred, true); assert.equal(recorded[0].confidence, 0.55);
  await patch("a2", { needsReview: false }); await patch("a1", { text: "renamed" });
  await new Promise((r) => setImmediate(r));
  assert.equal(recorded.length, 1, "already-confirmed items and plain edits are not confirmations");
});

test("events PATCH: an edited draft is approved with its edit distance; a rejection is a denial", async () => {
  const decisions = [];
  const event = { id: "e1", status: "pending", actionType: "send_email", draft: { channel: "email", to: "x@example.invalid", body: "Hello Jane, attached is the proposal." }, createdAt: iso(0), updatedAt: iso(0) };
  const store = { getEvent: async () => plain(event), updateEvent: async (_u, _i, p) => ({ ...event, ...p }), updateEventStatus: async (_u, _i, status) => ({ ...event, status }), deleteEvent: async () => true,
    claimEventForExecution: async () => ({ claimed: true, event: plain(event) }) };
  const route = loadTs("app/api/events/[id]/route.ts", {
    "next/server": nextServer, "@/lib/auth": { getSessionUser: async () => "u" }, "@/lib/events/store": store,
    "@/lib/events/executor": { executeEvent: async () => ({ ok: true, summary: "sent" }) }, "@/lib/actions/store": { createAction: async () => ({}) },
    "@/lib/trust/ledger": { recordDecision: async (_u, d) => { decisions.push(d); return true; }, editDistance: loadTs("lib/trust/ledger.ts", { "@/lib/storage/user-store": userStore().mocks }).editDistance },
  });
  const params = { params: Promise.resolve({ id: "e1" }) };
  await route.PATCH({ json: async () => ({ status: "approved", draftBody: "Hi Jane, attached is the proposal." }) }, params);
  await route.PATCH({ json: async () => ({ status: "rejected" }) }, params);
  await new Promise((r) => setImmediate(r));
  assert.equal(decisions[0].decision, "approved"); assert.equal(decisions[0].edited, true); assert.ok(decisions[0].editDistance > 0 && decisions[0].editDistance < 0.2);
  assert.equal(decisions[1].decision, "denied"); assert.equal(decisions[1].ref, "event:e1");
});

test("mode API: the state round-trips and an unknown mode is refused", async () => {
  const st = userStore();
  const route = loadTs("app/api/mode/route.ts", {
    "next/server": nextServer, zod: require("zod"), "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/api/respond": { parseBody: async (req, schema) => { const d = schema.safeParse(await req.json()); return d.success ? { ok: true, data: d.data } : { ok: false, response: { status: 400, body: d.error.issues } }; } },
    "@/lib/storage/user-store": st.mocks, "@/lib/modes/config": loadTs("lib/modes/config.ts", { "@/lib/modes/types": {}, "./types": {} }),
  });
  const good = { active: "focus", activeSince: iso(0), activeUntil: null, previousMode: "default" };
  assert.equal((await route.PUT({ json: async () => ({ state: good }) })).status, 200);
  assert.deepEqual((await route.GET()).body.state, good);
  assert.equal((await route.PUT({ json: async () => ({ state: { ...good, active: "nonsense" } }) })).status, 400);
});

test("chat route: decisions are harvested, delegations reach the tools, the turn steers memory", async () => {
  const calls = { harvested: 0, delegatedSeen: null, focus: null };
  const route = loadTs("app/api/chat/route.ts", {
    ai: { ...ai, streamText: () => ({ toUIMessageStreamResponse: () => new Response("ok"), consumeStream: async () => {} }) },
    "@/lib/ai/model-config": { getChatModel: () => "mock-model", MAX_TOKENS: { default: 1 }, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/system-prompt": { getSystemPrompt: async (_u, _tz, focus) => { calls.focus = focus; return "sys"; } },
    "@/lib/ai/tools": { buildAssistantTools: (_u, _n, _tz, opts) => { calls.delegatedSeen = opts?.delegated; return {}; } },
    "@/lib/auth": { getSessionUser: async () => "u" }, "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture User" }) },
    "@/lib/timezone": { resolveTimezone: () => "Europe/London" }, "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/spend-guard": { reserveSpend: async () => ({ username: "u", feature: "chat", family: "opus5", reservedUsd: 0, heldKeys: [] }), commitSpend: async () => {}, releaseSpend: async () => {}, SpendCapError: class extends Error {}, spendCapResponse: () => new Response("cap", { status: 429 }) },
    "@/lib/billing/entitlement-store": { getEntitlement: async () => ({ plan: "pro", aiMonthlyUsd: 10 }) }, "@/lib/ai/tiering": { effectiveKind: () => "default" },
    "@/lib/ai/pricing": { CHAT_PRICE_FAMILY: "opus5", costUsd: () => 0 },
    "@/lib/trust/ledger": { getDelegations: async () => new Set(["addAction"]), recordApprovalResponses: async () => { calls.harvested += 1; return 0; }, recordDelegatedRuns: async () => 0 },
  });
  const body = { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Add a task to send Jane the proposal" }] }] };
  const res = await route.POST(new Request("http://x.invalid/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(res.status, 200);
  assert.equal(calls.harvested, 1); assert.ok(calls.delegatedSeen.has("addAction")); assert.match(calls.focus.text, /Jane the proposal/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Modes: when to offer Meeting Mode
// ═════════════════════════════════════════════════════════════════════════════

test("Meeting Mode is offered for a meeting with people starting within five minutes — not for blocks, not twice", () => {
  const S = loadTs("lib/modes/suggest.ts");
  const now = Date.parse("2026-09-26T09:00:00Z");
  const at = (min) => new Date(now + min * 60_000).toISOString();
  const events = [
    { id: "focus", summary: "Focus time", start: at(2), attendeeCount: 0 },
    { id: "allday", summary: "Offsite", start: at(1), attendeeCount: 5, isAllDay: true },
    { id: "later", summary: "Board prep", start: at(45), attendeeCount: 3 },
    { id: "standup", summary: "Standup", start: at(3), attendeeCount: 4 },
  ];
  const s = S.findMeetingSuggestion(events, now, "default", null);
  assert.deepEqual(plain(s), { eventId: "standup", summary: "Standup", startsInMin: 3, attendeeCount: 4 });
  assert.equal(S.findMeetingSuggestion(events, now, "meeting", null), null, "already in Meeting Mode");
  assert.equal(S.findMeetingSuggestion(events, now, "default", "standup"), null, "dismissed stays dismissed");
  assert.equal(S.findMeetingSuggestion(events, now + 4 * 60_000, "default", null).startsInMin, -1, "still offered just after it starts");
  assert.equal(S.findMeetingSuggestion(events, now + 10 * 60_000, "default", null), null, "gone once the window has passed");
});
