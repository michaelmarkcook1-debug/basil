// Audit 2026-11-24, Part 3 entry 15: the Monday plan, the Friday wrap and the
// 30-day backlog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const AC = loadTs("lib/away/calendar.ts");
const W = loadTs("lib/briefing/week-rhythm.ts", { "@/lib/away/calendar": AC });
const B = loadTs("lib/actions/backlog.ts");
const cal = (over = {}) => ({ timezone: "Europe/London", workingDays: [1, 2, 3, 4, 5], holidayRegion: "none", away: [], ...over });

test("week starts on Monday", () => {
  assert.equal(W.weekStart("2026-11-24"), "2026-11-23");
  assert.equal(W.weekStart("2026-11-29"), "2026-11-23");
  assert.equal(W.weekStart("2026-11-30"), "2026-11-30");
});

test("first and last working day follow the working calendar", () => {
  assert.equal(W.isFirstWorkingDayOfWeek("2026-11-23", cal()), true);
  assert.equal(W.isFirstWorkingDayOfWeek("2026-11-24", cal()), false);
  assert.equal(W.isLastWorkingDayOfWeek("2026-11-27", cal()), true);
  assert.equal(W.isLastWorkingDayOfWeek("2026-11-26", cal()), false);
  // Friday off: Thursday is the last day; Monday off: Tuesday is the first.
  const off = cal({ away: [{ start: "2026-11-27", end: "2026-11-27", kind: "leave" }, { start: "2026-11-23", end: "2026-11-23", kind: "leave" }] });
  assert.equal(W.isLastWorkingDayOfWeek("2026-11-26", off), true);
  assert.equal(W.isFirstWorkingDayOfWeek("2026-11-24", off), true);
  assert.equal(W.isLastWorkingDayOfWeek("2026-11-28", cal()), false, "a weekend day is never the last working day");
});

test("the wrap goes an hour before the day ends", () => {
  assert.equal(W.wrapHour("18:00"), 17);
  assert.equal(W.wrapHour("17:30"), 16);
  assert.equal(W.wrapHour(undefined), 17);
});

test("plan and wrap open the briefing, which is written only when opened", () => {
  const p = W.mondayPlanNotification({ dueThisWeek: 4, waiting: 2 });
  assert.equal(p.url, "/dashboard/briefing?type=weekly&auto=1");
  assert.match(p.body, /^4 commitments due this week, 2 waiting on others\./);
  const w = W.fridayWrapNotification({ doneThisWeek: 7, backlog: 12 });
  assert.equal(w.url, "/dashboard/briefing?type=evening&auto=1");
  assert.match(w.body, /12 items untouched for 30\+ days/);
  const page = readFileSync(new URL("../app/dashboard/briefing/page.tsx", import.meta.url), "utf8");
  assert.match(page, /get\("auto"\) === "1"\) \{[\s\S]{0,200}void generate\(mountType\);/);
  assert.match(page, /\/dashboard\/actions\?filter=stale/);
});

test("backlog: open and untouched for 30+ days", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(B.isBacklog({ status: "open", updatedAt: "2026-10-20T00:00:00Z" }, now), true);
  assert.equal(B.isBacklog({ status: "open", updatedAt: "2026-11-01T00:00:00Z" }, now), false);
  assert.equal(B.isBacklog({ status: "done", updatedAt: "2026-01-01T00:00:00Z" }, now), false);
  assert.equal(B.isBacklog({ status: "open", lastActivityAt: "2026-11-20T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, now), false);
  assert.match(readFileSync(new URL("../app/dashboard/actions/page.tsx", import.meta.url), "utf8"), /statusFilter === "stale"\) return matchesSearch && isBacklog\(a\)/);
});

test("cron: plan at start of day, wrap an hour before the end, once each, behind the weekly choice", () => {
  const src = readFileSync(new URL("../app/api/cron/reminders/route.ts", import.meta.url), "utf8");
  assert.match(src, /if \(nstate\.prefs\.weekly\)/);
  assert.match(src, /onceKeys: \[`week-plan:\$\{today\}`\]/);
  assert.match(src, /onceKeys: \[`week-wrap:\$\{today\}`\]/);
  assert.doesNotMatch(src, /generate\/briefing/);
  assert.match(readFileSync(new URL("../lib/notify/rules.ts", import.meta.url), "utf8"), /weekly: true/);
});
