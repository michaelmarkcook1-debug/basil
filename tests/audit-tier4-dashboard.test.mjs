/**
 * Phase 5 — dashboard correctness: L4 subjects, L5 clock, L6 branding, L7 blocks.
 * Pure modules run directly; the feed runs with every integration mocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const X = loadTs("lib/today/executive.ts");
const C = loadTs("lib/today/clock.ts");
const plain = (v) => structuredClone(v);
const NOON = new Date("2026-09-15T12:00:00Z");
const ev = (id, start, end, attendeeCount) => ({ id, summary: id, start, end, isAllDay: false, attendeeCount, attendees: Array.from({ length: attendeeCount }, (_, i) => `p${i}@example.invalid`), hasVideo: false, isOrganizer: true, myResponseStatus: "accepted" });

// ── L5 ───────────────────────────────────────────────────────────────────────

test("L5 before the browser has a clock there is no time-dependent text to mismatch", () => {
  assert.equal(C.greeting(null, "Europe/London"), "Hello");
  const page = readFileSync(path.join(ROOT, "app/dashboard/page.tsx"), "utf8");
  assert.ok(!/useState\(\(\) => new Date\(\)\)/.test(page), "a Date created during render is the build's date on the server");
  assert.match(page, /useState<Date \| null>\(null\)/);
  const hero = readFileSync(path.join(ROOT, "components/today/hero.tsx"), "utf8");
  assert.ok(!/toLocaleDateString\("en-GB"/.test(hero), "the Hero must format through the shared clock, in one explicit zone");
});

test("L5 greeting and clock follow the user's zone, not the machine's", () => {
  const t = new Date("2026-09-15T22:30:00Z"); // 23:30 London, 18:30 New York, 07:30 next day Tokyo
  assert.equal(C.greeting(t, "Europe/London"), "Good evening");
  assert.equal(C.greeting(t, "America/New_York"), "Good evening");
  assert.equal(C.greeting(t, "Asia/Tokyo"), "Good morning");
  assert.deepEqual(plain(C.formatClock(t, "Asia/Tokyo")), { date: "Wednesday 16 September", time: "07:30" });
  assert.equal(C.formatClock(t, "Europe/London").time, "23:30");
});

// ── L7 ───────────────────────────────────────────────────────────────────────

test("L7 personal blocks are booked time but not meetings", () => {
  const day = X.buildDayShape([
    ev("focus", "2026-09-15T09:00:00+01:00", "2026-09-15T11:00:00+01:00", 0),
    ev("standup", "2026-09-15T11:00:00+01:00", "2026-09-15T11:30:00+01:00", 4),
    ev("lunch", "2026-09-15T12:30:00+01:00", "2026-09-15T13:30:00+01:00", 0),
    ev("decompress", "2026-09-15T16:00:00+01:00", "2026-09-15T16:30:00+01:00", 0),
  ], NOON, "Europe/London");
  assert.equal(day.meetingCount, 1, "one meeting with people");
  assert.equal(day.blockCount, 3, "three personal blocks");
  assert.equal(day.meetingMinutes, 240, "availability still counts every booked minute");
  assert.equal(day.segments.filter((s) => s.kind === "meeting").length, 4, "the timeline still shows every block");
});

test("L7 the operational read says which is which", () => {
  const board = X.buildPriorityBoard([]);
  const mixed = X.buildDayShape([ev("m", "2026-09-15T10:00:00+01:00", "2026-09-15T11:00:00+01:00", 2), ev("b", "2026-09-15T13:00:00+01:00", "2026-09-15T14:00:00+01:00", 0)], NOON, "Europe/London");
  assert.match(X.operationalRead(board, mixed, [], true).shape, /1 meeting and 1 personal block today/);
  const blocksOnly = X.buildDayShape([ev("b", "2026-09-15T13:00:00+01:00", "2026-09-15T14:00:00+01:00", 0)], NOON, "Europe/London");
  assert.match(X.operationalRead(board, blocksOnly, [], true).shape, /No meetings with anyone today; 1 personal block/);
  const stats = X.buildStatRow({ items: [], total: 0, generatedAt: "", sources: { changes: true, followups: { gmail: true, slack: true }, linear: true } }, "ready", mixed, null, true);
  assert.equal(stats.find((s) => s.key === "meet").count, 1, "the tile counts meetings with people");
});

// ── L4 ───────────────────────────────────────────────────────────────────────

const change = (over) => ({ id: "c1", category: "urgency", severity: "high", score: 1, title: "Due today", context: "Send the revised proposal to Jane", implication: "→ Deadline is today", occurredAt: NOON.toISOString(), source: "actions", entityId: "act-1", entityHref: "/dashboard/actions", subject: "Send the revised proposal to Jane", delta: { field: "dueDate" }, seen: false, ...over });
const item = (id, ch) => ({ id, kind: "change", rank: 1, lane: "critical", title: ch.subject ?? ch.title, subtitle: ch.subject ? ch.title : ch.context, occurredAt: ch.occurredAt, change: ch });

test("L4 a priority card leads with the task, and the kind of change supports it", () => {
  const board = X.buildPriorityBoard([item("change:c1", change({}))]);
  const top = board.top[0];
  assert.equal(top.title, "Send the revised proposal to Jane");
  assert.match(top.why, /Deadline is today/);
});

test("L4 the feed maps a change's subject to the headline", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const F = loadTs("lib/today/feed.ts", {
    "@/lib/memory/store": { listMemories: async () => [] },
    "@/lib/contacts/cadence-rules": { extractCadenceRules: () => [] },
      "@/lib/delta/compute": { computeDeltas: () => ({ changes: [change({})] }) },
      "@/lib/delta/types": { SEVERITY_WEIGHT: { critical: 1, high: 0.7, medium: 0.4 }, CATEGORY_CONFIG: { urgency: { weight: 1 } } },
      "@/lib/delta/store": { getSinceDate: async () => NOON.toISOString() },
      "@/lib/actions/store": { listActions: async () => [] }, "@/lib/decisions/store": { listDecisions: async () => [] },
      "@/lib/contacts/user-store": { listUserContacts: async () => [] }, "@/lib/contacts/overrides-store": { getAllOverridesFromStore: async () => ({}) },
      "@/lib/linear/client": { isLinearConnected: async () => false, getMyOpenIssues: async () => [] },
      "@/lib/followups/detect": { detectPendingFollowups: async () => ({ items: [], sources: { gmail: true, slack: true } }) },
      "@/lib/learning/store": { getLearning: async () => ({}) }, "@/lib/settings/store": { getSettings: async () => ({ timezone: "Europe/London" }) },
      "@/lib/learning/priors": { computeCategoryPriors: () => ({}) },
    });
    const feed = await F.computeTodayFeed("fixture");
    assert.equal(feed.items[0].title, "Send the revised proposal to Jane");
    assert.equal(feed.items[0].subtitle, "Due today");
  } finally { console.warn = quiet; }
});

test("L4 relationship cards name the contact and dedupe by contact id", () => {
  const quietOf = (id, name, sev = "high") => item(`change:silent:${id}`, change({ id: `silent-${id}`, category: "relationship", severity: sev, title: "Stakeholder has gone quiet", subject: name, context: `${name} — no activity for 21 days`, source: "contacts", entityId: id, entityHref: "/dashboard/contacts" }));
  const items = [quietOf("p1", "Jane Doe"), quietOf("p2", "Omar Haddad"), quietOf("p1", "Jane Doe", "medium")];
  assert.equal(X.subjectOf(items[0]), "Jane Doe");
  assert.equal(X.entityKeyOf(items[0]), "contacts:p1");
  const board = X.buildPriorityBoard(items);
  const grouped = board.top.find((p) => p.groupedCount);
  assert.ok(grouped, "silence signals fold into one card");
  assert.match(grouped.why, /Jane Doe/);
  assert.match(grouped.why, /Omar Haddad/);
  assert.doesNotMatch(grouped.why, /Stakeholder/);
  assert.equal((grouped.why.match(/Jane Doe/g) ?? []).length, 1, "the same contact appears once");
  assert.equal(grouped.groupedCount, 2, "two people, not three signals");
  assert.match(grouped.title, /^2 relationships need attention$/);
});

test("L4 compute.ts stamps a subject on every change it emits", () => {
  const src = readFileSync(path.join(ROOT, "lib/delta/compute.ts"), "utf8");
  const titles = (src.match(/^\s*title: (?!string;)/gm) ?? []).length; // values, not the interface field
  const subjects = (src.match(/^\s*subject: /gm) ?? []).length;
  assert.equal(subjects, titles, `every change kind carries a subject (${subjects}/${titles})`);
});

// ── L6 ───────────────────────────────────────────────────────────────────────

test("L6 no placeholder company is rendered anywhere in the app", () => {
  const { execSync } = require_("node:child_process");
  // lib/contacts-data.ts (gated-off SAMPLE contacts) and app/api/events/seed
  // (dev seed data) are fixtures, not rendered or prompted content.
  const hits = execSync(`grep -rl "Example Holdings" app components lib --exclude=contacts-data.ts --exclude-dir=seed 2>/dev/null || true`, { cwd: ROOT }).toString().trim();
  assert.equal(hits, "", `still present in rendered or prompt paths: ${hits}`);
});
function require_(m) { return globalThis.process.getBuiltinModule(m); }
