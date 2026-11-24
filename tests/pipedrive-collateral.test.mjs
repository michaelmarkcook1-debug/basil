/**
 * Collateral suggestions + prompts (2026-11-24): Basil suggests and writes
 * prompts; it never creates the collateral.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const S = loadTs("lib/pipedrive/shape.ts");
const K = loadTs("lib/pipedrive/collateral.ts", { "@/lib/pipedrive/shape": S });
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const TODAY = "2026-11-24";
const deal = (o) => ({ id: 1, title: "Acme rollout", value: 50000, currency: "GBP", stage: "Proposal Made", status: "open", personId: 10, orgId: 100, expectedClose: "2026-12-15", updateTime: "2026-11-22T10:00:00Z", stageChangeTime: null, ...o });
const ctx = (o = {}) => ({
  deal: deal({}), org: { id: 100, name: "Acme Corp", industry: "Logistics" },
  people: [{ id: 10, name: "Jane Doe", jobTitle: "CFO", emails: ["jane@acme.com"], orgId: 100 }, { id: 11, name: "Raj Patel", jobTitle: "Talent Acquisition Specialist", emails: [], orgId: 100 }],
  meetings: [], notes: [], planned: [], today: TODAY, ...o,
});

test("personas from job titles", () => {
  assert.equal(K.personaOf("CFO"), "economic");
  assert.equal(K.personaOf("VP Engineering"), "technical");
  assert.equal(K.personaOf("Recruiter"), "end-user");
  assert.equal(K.personaOf(undefined), undefined);
});

test("stage bands", () => {
  assert.equal(K.stageBand("Lead In"), "early");
  assert.equal(K.stageBand("Qualified"), "discovery");
  assert.equal(K.stageBand("Demo Scheduled"), "demo");
  assert.equal(K.stageBand("Proposal Made"), "proposal");
  assert.equal(K.stageBand("Negotiations Started"), "negotiation");
});

test("proposal stage with a CFO: proposal, ROI calculator, champion one-pager — each with a grounded prompt", () => {
  const sugs = K.suggestCollateral(ctx());
  const kinds = sugs.map((s) => s.kind);
  assert.ok(kinds.includes("proposal") && kinds.includes("roi-calculator") && kinds.includes("champion-one-pager"));
  const p = sugs.find((s) => s.kind === "proposal").prompt;
  assert.match(p, /Client: Acme Corp — Logistics/);
  assert.match(p, /Jane Doe, CFO \(likely economic buyer\)/);
  assert.match(p, /£50,000, stage "Proposal Made"/);
  assert.match(p, /Do not invent statistics, customer names/);
  assert.match(p, /\[paste your value proposition/, "missing selling context is a placeholder, not invented");
});

test("a fresh meeting puts the recap first; objections in the notes get a live response", () => {
  const sugs = K.suggestCollateral(ctx({
    meetings: [{ id: 1, subject: "Pricing review", type: "meeting", done: true, doneTime: "2026-11-23T10:00:00Z", dueDate: null, dueTime: null, dealId: 1, personId: 10, orgId: 100, updateTime: "", note: "Jane said it's too expensive versus their current agency. Needs board approval in January." }],
    sellerContext: "We cut time-to-hire by 40% (Globex case study).",
  }));
  assert.equal(sugs[0].kind, "recap-one-pager");
  const themes = sugs.filter((s) => s.kind === "objection-response").map((s) => s.title);
  assert.ok(themes.some((t) => /price/.test(t)));
  assert.match(sugs[0].prompt, /too expensive versus their current agency/);
  assert.match(sugs[0].prompt, /We cut time-to-hire by 40%/);
});

test("lost deal → win-loss notes only; won deal → nothing; quiet deal → re-engagement", () => {
  assert.deepEqual([...K.suggestCollateral(ctx({ deal: deal({ status: "lost", lostReason: "Budget" }) })).map((s) => s.kind)], ["win-loss-notes"]);
  assert.equal(K.suggestCollateral(ctx({ deal: deal({ status: "won" }) })).length, 0);
  const quiet = K.suggestCollateral(ctx({ deal: deal({ stage: "Qualified", updateTime: "2026-10-01T00:00:00Z", expectedClose: null }) }));
  assert.ok(quiet.some((s) => s.kind === "re-engagement-email"));
  assert.ok(quiet.some((s) => s.kind === "discovery-talk-track"));
});

test("Basil suggests and prompts; it does not write collateral", () => {
  assert.match(src("lib/ai/system-prompt.ts"), /You do NOT write decks, one-pagers or proposals/);
  assert.match(src("lib/ai/tools.ts"), /Do not draft the collateral yourself/);
  assert.doesNotMatch(src("lib/pipedrive/collateral-server.ts"), /generateText|generateValidated/, "no model call");
});
