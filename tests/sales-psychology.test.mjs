/**
 * Sales psychology for follow-ups and meeting prep (2026-11-24).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const P = loadTs("lib/psychology/playbook.ts");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const MON = "2026-11-23", FRI = "2026-11-27";

test("timing: after a meeting is today; after a proposal waits ~3 working days; respects their reply pace", () => {
  assert.equal(P.timingFor({ situation: "after-meeting", today: MON }).sendOn, MON);
  assert.equal(P.timingFor({ situation: "after-proposal", today: MON }).sendOn, "2026-11-26");
  assert.equal(P.timingFor({ situation: "after-proposal", today: FRI }).sendOn, "2026-12-02", "weekends don't count");
  const slow = P.timingFor({ situation: "awaiting-their-reply", today: MON, theirReplyHours: 96 });
  assert.equal(slow.sendOn, "2026-12-03", "twice their 4-day pace = 8 working days");
  assert.match(slow.why, /usually reply in about 96h/);
});

test("timing: two unanswered nudges → close the loop or add value; cooling tone → no chase today", () => {
  assert.match(P.timingFor({ situation: "awaiting-their-reply", today: MON, unansweredNudges: 2 }).why, /close the loop politely or bring genuinely new value/);
  const cold = P.timingFor({ situation: "going-cold", today: MON, tone: "cooling" });
  assert.equal(cold.sendOn, "2026-11-24");
  assert.match(cold.why, /assume circumstances, not disinterest/);
});

test("Monday and Friday sends get a time-of-day steer", () => {
  assert.match(P.timingFor({ situation: "they-are-waiting", today: MON }).bestTime, /after 10:00/);
  assert.match(P.timingFor({ situation: "they-are-waiting", today: FRI }).bestTime, /before 13:00/);
});

test("principles fit the moment: objections, personas, internal pitches", () => {
  const ids = (s) => [...P.principlesFor(s).map((p) => p.id)];
  assert.deepEqual(ids({ situation: "after-meeting" }).slice(0, 2), ["commitment", "reciprocity"]);
  assert.ok(ids({ situation: "after-proposal", objections: ["price"] }).includes("anchoring"));
  assert.ok(ids({ situation: "going-cold" }).includes("attribution"));
  const pitch = ids({ situation: "meeting-internal-pitch" });
  assert.ok(pitch.includes("reactive-devaluation") && pitch.includes("foot-in-door"));
  assert.ok(P.principlesFor({ situation: "after-meeting" }).every((p) => p.guard.length > 10), "every principle carries its ethical line");
});

test("meeting playbook: internal = sell yourself and your idea; external = read the room; ethics always", () => {
  const internal = P.meetingPlaybook({ kind: "internal", attendees: [{ name: "Guy", role: "CEO", persona: "economic", decides: "Data first, then gut" }] });
  assert.match(internal, /sell THEMSELVES and their idea or project/);
  assert.match(internal, /Guy — CEO; likely economic buyer.*decides: Data first, then gut/);
  assert.match(internal, /No invented urgency/);
  assert.match(P.meetingPlaybook({ kind: "external", attendees: [], dealStage: "Proposal" }), /deal stage: Proposal/);
});

test("wiring: follow-ups carry timing; advice is on demand; meeting prep has an influence plan", () => {
  assert.match(src("lib/pipedrive/followups.ts"), /timing: timingFor/);
  assert.match(src("lib/psychology/followup-advice.ts"), /"fast"/, "one fast-tier call, on demand");
  assert.match(src("lib/psychology/followup-advice.ts"), /day === st\.today/, "cached for the day");
  assert.match(src("lib/ai/schemas.ts"), /influencePlan: z\.object/);
  assert.match(src("app/api/generate/meeting-prep/route.ts"), /## HOW TO LAND IT/);
  assert.match(src("app/dashboard/meetings/[eventId]/page.tsx"), /Selling your idea/);
});
