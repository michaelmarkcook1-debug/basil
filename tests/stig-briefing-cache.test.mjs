// The Briefing page's operational read was rebuilt on every visit through the
// full Ask machinery — whole chat prompt, every tool, up to 7 model rounds —
// ~70–100k input tokens, $0.37–0.46 a visit; it tripped the daily cap on
// 2026-10-13. Now: one lean call, reused for 3 hours, then reused while the
// sources are unchanged; rebuilt on a new day or on Refresh.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const HOUR = 3_600_000;
const TZ = "Europe/London";

function engine({ cached = null, pack = "# pack\nGenerated: X\nSlack: Ed asked about pricing" } = {}) {
  const calls = { model: [], context: 0, writes: [] };
  let store = cached;
  class SpendCapError extends Error {}
  const E = loadTs("lib/stig/engine.ts", {
    ai: { stepCountIs: (n) => ({ n }) },
    "@/lib/ai/model-config": { getChatModel: () => "opus", MAX_TOKENS: { default: 2000 }, PROVIDER_MODE: "direct" },
    "@/lib/ai/generate": { generateTextSafe: async (opts, kind, meter) => { calls.model.push({ opts, kind, meter }); return { text: "Your first move: reply to Ed." }; } },
    "@/lib/ai/spend-guard": { SpendCapError },
    "@/lib/ai/system-prompt": {
      getSystemPrompt: async () => { throw new Error("the full chat prompt must not be used for the read"); },
      getTaskSystemPrompt: async () => "TASK PROMPT",
    },
    "@/lib/ai/tools": { buildAssistantTools: () => { throw new Error("no tools for the read"); } },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Michael Cook", timezone: TZ }) },
    "@/lib/stig/context": {
      buildStigContext: async () => { calls.context++; return { sources: [{ source: "slack", status: "ok" }] }; },
      formatStigContextBudgeted: () => pack,
    },
    "@/lib/stig/intent": { analyseIntent: () => ({ isBroad: false }) },
    "@/lib/stig/error-mapper": { mapProviderError: (e) => ({ userMessage: String(e), code: "x" }) },
    "@/lib/stig/budget": { WORKSPACE_CONTEXT_BUDGET: 15000 },
    "@/lib/generate-cache/store": {
      readGenerateCache: async () => store,
      writeGenerateCache: async (_u, type, content, opts) => { calls.writes.push({ type, opts }); store = { content, generatedAt: content.generatedAt, inputHash: opts.inputHash }; },
      computeInputHash: (...parts) => parts.join("|").length.toString(16) + parts.join("|").slice(-20),
    },
  });
  const setPack = (p) => { pack = p; };
  return { E, calls, setPack, get store() { return store; } };
}

test("decision rules", () => {
  const { E } = engine();
  const now = Date.parse("2026-10-14T15:00:00Z");
  const at = (h) => ({ generatedAt: new Date(now - h * HOUR).toISOString(), inputHash: "h1" });
  assert.equal(E.stigBriefingDecision(null, now, TZ), "rebuild");
  assert.equal(E.stigBriefingDecision(at(1), now, TZ, { refresh: true }), "rebuild");
  assert.equal(E.stigBriefingDecision(at(1), now, TZ), "reuse");
  assert.equal(E.stigBriefingDecision(at(4), now, TZ), "check-inputs");
  assert.equal(E.stigBriefingDecision(at(4), now, TZ, { inputHash: "h1" }), "reuse");
  assert.equal(E.stigBriefingDecision(at(4), now, TZ, { inputHash: "h2" }), "rebuild");
  assert.equal(E.stigBriefingDecision(at(20), now, TZ), "rebuild", "yesterday's read talks about yesterday");
});

test("first visit builds one lean read — no tools, no full chat prompt, one call — and stores it", async () => {
  const t = engine();
  const r = await t.E.runStigBriefing("michael", "session");
  assert.equal(r.cached, false);
  assert.equal(r.briefing, "Your first move: reply to Ed.");
  assert.equal(t.calls.model.length, 1);
  const { opts, meter } = t.calls.model[0];
  assert.equal(opts.tools, undefined, "no tools");
  assert.equal(opts.stopWhen, undefined, "no multi-round loop");
  assert.match(opts.system, /^TASK PROMPT/);
  assert.match(opts.prompt, /Ed asked about pricing/);
  assert.equal(meter.feature, "stig:briefing");
  assert.equal(t.calls.writes[0].type, "stig-briefing");
});

test("a second visit reuses the stored read without touching sources or the model", async () => {
  const t = engine();
  await t.E.runStigBriefing("michael", "session");
  const again = await t.E.runStigBriefing("michael", "session");
  assert.equal(again.cached, true);
  assert.equal(t.calls.model.length, 1);
  assert.equal(t.calls.context, 1, "inside 3 hours the sources aren't even gathered");
});

test("older than 3 hours: unchanged sources → reuse; changed sources → rebuild; Refresh → rebuild", async () => {
  const now = Date.now();
  const old = new Date(now - 4 * HOUR);
  const sameDay = old.toLocaleDateString("en-CA", { timeZone: TZ }) === new Date(now).toLocaleDateString("en-CA", { timeZone: TZ });
  if (!sameDay) return; // the 4-hours-ago instant fell on another day — covered by the decision test
  const t = engine();
  await t.E.runStigBriefing("michael", "session");
  t.store.generatedAt = old.toISOString();                       // age the stored read
  const unchanged = await t.E.runStigBriefing("michael", "session");
  assert.equal(unchanged.cached, true);
  assert.equal(t.calls.model.length, 1);
  t.setPack("# pack\nGenerated: Y\nSlack: Olivia flagged a blocker"); // something happened
  const changed = await t.E.runStigBriefing("michael", "session");
  assert.equal(changed.cached, false);
  assert.equal(t.calls.model.length, 2);
  await t.E.runStigBriefing("michael", "session", { refresh: true });
  assert.equal(t.calls.model.length, 3);
});

test("the pack's own timestamp does not count as a change", () => {
  const { E } = engine();
  assert.equal(E.sourcePackFingerprint("m", "# p\nGenerated: 10:00\nSlack: x"), E.sourcePackFingerprint("m", "# p\nGenerated: 11:45\nSlack: x"));
  assert.notEqual(E.sourcePackFingerprint("m", "# p\nGenerated: 10:00\nSlack: x"), E.sourcePackFingerprint("m", "# p\nGenerated: 10:00\nSlack: y"));
});
