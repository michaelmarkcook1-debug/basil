// Owner, 2026-11-25: "basil needs to be more intelligent with open tasks and
// promises. Many open tasks." 116 were open that morning: meeting notes that
// were never tasks, other people's jobs, the same follow-up written six ways,
// test-platform notifications. lib/actions/review.ts reads the whole list once a
// day. The same morning a local dry run purged 163 of the user's own tasks
// because it could not read who they were (restored); that path is guarded too.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const zod = require("zod");
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T06:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const shape = loadTs("lib/actions/done-lessons-shape.ts");

function reviewModule({ actions = [], record = null, judge, store = {} } = {}) {
  const writes = [];
  const records = [];
  let current = record;
  const R = loadTs("lib/actions/review.ts", {
    zod,
    "@/lib/actions/store": { listActions: async () => actions, bulkUpdateActions: async (_u, ups) => { writes.push(...ups); return ups.length; }, ...store },
    "@/lib/actions/check-done": { loadOutbound: async () => [] },
    "@/lib/calendar/unified": { readCalendar: async () => ({ events: [] }) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: ["Michael Cook"], emails: [] }) },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Michael Cook", timezone: "Europe/London" }) },
    "@/lib/away/store": { getWorkCalendar: async () => ({ away: [] }) },
    "@/lib/actions/done-lessons": { readDoneLessons: async () => [], lessonsBlock: shape.lessonsBlock },
    "@/lib/storage/user-store": { readUserStore: async () => current, writeUserStore: async (_u, _f, v) => { current = v; records.push(v); } },
    "@/lib/events/lock": makeLock(),
    "@/lib/ai/generate": { generateTextSafe: async () => { throw new Error("no model in tests"); } },
    "@/lib/ai/model-config": { getTextModel: () => "long" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
  });
  return { R, writes, records, judge };
}

const act = (over) => ({ id: "a", text: "Send Jessie the deck", owner: "Michael Cook", status: "open", source: "meeting", createdAt: ago(30), updatedAt: ago(30), ...over });
const v = (t, verdict, confidence, over = {}) => ({ t, verdict, confidence, reason: `${verdict} because`, evidence: "", ...over });

test("only Basil's own extractions are reviewed; the user's items never are", () => {
  const { R } = reviewModule();
  assert.equal(R.reviewable(act()), true);
  assert.equal(R.reviewable(act({ source: "email", status: "overdue" })), true);
  for (const over of [{ source: "manual" }, { source: "chat" }, { source: "linear" }, { delegatedAt: ago(1) }, { ongoing: true }, { reopenedAt: ago(2) }, { status: "done" }, { status: "dismissed" }]) {
    assert.equal(R.reviewable(act(over)), false, JSON.stringify(over));
  }
});

test("verdicts apply only when confident; noise-clearing verdicts have a lower bar", () => {
  const { R } = reviewModule();
  const tasks = ["T1", "T2", "T3", "T4", "T5", "T6"].map((t, i) => ({ t, a: act({ id: `id${i + 1}`, text: `task ${i + 1}` }) }));
  const plan = R.planReview(tasks, [
    v("T1", "not_a_task", 0.7),  // test notification at 0.7: closes
    v("T2", "not_mine", 0.72),   // closes
    v("T3", "done", 0.75),       // closing live work needs 0.8: stays
    v("T4", "expired", 0.79),    // stays
    v("T5", "keep", 0.99),       // stays
    v("T9", "done", 0.99),       // not a task in the list: ignored
  ]);
  assert.equal(JSON.stringify(plan.map((p) => p.a.id).sort()), JSON.stringify(["id1", "id2"]));
});

test("a duplicate closes only onto a task that stays open, never a pair onto each other", () => {
  const { R } = reviewModule();
  const tasks = ["T1", "T2", "T3", "T4", "T5"].map((t, i) => ({ t, a: act({ id: `id${i + 1}`, text: `Decision Desk follow-up ${i + 1}` }) }));
  const plan = R.planReview(tasks, [
    v("T1", "duplicate", 0.9, { of: "T2" }), // T2 kept → T1 closes
    v("T2", "keep", 0.9),
    v("T3", "duplicate", 0.9, { of: "T4" }), // T4 also closing → neither by duplicate
    v("T4", "duplicate", 0.9, { of: "T3" }),
    v("T5", "duplicate", 0.9, { of: "T5" }), // itself → ignored
  ]);
  assert.equal(JSON.stringify(plan.map((p) => p.a.id)), JSON.stringify(["id1"]));
  assert.equal(plan[0].canonical.id, "id2");
});

test("no run closes more than three quarters of what it reviewed", () => {
  const { R } = reviewModule();
  const tasks = Array.from({ length: 8 }, (_, i) => ({ t: `T${i + 1}`, a: act({ id: `id${i + 1}` }) }));
  const plan = R.planReview(tasks, tasks.map((x) => v(x.t, "not_a_task", 0.9)));
  assert.equal(plan.length, 6);
});

test("every close says why, can be reopened, and teaches the next run", () => {
  const { R } = reviewModule();
  const p = R.reviewPatch({ a: act({ notes: "earlier note" }), v: v("T1", "duplicate", 0.9, { of: "T2" }), canonical: act({ id: "k", text: "Get back to Matthew on Decision Desk" }) }, "2026-11-25T06:00:00.000Z");
  assert.equal(p.status, "done"); assert.equal(p.archivedReason, "duplicate"); assert.equal(p.closedByBasil, true);
  assert.match(p.notes, /^earlier note\nClosed by Basil on 2026-11-25: a duplicate — same as “Get back to Matthew on Decision Desk”\. Reopen it if not\.$/);
  // done-lessons reads the reason back when the user reopens it.
  assert.equal(shape.lastCloseReason(p.notes), "a duplicate — same as “Get back to Matthew on Decision Desk”");
  const kinds = Object.fromEntries(["done", "not_mine", "not_a_task", "expired"].map((k) => [k, R.reviewPatch({ a: act(), v: v("T1", k, 0.9) }, "2026-11-25T06:00:00.000Z").archivedReason]));
  assert.equal(JSON.stringify(kinds), JSON.stringify({ done: "done-elsewhere", not_mine: "not-mine", not_a_task: "not-a-task", expired: "expired" }));
});

test("the run closes what Claude is sure of, records the day, and does not run twice", async () => {
  const actions = [act({ id: "x", text: "Explore a monthly podcast" }), act({ id: "y", text: "Roger to finish the backfill", owner: "Roger" }), act({ id: "z" }), act({ id: "m", source: "manual" })];
  const m = reviewModule({ actions });
  let prompt = "";
  const judge = async (p) => { prompt = p; return [v("T1", "not_a_task", 0.9), v("T2", "not_mine", 0.9), v("T3", "keep", 0.9)]; };
  const r = await m.R.reviewOpenTasks("michael", { judge, now: NOW });
  assert.equal(r.reviewed, 3, "the hand-typed item is not reviewed");
  assert.equal(JSON.stringify(m.writes.map((w) => w.id).sort()), JSON.stringify(["x", "y"]));
  assert.match(prompt, /T1 \| .* \| Explore a monthly podcast/);
  assert.equal(m.records.at(-1).day, "2026-11-25");
  const again = await m.R.reviewOpenTasks("michael", { judge, now: NOW + 3_600_000 });
  assert.equal(again.skipped, "already-today");
  assert.equal(m.writes.length, 2, "nothing written the second time");
});

test("a dry run must be handed its data and writes nothing", async () => {
  const actions = [act({ id: "x" }), act({ id: "y" }), act({ id: "z" })];
  const listed = { n: 0 };
  const m = reviewModule({ actions, store: { listActions: async () => { listed.n++; return actions; } } });
  const judge = async () => [v("T1", "not_a_task", 0.9)];
  await assert.rejects(m.R.reviewOpenTasks("michael", { judge, dryRun: true, now: NOW }), /must be handed all its data/);
  const r = await m.R.reviewOpenTasks("michael", { judge, dryRun: true, now: NOW, actions, identity: { names: ["Michael Cook"] }, settings: { timezone: "Europe/London", name: "Michael Cook" }, absences: [], lessons: [], outbound: [], meetings: [] });
  assert.equal(r.closed.length, 1);
  assert.equal(listed.n, 0, "listActions (which writes) is never called");
  assert.equal(m.writes.length, 0); assert.equal(m.records.length, 0);
});

// ── The store: nothing is anyone else's when the user's identity is unknown ──

const utils = loadTs("lib/actions/utils.ts");
function actionStore(seed, identity) {
  let file = structuredClone(seed); const writes = [];
  const store = loadTs("lib/actions/store.ts", {
    "@/lib/away/store": { getWorkCalendar: async () => { throw new Error("no working calendar in this test"); }, declareAway: async () => ({}), endDeclaredAway: async () => 0, invalidateCalendarAbsences: async () => {} },
    "@/lib/away/calendar": loadTs("lib/away/calendar.ts"),
    "@/lib/events/lock": makeLock(),
    "@/lib/storage/user-store": { readUserStore: async () => structuredClone(file), writeUserStore: async (_u, _f, v) => { file = structuredClone(v); writes.push(v); } },
    "./classify": { classifyAction: () => ({}) },
    "./utils": utils,
    "@/lib/self-identity": { getSelfIdentity: identity, isSelf: () => false },
    "@/lib/security/sensitive": { redactSensitive: (s) => ({ text: s }) },
  });
  return { store, get: () => file };
}
const recent = (over) => ({ id: "a", text: "Send the deck", status: "open", source: "email", createdAt: new Date(Date.now() - 2 * DAY).toISOString(), updatedAt: new Date().toISOString(), ...over });

test("when who the user is cannot be read, none of their tasks is purged as someone else's", async () => {
  const s = actionStore([recent({ id: "mine", owner: "Michael Cook", text: "Send Jessie the overview deck" }), recent({ id: "other", owner: "Jamie Brooks", text: "Book the venue for the offsite" })], async () => { throw new Error("decrypt failed"); });
  const listed = await s.store.listActions("u");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.stringify(listed.map((a) => a.id).sort()), JSON.stringify(["mine", "other"]));
  assert.equal(s.get().length, 2, "nothing deleted");
});

test("with the identity known, a named stranger's task is still filtered out", async () => {
  const s = actionStore([recent({ id: "mine", owner: "Michael Cook", text: "Send Jessie the overview deck" }), recent({ id: "other", owner: "Jamie Brooks", text: "Book the venue for the offsite" })], async () => ({ names: ["Michael Cook"], emails: ["owner@corp.test"] }));
  const listed = await s.store.listActions("u");
  assert.equal(JSON.stringify(listed.map((a) => a.id)), JSON.stringify(["mine"]));
});

test("items an older version left as 'dismissed' are closed, not shown as open", async () => {
  const s = actionStore([recent({ id: "d", status: "dismissed", owner: "", text: "Respond to scheduling request from Olivia" }), recent({ id: "o", owner: "", text: "Reply to Maeve about the demo" })], async () => ({ names: ["Michael Cook"], emails: [] }));
  const listed = await s.store.listActions("u");
  assert.equal(listed.find((a) => a.id === "d").status, "done");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.get().find((a) => a.id === "d").status, "done", "persisted");
  assert.equal(s.get().length, 2);
});
