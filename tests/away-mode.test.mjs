// Away mode, first release (2026-11-10). Basil treated all 365 days alike: the
// briefing was written and emailed on weekends, bank holidays and through a
// two-week honeymoon; Today greeted an out-of-office user with "8½ h free to
// think"; an unanswered message turned "critical" over a weekend; and leave
// could auto-archive commitments the user never had the chance to see.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const C = loadTs("lib/away/calendar.ts");
// Values built inside the loadTs sandbox come from another realm, so
// deepStrictEqual fails on identical arrays; compare their JSON instead.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const LONDON = "Europe/London";
// Michael's honeymoon: Tue 3 to Fri 13 November 2026.
const HONEYMOON = { id: "basil:h", start: "2026-11-03", end: "2026-11-13", source: "basil", cover: "Guy Saunders" };
const cal = (over = {}) => ({ timezone: LONDON, workingDays: [1, 2, 3, 4, 5], holidayRegion: "england-and-wales", away: [], ...over });

// ── Bank holidays ───────────────────────────────────────────────────────────

test("bank holidays are the official gov.uk dates, and the rules reproduce every regular one", () => {
  // Read from https://www.gov.uk/bank-holidays.json on 2026-11-10.
  const ew2026 = ["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28"];
  same(C.bankHolidays("england-and-wales", 2026), ew2026);
  for (const year of [2025, 2026, 2027, 2028]) {
    same(C.__ruleBasedHolidays("england-and-wales", year), C.bankHolidays("england-and-wales", year), `E&W ${year}`);
    same(C.__ruleBasedHolidays("northern-ireland", year), C.bankHolidays("northern-ireland", year), `NI ${year}`);
    // Scotland's 15 June 2026 was a one-off no rule predicts; everything else matches.
    same(C.__ruleBasedHolidays("scotland", year), C.bankHolidays("scotland", year).filter((d) => d !== "2026-06-15"), `Scotland ${year}`);
  }
  assert.ok(C.isBankHoliday("2027-12-28", "england-and-wales"), "Boxing Day on a Sunday moves to Tuesday");
  assert.equal(C.isBankHoliday("2026-12-25", "none"), false);
  assert.equal(C.bankHolidays("england-and-wales", 2031).length, 8, "years past the table fall back to the rules");
  assert.equal(C.defaultHolidayRegion("Europe/London"), "england-and-wales");
  assert.equal(C.defaultHolidayRegion("America/New_York"), "none");
});

// ── What kind of day it is ──────────────────────────────────────────────────

test("leave, weekends and the first day back", () => {
  const c = cal({ away: [HONEYMOON] });
  const mid = C.awayStatus("2026-11-09", c);
  assert.equal(mid.state, "away");
  assert.equal(mid.returnDay, "2026-11-16", "back on the Monday after the leave");
  same(C.awayStatus("2026-11-14", c), { state: "non-working", today: "2026-11-14", reason: "weekend" });
  const back = C.awayStatus("2026-11-16", c);
  assert.equal(back.state, "back");
  assert.equal(back.since, "2026-11-02", "the return briefing reads from the last working day before the leave");
  assert.equal(back.period.cover, "Guy Saunders");
  same(C.awayStatus("2026-11-17", c), { state: "working", today: "2026-11-17", since: "2026-11-16" });
  assert.equal(C.awayStatus("2026-11-23", c).since, "2026-11-20", "Monday reads the weekend from Friday");
});

test("bank holidays are days off, and the day after Christmas week reads back to the last working day", () => {
  const c = cal();
  same(C.awayStatus("2026-12-25", c), { state: "non-working", today: "2026-12-25", reason: "bank-holiday" });
  assert.equal(C.awayStatus("2026-12-28", c).state, "non-working");
  assert.equal(C.awayStatus("2026-12-29", c).since, "2026-12-24");
  // Someone who works Sunday to Thursday.
  const gulf = cal({ workingDays: [0, 1, 2, 3, 4], holidayRegion: "none", timezone: "Asia/Dubai" });
  assert.equal(C.awayStatus("2026-11-13", gulf).state, "non-working", "Friday off");
  assert.equal(C.awayStatus("2026-11-15", gulf).state, "working", "Sunday on");
});

// ── Paused clocks ───────────────────────────────────────────────────────────

test("a reply clock counts only working days the user was not away", () => {
  const c = cal({ away: [HONEYMOON] });
  const at = (iso) => Date.parse(iso);
  // Friday 15:00 to Monday 10:00: 9 + 10 hours, not 67.
  assert.equal(C.workingHoursBetween(at("2026-11-20T15:00:00Z"), at("2026-11-23T10:00:00Z"), c), 19);
  // Left the day before the honeymoon, read on the first morning back: 12 + 9 hours, not two weeks.
  assert.equal(C.workingHoursBetween(at("2026-11-02T12:00:00Z"), at("2026-11-16T09:00:00Z"), c), 21);
  // Clock-change day: Sunday 25 October 2026 has 25 hours in London.
  const sevenDays = cal({ workingDays: [0, 1, 2, 3, 4, 5, 6], holidayRegion: "none" });
  assert.equal(C.workingHoursBetween(C.midnightIn("2026-10-25", LONDON), C.midnightIn("2026-10-26", LONDON), sevenDays), 25);
  assert.equal(C.workingHoursBetween(5, 1, c), 0);
  // Days away, for the age rules and relationship silence.
  assert.equal(C.pausedDays("2026-11-01", "2026-11-16", c), 11, "the eleven calendar days of leave, its weekend included");
  assert.equal(C.pausedDays("2026-11-01", "2026-11-16", c, { nonWorking: true }), 14, "plus the weekend days either side");
});

test("the Today feed grades a waiting reply on those hours, and only key people break through while away", () => {
  const feed = src("lib/today/feed.ts");
  assert.match(feed, /const sev = followupSeverity\(hoursCounted\);/);
  assert.match(feed, /workingHoursBetween\(lastInbound, nowMs, workCal\)/);
  assert.match(feed, /fromKeyContact: true/);
  const page = src("app/dashboard/page.tsx");
  assert.match(page, /\(i\.kind === "followup" && i\.fromKeyContact\) \|\| \(i\.kind === "linear" && i\.issue\.priority === 1\)/);
  assert.match(page, /Held until you’re back/);
  assert.match(src("lib/delta/compute.ts"), /daysSince\(c\.lastInteraction\) - \(awayDaysSince\?\.\(c\.lastInteraction\) \?\? 0\)/);
});

test("age rules discount days away, so leave does not archive what the user never saw", () => {
  const U = loadTs("lib/actions/utils.ts");
  const now = Date.parse("2026-11-16T09:00:00Z");
  const c = cal({ away: [HONEYMOON] });
  const away = (iso) => C.pausedDays(C.dayIn(Date.parse(iso), LONDON), "2026-11-16", c);
  const RealNow = Date.now;
  Date.now = () => now;
  try {
    const overdue = { id: "a", status: "open", source: "email", text: "x", dueDate: "2026-11-01", createdAt: "2026-10-20T10:00:00Z" };
    assert.equal(U.isOverdueStale(overdue), true, "15 days overdue by the calendar");
    assert.equal(U.isOverdueStale(overdue, away), false, "6 once the nine days away are taken off");
    const untouched = { id: "b", status: "open", source: "slack", text: "y", createdAt: "2026-10-14T10:00:00Z" };
    assert.equal(U.isUntouchedStale(untouched, now), true, "33 days by the calendar");
    assert.equal(U.isUntouchedStale(untouched, now, away), false, "24 once the leave is taken off");
  } finally {
    Date.now = RealNow;
  }
  const store = src("lib/actions/store.ts");
  assert.match(store, /const staleOverdue = awayNow \? \[\] :/);
  assert.match(store, /const untouched = awayNow \? \[\] :/);
  assert.match(store, /if \(awayNow\) return false;/, "no unowned-overdue purge while away");
});

// ── Reading absence from Google Calendar ────────────────────────────────────

test("out-of-office blocks and the user's own leave days become absences; a few hours or a colleague's leave do not", () => {
  const periods = C.awayPeriodsFromEvents([
    { id: "1", eventType: "outOfOffice", summary: "Out of office", start: { dateTime: "2026-11-03T00:00:00Z" }, end: { dateTime: "2026-11-14T00:00:00Z" } },
    { id: "2", eventType: "outOfOffice", summary: "Dentist", start: { dateTime: "2026-11-20T13:00:00Z" }, end: { dateTime: "2026-11-20T16:00:00Z" } },
    { id: "3", summary: "Annual leave", start: { date: "2026-12-21" }, end: { date: "2026-12-24" }, organizer: { self: true } },
    { id: "4", summary: "Ed - holiday", start: { date: "2026-12-01" }, end: { date: "2026-12-02" }, organizer: { self: false }, attendees: [{ self: true }, { self: false }] },
    { id: "5", eventType: "outOfOffice", status: "cancelled", start: { date: "2027-01-04" }, end: { date: "2027-01-05" } },
    { id: "6", summary: "Board offsite", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, organizer: { self: true } },
  ], LONDON);
  same(periods.map((p) => [p.id, p.start, p.end]), [
    ["cal:1", "2026-11-03", "2026-11-13"],
    ["cal:3", "2026-12-21", "2026-12-23"],
  ]);
  assert.ok(C.isAbsenceEvent({ eventType: "outOfOffice", summary: "Out of office" }));
  assert.ok(!C.isAbsenceEvent({ summary: "Holiday planning", isAllDay: false, attendeeCount: 3 }));
});

// ── The store ───────────────────────────────────────────────────────────────

function store({ settings = {}, events = [], googleFails = false } = {}) {
  const files = new Map();
  const reads = { google: 0 };
  const userStore = {
    readUserStore: async (_u, f, fb) => structuredClone(files.get(f) ?? fb),
    writeUserStore: async (_u, f, d) => { files.set(f, structuredClone(d)); },
    updateUserStore: async (_u, f, m, fb) => { const next = m(structuredClone(files.get(f) ?? fb)); files.set(f, structuredClone(next)); return next; },
  };
  const S = loadTs("lib/away/store.ts", {
    "@/lib/storage/user-store": userStore,
    "@/lib/settings/store": { getSettings: async () => ({ timezone: LONDON, ...settings }) },
    "@/lib/google/calendar": { getAbsenceSourceEvents: async () => { reads.google++; if (googleFails) throw new Error("Google down"); return events; } },
    "@/lib/today/types": {},
    "./fell-due": loadTs("lib/away/fell-due.ts", { "@/lib/actions/utils": loadTs("lib/actions/utils.ts"), "./calendar": C }),
    "./calendar": C,
  });
  return { S, files, reads };
}

test("absences told to Basil are validated, de-duplicated and can be ended early", async () => {
  const { S, files } = store();
  await assert.rejects(S.declareAway("michael", { start: "2026-11-13", end: "2026-11-03" }), /before the first day/);
  await assert.rejects(S.declareAway("michael", { start: "13/11/2026", end: "2026-11-20" }), /YYYY-MM-DD/);
  await S.declareAway("michael", { start: "2026-11-03", end: "2026-11-13", cover: "Guy" });
  await S.declareAway("michael", { start: "2026-11-03", end: "2026-11-13", cover: "Guy Saunders" });
  assert.equal(files.get("sage-away.json").declared.length, 1, "same dates replace, not stack");
  assert.equal(await S.endDeclaredAway("michael", "2026-11-10"), 1);
  assert.equal(files.get("sage-away.json").declared[0].end, "2026-11-09", "ends yesterday");
  const id = files.get("sage-away.json").declared[0].id;
  assert.equal(await S.removeDeclaredAway("michael", id), true);
});

test("the calendar is read at most hourly, and a failed read keeps the last good one", async () => {
  const ooo = { id: "x", eventType: "outOfOffice", start: { date: "2026-12-21" }, end: { date: "2026-12-24" } };
  const t = store({ events: [ooo], settings: { workingDays: [1, 2, 3, 4], holidayRegion: "scotland" } });
  const first = await t.S.getWorkCalendar("michael");
  assert.equal(t.reads.google, 1);
  same(first.away.map((p) => p.start), ["2026-12-21"]);
  same(first.workingDays, [1, 2, 3, 4]);
  assert.equal(first.holidayRegion, "scotland");
  await t.S.getWorkCalendar("michael");
  assert.equal(t.reads.google, 1, "cached within the hour");
  await t.S.getWorkCalendar("michael", { refresh: "never" });
  assert.equal(t.reads.google, 1);

  const down = store({ googleFails: true });
  down.files.set("sage-away.json", { declared: [], calendar: { periods: [{ id: "cal:k", start: "2026-11-03", end: "2026-11-13", source: "calendar" }], readAt: "2026-01-01T00:00:00Z" } });
  const kept = await down.S.getWorkCalendar("michael", { refresh: "always" });
  same(kept.away.map((p) => p.id), ["cal:k"], "an outage must not make a user on leave look back at work");
  assert.equal(kept.holidayRegion, "england-and-wales", "London default");
});

// ── The briefing ────────────────────────────────────────────────────────────

function cron({ calendar, calendarFails = false, disabled = false } = {}) {
  const calls = [];
  const R = loadTs("app/api/cron/generate-briefing/route.ts", {
    "next/server": nextServer,
    "@/lib/http/origin": { selfOrigin: () => "https://basil.test" },
    "@/lib/users": { getUsers: async () => [{ username: "michael", disabled }] },
    "@/lib/ai/spend-guard": { checkGlobalBudget: async () => ({ ok: true }) },
    "@/lib/billing/paywall": { hasFeature: async () => true },
    "@/lib/observability/capture": { captureCronFailures: async () => {} },
    "@/lib/briefing/delivery": { deliverBriefing: async () => ({ email: "sent", slack: "off" }) },
    "@/lib/away/store": { getWorkCalendar: async () => { if (calendarFails) throw new Error("store down"); return calendar; } },
    "@/lib/away/calendar": C,
    "@/lib/notify": { notifyUser: async () => ({ pushed: 1, emailed: false }) },
    "@/lib/notify/rules": loadTs("lib/notify/rules.ts", { "@/lib/actions/utils": loadTs("lib/actions/utils.ts", {}) }),
  }, { CRON_SECRET: "s" }, {
    fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ generatedAt: "now" }), { status: 200 }); },
  });
  return { run: () => R.GET(new Request("https://basil.test/api/cron/generate-briefing", { headers: { authorization: "Bearer s" } })), calls };
}

const today = () => C.dayIn(Date.now(), LONDON);

test("no briefing is written or emailed on a leave day or a day off; it is on a working day", async () => {
  const onLeave = cron({ calendar: cal({ workingDays: [0, 1, 2, 3, 4, 5, 6], away: [{ id: "basil:x", start: C.addDays(today(), -1), end: C.addDays(today(), 2), source: "basil" }] }) });
  const r1 = await onLeave.run();
  assert.equal(onLeave.calls.length, 0);
  assert.equal(r1.body.results.michael.skipped, "away");
  assert.equal(r1.body.ok, true, "a skipped day is not a failed run");

  const weekday = C.weekdayOf(today());
  const dayOff = cron({ calendar: cal({ workingDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday), holidayRegion: "none" }) });
  const r2 = await dayOff.run();
  assert.equal(dayOff.calls.length, 0);
  assert.equal(r2.body.results.michael.skipped, "weekend");

  const working = cron({ calendar: cal({ workingDays: [0, 1, 2, 3, 4, 5, 6], holidayRegion: "none" }) });
  await working.run();
  assert.equal(working.calls.length, 1);

  const unreadable = cron({ calendarFails: true });
  await unreadable.run();
  assert.equal(unreadable.calls.length, 1, "if the calendar cannot be read, brief as before");

  const disabled = cron({ calendar: cal({ workingDays: [0, 1, 2, 3, 4, 5, 6], holidayRegion: "none" }), disabled: true });
  const r3 = await disabled.run();
  assert.equal(disabled.calls.length, 0);
  assert.equal(r3.body.results.michael.skipped, "disabled");
});

test("the briefing reads back to the last working day, and the first day back is a catch-up", () => {
  const b = src("app/api/generate/briefing/route.ts");
  assert.match(b, /const gapDays = sinceDay \? Math\.min\(21, Math\.max\(2, daysBetween\(sinceDay, todayDate\)\)\) : 2;/);
  assert.match(b, /getRecentEmails\(username, gapDays > 2 \? Math\.min\(60, 10 \* gapDays\) : 20, gapDays\)/);
  assert.match(b, /## WELCOME BACK/);
  assert.match(b, /Commitments that fell due during the absence are not failures/);
  assert.match(b, /\$\{catchUpBlock\}/);
});

// ── Coming back ─────────────────────────────────────────────────────────────

test("on the first day back, one tap moves what fell due during the absence to a working day", () => {
  const F = loadTs("lib/away/fell-due.ts", { "@/lib/actions/utils": loadTs("lib/actions/utils.ts"), "./calendar": C });
  const actions = [
    { id: "due-in-leave", status: "open", owner: "Michael", dueDate: "2026-11-06" },
    { id: "stored-overdue", status: "overdue", owner: "Michael", dueDate: "2026-11-12" },
    { id: "before-leave", status: "open", owner: "Michael", dueDate: "2026-11-02" },
    { id: "today", status: "open", owner: "Michael", dueDate: "2026-11-16" },
    { id: "done", status: "done", owner: "Michael", dueDate: "2026-11-06" },
    { id: "someone-else", status: "open", owner: "Carter", dueDate: "2026-11-06" },
  ];
  const moved = F.fellDueWhileAway(actions, HONEYMOON, "2026-11-16", ["Michael Cook"]).map((a) => a.id);
  same(moved, ["due-in-leave", "stored-overdue"]);
  assert.equal(F.suggestedRedateDay("2026-11-16", cal({ away: [HONEYMOON] })), "2026-11-19", "the third working day, not a pile on the first");
  assert.equal(F.suggestedRedateDay("2026-12-23", cal()), "2026-12-30", "skips Christmas and the weekend");
  const route = src("app/api/away/redate/route.ts");
  assert.match(route, /if \(awayStatus\(today, cal\)\.state === "away"\)/);
  assert.match(route, /bulkUpdateActions\(username, due\.map/);
});

test("Ask Basil's out-of-office also tells Basil, and turning it off ends the absence", () => {
  const t = src("lib/ai/tools.ts");
  assert.match(t, /await declareAway\(username, \{ start, end, label: "Out of office", cover \}\)/);
  assert.match(t, /await endDeclaredAway\(username, dayIn\(Date\.now\(\), timezone\)\)/);
  assert.match(src("lib/ai/system-prompt.ts"), /Pass \\`cover\\` when the message names who is covering/);
});

test("an out-of-office block shows as time off: no Prep, no Cancel, and not free hours", () => {
  const m = src("app/dashboard/meetings/page.tsx");
  assert.match(m, /if \(isAbsenceEvent\(event\)\) return false;/);
  assert.match(m, /state !== "declined" && !isAbsenceEvent\(event\)/);
  // WeekLoad is a .tsx component the loadTs harness cannot run; check its rules.
  const w = src("app/dashboard/schedule/components/WeekLoad.tsx");
  assert.match(w, /isAbsenceEvent\(\{ \.\.\.e, attendeeCount: e\.attendees\?\.length \?\? 0 \}\) && coversDay\(e, iso\)/);
  assert.match(w, /meet, free: away \? 0 : quarter\(span - meet\)/);
  assert.match(w, /`\$\{full\(focus\)\}: away\.`/);
});
test("Today knows the day: the route adds away status on every request, never cached with the feed", () => {
  const r = src("app/api/today/route.ts");
  assert.match(r, /getTodayAway\(username\),/);
  assert.equal((r.match(/away, cache: "/g) ?? []).length, 3, "hit, stale and miss all carry it");
});

test("settings: working days and bank-holiday region are validated", async () => {
  const files = new Map();
  const S = loadTs("lib/settings/store.ts", {
    "@/lib/away/calendar": C,
    "@/lib/storage/user-store": {
      readUserStore: async (_u, f, fb) => files.get(f) ?? fb,
      writeUserStore: async (_u, f, d) => { files.set(f, d); },
      // patchSettings is a locked read-modify-write since the 2026-11-10 C2 fix.
      updateUserStore: async (_u, f, fn, fb) => { const next = fn(files.get(f) ?? fb); files.set(f, next); return next; },
    },
  });
  const out = await S.patchSettings("michael", { workingDays: [5, 1, 1, 2], holidayRegion: "scotland" });
  same(out.workingDays, [1, 2, 5]);
  assert.equal(out.holidayRegion, "scotland");
  await assert.rejects(S.patchSettings("michael", { workingDays: [] }), /at least one day/);
  await assert.rejects(S.patchSettings("michael", { workingDays: [7] }), /at least one day/);
  await assert.rejects(S.patchSettings("michael", { holidayRegion: "wales" }), /Invalid holidayRegion/);
});

// ── Admin: give someone their daily limit back ──────────────────────────────

test("an admin can reset one person's AI spend for today; the spend log is untouched", async () => {
  const counters = new Map([["spend:user:michael:day:2026-11-10", 2.9], ["spend:user:michael:2026-11", 18.4]]);
  const pricing = loadTs("lib/ai/pricing.ts", { "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 1, balanced: 1, default: 1, long: 1 } } });
  const G = loadTs("lib/ai/spend-guard.ts", {
    "./pricing": pricing,
    "@/lib/storage/counter": {
      incrCounter: async () => ({ value: 0 }), isDurableCounter: () => true,
      getCounter: async (k) => counters.get(k) ?? 0,
      resetCounter: async (k) => { counters.delete(k); },
    },
    "./spend-log": { currentPeriod: () => "2026-11", currentDay: () => "2026-11-10", secondsUntilPeriodEnd: () => 1, secondsUntilDayEnd: () => 1, appendSpendEvent: async () => {} },
    "@/lib/users": { findByUsername: async () => ({ username: "michael" }) },
  }, { AI_PER_USER_DAILY_USD: "3" });
  assert.equal((await G.getUserSpendToday("Michael")).usd, 2.9);
  const out = await G.resetUserSpendToday("Michael");
  same(out, { day: "2026-11-10", clearedUsd: 2.9 });
  assert.equal((await G.getUserSpendToday("michael")).usd, 0, "the full daily limit is back");
  assert.equal(counters.get("spend:user:michael:2026-11"), 18.4, "the month's total is untouched");
  const route = src("app/api/admin/ai-spend/route.ts");
  assert.match(route, /if \(!isAdminUser\(admin\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.match(src("app/admin/page.tsx"), /action: "reset-today", username: user\.username/);
});
