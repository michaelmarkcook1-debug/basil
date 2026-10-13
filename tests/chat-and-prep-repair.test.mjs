// Production failures, 2026-10-13:
//  - Ask Basil: an action awaiting approval was left unanswered and the user
//    asked something new. Claude rejected every later turn ("tool_use ids were
//    found without tool_result blocks"); the OpenAI fallback failed the same way.
//  - Meeting prep: '"…ication": None' (Python literal) → JSON.parse failed; and a
//    topic without a "priority" label failed schema validation. Three paid calls,
//    no prep.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const zod = require("zod");
const { repairOrphanedToolCalls } = loadTs("lib/ai/repair-history.ts", { ai });

const user = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const asking = (id, state, extra = {}) => ({
  id, role: "assistant",
  parts: [{ type: "text", text: "I can send this reply." },
          { type: "tool-replyToEmail", toolCallId: `tc-${id}`, state, input: { messageId: "m1", body: "Yes" }, approval: { id: `ap-${id}` }, ...extra }],
});

test("an approval left unanswered, then a new message → closed as 'not run', and the history converts cleanly", async () => {
  const history = [user("u1", "Reply yes to Priya"), asking("a1", "approval-requested"), user("u2", "Actually, what's on tomorrow?")];
  const { messages, repaired } = repairOrphanedToolCalls(history);
  assert.equal(repaired, 1);
  const part = messages[1].parts[1];
  assert.equal(part.state, "output-error");
  assert.match(part.errorText, /did not approve/);

  // Every tool call must be answered by a tool result — exactly what Claude checks.
  const model = await ai.convertToModelMessages(messages);
  const calls = model.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool-call").map((c) => c.toolCallId);
  const results = model.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool-result").map((c) => c.toolCallId);
  assert.equal(calls.join(","), "tc-a1");
  assert.equal(results.join(","), "tc-a1", "the call now has its result");
});

test("an approval in the LATEST message is still pending and untouched (approve/deny must keep working)", () => {
  const waiting = [user("u1", "Reply yes to Priya"), asking("a1", "approval-requested")];
  assert.equal(repairOrphanedToolCalls(waiting).repaired, 0);
  // The approve round-trip: the user approved, the tool has not run yet — it must run.
  const approved = [user("u1", "Reply yes to Priya"), asking("a1", "approval-responded", { approval: { id: "ap-a1", approved: true } })];
  const r = repairOrphanedToolCalls(approved);
  assert.equal(r.repaired, 0);
  assert.equal(r.messages[1].parts[1].state, "approval-responded");
});

test("an approval that arrived alongside a new message is closed with an honest reason", () => {
  const history = [user("u1", "Reply yes"), asking("a1", "approval-responded", { approval: { id: "ap-a1", approved: true } }), user("u2", "and book lunch")];
  const { messages, repaired } = repairOrphanedToolCalls(history);
  assert.equal(repaired, 1);
  assert.match(messages[1].parts[1].errorText, /not carried out/);
});

test("finished and interrupted calls behave as before", () => {
  const done = { id: "a0", role: "assistant", parts: [{ type: "tool-getCalendar", toolCallId: "t0", state: "output-available", input: {}, output: { ok: 1 } }] };
  const cut = { id: "a1", role: "assistant", parts: [{ type: "tool-getCalendar", toolCallId: "t1", state: "input-available", input: {} }] };
  const { messages, repaired } = repairOrphanedToolCalls([user("u", "x"), done, cut]);
  assert.equal(repaired, 1);
  assert.equal(messages[1].parts[0].state, "output-available");
  assert.equal(messages[2].parts[0].state, "output-error");
});

// ── Meeting prep ─────────────────────────────────────────────────────────────

const P = loadTs("lib/ai/parse-json.ts", { zod });
const { MeetingPrepOutputSchema } = loadTs("lib/ai/schemas.ts", { zod });

test("meeting prep: a Python 'None' in the answer no longer throws the prep away", () => {
  const text = '```json\n{\n  "fromTodaysCalls": [{"title": "AG Design", "summary": "Ran late.", "implication": None}],\n  "topicsToRaise": [],\n}\n```';
  const r = P.parseAndValidate(text, MeetingPrepOutputSchema, "[test]");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.fromTodaysCalls[0].title, "AG Design");
});

test("meeting prep: a topic without a priority label is kept, not fatal", () => {
  const text = JSON.stringify({ topicsToRaise: [{ title: "Backend handover", context: "Roger → Matthew" }, { title: "Pricing", context: "", priority: "Respond today" }] });
  const r = P.parseAndValidate(text, MeetingPrepOutputSchema, "[test]");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.topicsToRaise.length, 2);
  assert.equal(r.data.topicsToRaise[0].priority, "");
});

test("near-JSON repair never touches text inside quotes", () => {
  assert.equal(P.repairJsonLiterals('{"q": "None of it is True", "n": None, "t": [True, False,],}'),
    '{"q": "None of it is True", "n": null, "t": [true, false]}');
  assert.equal(P.repairJsonLiterals('{"q": "she said \\"None\\"", "x": NaN}'), '{"q": "she said \\"None\\"", "x": null}');
  const bad = P.parseAndValidate("not json at all", MeetingPrepOutputSchema, "[test]");
  assert.equal(bad.ok, false, "genuinely broken output still fails");
});
