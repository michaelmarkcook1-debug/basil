/**
 * Pipedrive into Basil's context, follow-up suggestions and the opt-in
 * scheduler (2026-11-24).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const S = loadTs("lib/pipedrive/shape.ts");
const C = loadTs("lib/pipedrive/context.ts", { "@/lib/pipedrive/shape": S });
const F = loadTs("lib/pipedrive/followups.ts", { "@/lib/pipedrive/shape": S, "@/lib/psychology/playbook": loadTs("lib/psychology/playbook.ts") });
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const TODAY = "2026-11-24";
const ME = 1;
const deal = (o) => ({ id: 1, title: "Acme rollout", value: 50000, currency: "GBP", stage: "Proposal", status: "open", personId: 10, orgId: 100, expectedClose: null, updateTime: "2026-11-20T10:00:00Z", stageChangeTime: null, ownerId: ME, ...o });
const act = (o) => ({ id: 1, subject: "Call", type: "call", dueDate: null, dueTime: null, dealId: null, personId: null, orgId: null, updateTime: "2026-11-20T10:00:00Z", ownerId: ME, done: false, ...o });
const base = (o = {}) => ({
  userId: ME, at: Date.now(),
  persons: [{ id: 10, name: "Jane Doe", emails: ["jane@acme.com"], orgId: 100 }],
  orgs: [{ id: 100, name: "Acme Corp", website: "https://acme.com", domain: "acme.com" }],
  deals: [], activities: [], notes: [], leads: [], users: { "1": "Michael", "2": "Guy" },
  ...o,
});

test("after a meeting with nothing planned since → follow up; something planned → nothing", () => {
  const s = base({ deals: [deal({})], activities: [act({ id: 5, type: "meeting", subject: "Acme demo", done: true, doneTime: "2026-11-21T15:00:00Z", dealId: 1, personId: 10 })] });
  const [first] = F.suggestFollowups(s, { today: TODAY });
  assert.equal(first.kind, "after-meeting");
  assert.equal(first.contactEmail, "jane@acme.com");
  assert.match(first.why, /3 days ago/);
  const planned = { ...s, activities: [...s.activities, act({ id: 6, dueDate: "2026-11-28", dealId: 1 })] };
  assert.equal(F.suggestFollowups(planned, { today: TODAY }).length, 0);
});

test("one suggestion per deal, strongest reason first; colleagues' deals are not yours to chase", () => {
  const s = base({ deals: [
    deal({ id: 1, expectedClose: "2026-11-10", updateTime: "2026-10-01T00:00:00Z" }),
    deal({ id: 2, title: "Beta", personId: null, orgId: null, updateTime: "2026-10-01T00:00:00Z" }),
    deal({ id: 3, title: "Guy's deal", ownerId: 2 }),
  ] });
  const sugs = F.suggestFollowups(s, { today: TODAY });
  assert.deepEqual(JSON.parse(JSON.stringify(sugs.map((x) => [x.dealId, x.kind]))), [[1, "past-close"], [2, "going-cold"]]);
});

test("won/lost deals and dismissed suggestions are left alone; a dismissal lapses after 14 days", () => {
  const s = base({ deals: [deal({ status: "won" }), deal({ id: 2, title: "Open one" })] });
  const sugs = F.suggestFollowups(s, { today: TODAY });
  assert.deepEqual([...sugs.map((x) => x.dealId)], [2]);
  assert.equal(F.suggestFollowups(s, { today: TODAY, dismissed: { [sugs[0].id]: "2026-11-20T00:00:00Z" } }).length, 0);
  assert.equal(F.suggestFollowups(s, { today: TODAY, dismissed: { [sugs[0].id]: "2026-11-01T00:00:00Z" } }).length, 1);
});

test("account block: deals in every status, notes and activities for a person, found by email or company name", () => {
  const s = base({
    deals: [deal({}), deal({ id: 2, title: "Old pilot", status: "lost", lostTime: "2026-06-01T00:00:00Z", lostReason: "Budget" })],
    notes: [{ id: 1, content: "Wants SSO before signing", dealId: 1, personId: null, orgId: null, leadId: null, userId: 2, addTime: "2026-11-19T00:00:00Z", updateTime: "2026-11-19T00:00:00Z" }],
    activities: [act({ id: 3, subject: "Send pricing", dueDate: "2026-11-22", dealId: 1 })],
  });
  const byEmail = C.accountBlock(s, { emails: ["jane@acme.com"] }, TODAY);
  assert.match(byEmail, /Person: Jane Doe at Acme Corp/);
  assert.match(byEmail, /"Acme rollout" — £50,000 · Proposal/);
  assert.match(byEmail, /LOST 2026-06-01 \(Budget\)/);
  assert.match(byEmail, /by Guy on deal "Acme rollout": Wants SSO/);
  assert.match(byEmail, /OVERDUE 2d/);
  assert.match(C.accountBlock(s, { names: ["acme corp"] }, TODAY), /Organisation: Acme Corp/);
  assert.equal(C.accountBlock(s, { names: ["Nobody"] }, TODAY), "");
});

test("mentionedIn: whole names only, capped", () => {
  const s = base();
  assert.deepEqual([...C.mentionedIn(s, "What's happening with Acme Corp?").orgIds], [100]);
  assert.deepEqual([...C.mentionedIn(s, "Ping jane doe today").personIds], [10]);
  assert.deepEqual([...C.mentionedIn(s, "acmecorpx").orgIds], []);
});

test("briefing block: overdue, closing soon, won/lost, going cold", () => {
  const s = base({
    deals: [
      deal({ expectedClose: "2026-11-30" }),
      deal({ id: 2, title: "Won thing", status: "won", wonTime: "2026-11-22T00:00:00Z" }),
      deal({ id: 3, title: "Cold thing", updateTime: "2026-10-01T00:00:00Z" }),
    ],
    activities: [act({ subject: "Chase contract", dueDate: "2026-11-20" })],
  });
  const b = C.briefingBlock(s, TODAY);
  assert.match(b, /Open pipeline: 2 deals/);
  assert.match(b, /OVERDUE sales activities \(1\)/);
  assert.match(b, /close in the next 14 days \(1\)/);
  assert.match(b, /Won recently \(1\)/);
  assert.match(b, /going cold\) \(1\)/);
});

test("wiring: daily read, context everywhere, booking only from the user's click", () => {
  assert.match(src("vercel.json"), /"\/api\/cron\/pipedrive-sync"/);
  assert.match(src("lib/pipedrive/client.ts"), /FRESH_MS = 26 \* 60 \* 60 \* 1000/);
  assert.match(src("lib/ai/system-prompt.ts"), /getStoredPipedriveSnapshot/, "Ask Basil never calls Pipedrive while you wait");
  assert.match(src("app/api/generate/briefing/route.ts"), /### PIPEDRIVE/);
  assert.match(src("app/api/generate/meeting-prep/route.ts"), /## PIPEDRIVE — CRM RECORD/);
  assert.match(src("lib/contacts/generate-profile.ts"), /pipedriveEvidence/);
  const server = src("lib/pipedrive/followups-server.ts");
  assert.match(server, /mode !== "schedule"/, "booking needs the opt-in");
  assert.match(src("components/today/v2/followup-actions.tsx"), /Book &amp; send invite/, "a second click confirms the send");
  assert.doesNotMatch(src("lib/pipedrive/client.ts"), /method:\s*"(POST|PUT|PATCH|DELETE)"/, "never writes to Pipedrive");
});

test("meeting notes: every written-up meeting or call, newest first, in the account record and the briefing", () => {
  const s = base({
    deals: [deal({})],
    activities: [
      act({ id: 1, type: "meeting", subject: "Kick-off", done: true, doneTime: "2025-03-01T10:00:00Z", dealId: 1, note: "Agreed a 3-month pilot. Jane owns security review." }),
      act({ id: 2, type: "call", subject: "Check-in", done: true, doneTime: "2026-11-21T10:00:00Z", personId: 10, note: "Budget approved for Q1." }),
      act({ id: 3, type: "call", subject: "No notes", done: true, doneTime: "2026-11-22T10:00:00Z", personId: 10 }),
    ],
  });
  assert.deepEqual([...C.meetingNotes(s).map((a) => a.id)], [2, 1], "only written-up ones, newest first, old ones kept");
  const block = C.accountBlock(s, { emails: ["jane@acme.com"] }, TODAY);
  assert.match(block, /Meeting and call notes \(2, newest first\)/);
  assert.match(block, /2025-03-01 meeting "Kick-off".*\n  Agreed a 3-month pilot/);
  assert.match(C.briefingBlock(s, TODAY), /Meeting and call notes logged recently \(1\)/);
});

test("meeting notes are read in full and searchable", () => {
  const client = src("lib/pipedrive/client.ts");
  assert.match(client, /HISTORY_PAGES = 20/);
  assert.match(client, /\/notes", \{ sort: "update_time DESC" \}, HISTORY_PAGES/);
  assert.match(client, /!!\(a\.note \|\| a\.public_description\)\?\.trim\(\)/, "done activities with notes kept however old");
  assert.match(src("lib/ai/tools.ts"), /"meetings" = meeting and call notes, full history/);
});
