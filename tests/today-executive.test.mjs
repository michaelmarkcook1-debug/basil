/**
 * tests/today-executive.test.mjs
 *
 * The judgement layer for Today. These pin the decisions that make the page an
 * executive read rather than a ledger — the ones a later refactor would quietly
 * undo because each looks like a styling choice.
 *
 * Contract-lock: lib/today/executive.ts is TypeScript and the runner is plain
 * node:test over .mjs, so the pure functions are reimplemented here and the
 * source is asserted alongside. If the module changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/today/executive.ts"), "utf8");
const page = readFileSync(resolve(ROOT, "app/dashboard/page.tsx"), "utf8");

// ── Reimplementations ────────────────────────────────────────────────────────

const urgencyOf = (lane) =>
  lane === "critical" ? "act-now" : lane === "needs-you" ? "today" : "watch";

const TOP = 3;
function buildBoard(items) {
  const risks = items.filter((i) => i.kind === "change" && i.category === "relationship");
  const grouped = risks.length > 1 ? risks : null;
  const ids = new Set(grouped?.map((r) => r.id) ?? []);
  const singles = items.filter((i) => !ids.has(i.id));
  const all = grouped
    ? [...singles, {
        id: "group:relationship-risk", urgency: "today",
        rank: Math.max(...grouped.map((r) => r.rank)),
        groupedCount: grouped.length, members: grouped,
      }]
    : singles.map((i) => ({ ...i, urgency: urgencyOf(i.lane) }));
  all.sort((a, b) => b.rank - a.rank);
  return { top: all.slice(0, TOP), watchlist: all.slice(TOP) };
}

const listOf = (i) =>
  i.length <= 1 ? (i[0] ?? "")
  : i.length === 2 ? `${i[0]} and ${i[1]}`
  : `${i.slice(0, -1).join(", ")} and ${i[i.length - 1]}`;

// ── Priorities ───────────────────────────────────────────────────────────────

const rel = (id, rank) => ({ id, kind: "change", category: "relationship", rank, lane: "needs-you" });
const other = (id, rank, lane = "critical") => ({ id, kind: "change", category: "urgency", rank, lane });

test("three stakeholder-silence signals become ONE card, not three slots", () => {
  // The reported failure: three "has gone quiet" rows occupied three of the top
  // slots, so genuinely different work never reached the first screen.
  const board = buildBoard([
    other("a", 0.9), rel("r1", 0.71), rel("r2", 0.68), rel("r3", 0.55), other("b", 0.5),
  ]);
  const grouped = board.top.find((p) => p.id === "group:relationship-risk");
  assert.ok(grouped, "the relationship signals must be folded into one card");
  assert.equal(grouped.groupedCount, 3);
  assert.equal(board.top.length, 3);
  assert.deepEqual(board.top.map((p) => p.id), ["a", "group:relationship-risk", "b"],
    "grouping must free the other two slots for different work");
});

test("nothing is lost by grouping — every signal survives inside the card", () => {
  const board = buildBoard([rel("r1", 0.7), rel("r2", 0.6), rel("r3", 0.5)]);
  const grouped = board.top[0];
  assert.deepEqual(grouped.members.map((m) => m.id), ["r1", "r2", "r3"],
    "the individual signals must remain reachable, or grouping is deletion");
});

test("the grouped card ranks as its STRONGEST member", () => {
  // Averaging would bury a genuinely urgent relationship behind two weak ones.
  const board = buildBoard([other("a", 0.8), rel("r1", 0.95), rel("r2", 0.1)]);
  assert.equal(board.top[0].id, "group:relationship-risk");
});

test("a single relationship signal is left alone", () => {
  const board = buildBoard([other("a", 0.9), rel("r1", 0.7)]);
  assert.ok(!board.top.some((p) => p.id === "group:relationship-risk"),
    "grouping one thing is indirection, not clarity");
});

test("at most three priorities are expanded; the rest go to the watchlist", () => {
  const board = buildBoard(Array.from({ length: 9 }, (_, i) => other(`x${i}`, 1 - i / 10)));
  assert.equal(board.top.length, 3);
  assert.equal(board.watchlist.length, 6, "nothing may be dropped — only deferred");
  assert.ok(/TOP_PRIORITY_LIMIT = 3/.test(src), "the limit must be a named constant");
});

test("lanes map to the action vocabulary, not wire-service register", () => {
  assert.equal(urgencyOf("critical"), "act-now");
  assert.equal(urgencyOf("needs-you"), "today");
  assert.equal(urgencyOf("later"), "watch");
  assert.equal(urgencyOf("linear"), "watch");
  // Strip comments first: the module's own prose explains WHY the old terms were
  // dropped, and a naive scan matches that explanation. This has now caught the
  // test three times across this codebase — the rule is scan code, not prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/URGENT|FLASH/.test(code), "URGENT/FLASH describe transmission, not what to do");
  assert.ok(/"Act now"/.test(src) && /"Today"/.test(src) && /"Watch"/.test(src));
});

// ── The honesty rules ────────────────────────────────────────────────────────

test("a disconnected calendar is never reported as an empty day", () => {
  // The highest-severity failure this page can commit, and it is one line of
  // copy: "No meetings scheduled today" and "Basil cannot see your calendar"
  // are produced by an identical DayShape.
  assert.ok(/calendarConnected = true/.test(src),
    "operationalRead must know whether the calendar was actually readable");
  const fn = src.slice(src.indexOf("export function operationalRead"));
  const guard = fn.indexOf("!calendarConnected");
  const empty = fn.indexOf("No meetings scheduled today");
  assert.ok(guard > -1, "there must be a disconnected branch");
  assert.ok(guard < empty, "the disconnected branch must be reached BEFORE the empty-day sentence");
});

test("the page tells the read whether the calendar was readable", () => {
  assert.ok(/operationalRead\(board, day, missing, calConnected\)/.test(page),
    "connectivity must reach the headline sentence, not just the timeline panel");
  assert.ok(/const calConnected = !!cal\?\.connected && !calError/.test(page),
    "an errored calendar is as unreadable as a disconnected one");
});

test("unavailable and empty are different components", () => {
  const prim = readFileSync(resolve(ROOT, "components/today/primitives.tsx"), "utf8");
  assert.ok(/export function Unavailable/.test(prim) && /export function Empty/.test(prim),
    "'nothing needs you' and 'Basil cannot see whether anything needs you' must not share a component");
  assert.ok(/not an all-clear/.test(prim), "a read failure must say it is not an all-clear");
});

test("the operational read is composed, not generated", () => {
  // It must render when the AI budget is spent. A model call here would make the
  // executive summary the first thing to disappear on a capped day.
  assert.ok(!/generateText|streamText|reserveSpend|\/api\/chat/.test(src),
    "operationalRead must not depend on an AI call");
});

// ── Day shape ────────────────────────────────────────────────────────────────

test("clear time is measured between meetings, not from midnight", () => {
  assert.ok(/firstStart/.test(src) && /lastEnd/.test(src));
  const fn = src.slice(src.indexOf("export function buildDayShape"));
  assert.ok(!/00:00|startOfDay|setHours\(0/.test(fn),
    "counting from midnight reports a mostly-empty day as eight hours of focus time");
});

test("English lists read like English", () => {
  assert.equal(listOf(["Gmail"]), "Gmail");
  assert.equal(listOf(["Gmail", "Slack"]), "Gmail and Slack");
  assert.equal(listOf(["Gmail", "Slack", "Linear"]), "Gmail, Slack and Linear");
});

// ── Accessibility ────────────────────────────────────────────────────────────

test("status is never carried by colour alone", () => {
  const prim = readFileSync(resolve(ROOT, "components/today/primitives.tsx"), "utf8");
  assert.ok(/Icon: typeof AlertTriangle/.test(prim), "each urgency must carry an icon");
  assert.ok(/URGENCY_LABEL\[urgency\]/.test(prim), "and its word");
});

test("the harness can never be reached in production", () => {
  const h = readFileSync(resolve(ROOT, "app/dev-harness/today/page.tsx"), "utf8");
  const guards = [...h.matchAll(/NODE_ENV === "production"/g)];
  assert.ok(guards.length >= 2,
    "a route rendering fabricated executive data must be unreachable in production");
});
