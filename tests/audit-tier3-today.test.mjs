/**
 * Tier-3 fixes from the 2026-09-15 audit — the Today dashboard.
 *
 * #11 a failed feed must not read as "Nothing outstanding"
 * #12 clear time is measured against everything booked, not the previous event
 * #13 "today" is the user's day, not UTC's
 * #14 headline counts come from the full feed, not the capped one
 * #15 a connected source whose read failed is degraded, not "reporting"
 * #16 every link on the dashboard resolves to a page that exists
 *
 * lib/today/executive.ts has no runtime imports; lib/today/feed.ts runs with
 * every integration mocked. Both are the real modules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Values built inside the loader's sandbox carry the sandbox's prototypes, and
 * strict deepEqual compares prototypes. structuredClone re-materialises them
 * in this realm — contents only, which is what the assertion is about.
 */
const plain = (v) => structuredClone(v);
const X = loadTs("lib/today/executive.ts");
const ev = (id, start, end, extra = {}) => ({ id, summary: id, start, end, isAllDay: false, attendeeCount: 0, attendees: [], hasVideo: false, isOrganizer: true, myResponseStatus: "accepted", ...extra });
const NOON = new Date("2026-09-15T12:00:00Z");
const READY_EMPTY = { items: [], total: 0, totals: { changes: 0, followups: 0, linear: 0 }, truncated: false, generatedAt: NOON.toISOString(), sources: { changes: true, followups: { gmail: true, slack: true }, linear: true }, degraded: [] };

// ── #11 ──────────────────────────────────────────────────────────────────────

test("#11 a failed feed marks every feed-derived tile unavailable — never a zero", () => {
  const stats = X.buildStatRow(undefined, "failed", X.buildDayShape([], NOON, "Europe/London"), null, true);
  for (const key of ["act", "reply", "quiet"]) {
    const s = stats.find((t) => t.key === key);
    assert.ok(s.unavailable, `${key} must carry a reason, got count=${s.count}`);
    assert.ok(!s.pending);
  }
});

test("#11 a loading feed is pending — not a zero, not a failure", () => {
  const stats = X.buildStatRow(undefined, "loading", X.buildDayShape([], NOON, "Europe/London"), null, true);
  const act = stats.find((t) => t.key === "act");
  assert.equal(act.pending, true);
  assert.equal(act.unavailable, undefined);
});

test("#11 zero is reserved for a feed that answered and was empty", () => {
  const stats = X.buildStatRow(READY_EMPTY, "ready", X.buildDayShape([], NOON, "Europe/London"), null, true);
  const act = stats.find((t) => t.key === "act");
  assert.equal(act.count, 0);
  assert.equal(act.unavailable, undefined);
  assert.ok(!act.pending);
});

// ── #12 ──────────────────────────────────────────────────────────────────────

test("#12 meetings inside a longer meeting create no clear time", () => {
  const day = X.buildDayShape([
    ev("long",   "2026-09-15T09:00:00+01:00", "2026-09-15T12:00:00+01:00"),
    ev("nested", "2026-09-15T10:00:00+01:00", "2026-09-15T10:30:00+01:00"),
    ev("later",  "2026-09-15T11:00:00+01:00", "2026-09-15T11:30:00+01:00"),
  ], NOON, "Europe/London");
  assert.equal(day.gapMinutes, 0, "the audit's false 10:30–11:00 gap");
  assert.equal(day.segments.filter((s) => s.kind === "gap").length, 0);
  assert.equal(day.meetingMinutes, 180, "booked time is the union, not the sum (which would be 240)");
  assert.equal(day.lastEnd, "2026-09-15T12:00:00+01:00", "the day ends when the LAST booking ends");
  assert.equal(day.backToBackRuns, 0, "a nested meeting is not a transition");
});

test("#12 a real gap and a real back-to-back are still both detected", () => {
  const day = X.buildDayShape([
    ev("a", "2026-09-15T09:00:00+01:00", "2026-09-15T10:00:00+01:00"),
    ev("b", "2026-09-15T10:00:00+01:00", "2026-09-15T10:30:00+01:00"),
    ev("c", "2026-09-15T11:00:00+01:00", "2026-09-15T11:30:00+01:00"),
  ], NOON, "Europe/London");
  assert.equal(day.gapMinutes, 30);
  assert.equal(day.longestGapMinutes, 30);
  assert.equal(day.backToBackRuns, 1);
  assert.deepEqual(plain(day.segments.filter((s) => s.kind === "gap").map((s) => [s.start, s.end])),
    [["2026-09-15T10:30:00+01:00", "2026-09-15T11:00:00+01:00"]]);
});

// ── #13 ──────────────────────────────────────────────────────────────────────

test("#13 at 00:30 BST on the 16th, the 16th's meetings and due-today commitments are today", () => {
  const midnight = new Date("2026-09-15T23:30:00Z"); // 00:30 in London
  const day = X.buildDayShape([ev("m", "2026-09-16T09:00:00+01:00", "2026-09-16T10:00:00+01:00")], midnight, "Europe/London");
  assert.equal(day.meetingCount, 1);
  const b = X.bucketCommitments([{ id: "due", text: "Due on the 16th", status: "open", dueDate: "2026-09-16" }], midnight, "Europe/London");
  assert.equal(b.today.length, 1);
  assert.equal(b.next7.length, 0);
});

test("#13 the same instant is still the 15th in New York — and the 16th's meeting is not today there", () => {
  const instant = new Date("2026-09-16T03:30:00Z"); // 23:30 on the 15th in New York
  assert.equal(X.localDate(instant, "America/New_York"), "2026-09-15");
  assert.equal(X.localDate(instant, "Europe/London"), "2026-09-16");
  const day = X.buildDayShape([ev("m", "2026-09-16T09:00:00-04:00", "2026-09-16T10:00:00-04:00")], instant, "America/New_York");
  assert.equal(day.meetingCount, 0);
});

test("#13 an all-day event's bare date is its local date in every zone", () => {
  const instant = new Date("2026-09-16T03:30:00Z");
  const day = X.buildDayShape([ev("holiday", "2026-09-15", "2026-09-16", { isAllDay: true })], instant, "America/New_York");
  assert.equal(day.allDay.length, 1);
});

// ── #14 / #15 — the feed itself ─────────────────────────────────────────────

function feedModule({ linearOn = false, linearThrows = false, followups = 0 } = {}) {
  const fixtures = Array.from({ length: followups }, (_, i) => ({
    id: `followup-${i}`, source: "gmail", fromName: `Sender ${i}`, subject: "Fixture", hoursWaiting: 80,
    lastInboundAt: new Date().toISOString(), href: `https://example.test/${i}`,
  }));
  return loadTs("lib/today/feed.ts", {
    "@/lib/delta/compute": { computeDeltas: () => ({ changes: [] }) },
    "@/lib/delta/types": { SEVERITY_WEIGHT: { critical: 1, high: 0.7, medium: 0.4 }, CATEGORY_CONFIG: { urgency: { weight: 1 } } },
    "@/lib/delta/store": { getSinceDate: async () => new Date().toISOString() },
    "@/lib/actions/store": { listActions: async () => [] },
    "@/lib/decisions/store": { listDecisions: async () => [] },
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/contacts/overrides-store": { getAllOverridesFromStore: async () => ({}) },
    "@/lib/linear/client": {
      isLinearConnected: async () => linearOn,
      getMyOpenIssues: async () => { if (linearThrows) throw new Error("synthetic Linear outage"); return []; },
    },
    "@/lib/followups/detect": { detectPendingFollowups: async () => ({ items: fixtures, sources: { gmail: true, slack: true } }) },
    "@/lib/learning/store": { getLearning: async () => ({}) },
    "@/lib/settings/store": { getSettings: async () => ({ timezone: "Europe/London" }) },
    "@/lib/learning/priors": { computeCategoryPriors: () => ({}) },
  });
}

test("#14 twenty pending follow-ups: the display is capped at six, the count is twenty", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const F = feedModule({ followups: 20 });
    const full = await F.computeTodayFeed("fixture");
    assert.equal(full.total, 20);
    assert.equal(full.totals.followups, 20);

    const shown = F.presentFeed(full);
    assert.equal(shown.items.length, 6, "panel cap");
    assert.equal(shown.total, 20, "the headline number is what there IS");
    assert.equal(shown.truncated, true);

    const everything = F.presentFeed(full, { full: true });
    assert.equal(everything.items.length, 20);
    assert.equal(everything.truncated, false);
  } finally { console.warn = quiet; }
});

test("#14 the headline tile counts the full queue, not the six displayed", () => {
  const feed = { ...READY_EMPTY, items: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, kind: "followup", rank: 1, lane: "needs-you", title: "t", subtitle: "s", occurredAt: NOON.toISOString(), followup: {} })), total: 20, totals: { changes: 0, followups: 20, linear: 0 }, truncated: true };
  const reply = X.buildStatRow(feed, "ready", X.buildDayShape([], NOON, "Europe/London"), null, true).find((t) => t.key === "reply");
  assert.equal(reply.count, 20);
});

test("#14 a response cached before totals existed still presents sanely", () => {
  const F = feedModule();
  const old = { items: [{ id: "a", kind: "followup", rank: 1, lane: "needs-you", title: "t", subtitle: "s", occurredAt: NOON.toISOString() }], total: 1, generatedAt: NOON.toISOString(), sources: READY_EMPTY.sources };
  const shown = F.presentFeed(old);
  assert.deepEqual(plain(shown.totals), { changes: 0, followups: 1, linear: 0 });
  assert.equal(shown.truncated, false);
  assert.deepEqual(plain(shown.degraded), []);
});

test("#15 a connected Linear whose read fails is degraded — and still connected", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const feed = await feedModule({ linearOn: true, linearThrows: true }).computeTodayFeed("fixture");
    assert.equal(feed.sources.linear, true, "it IS connected");
    assert.deepEqual(plain(feed.degraded), ["Linear"], "but it did not answer");
    assert.equal(feed.items.length, 0);
  } finally { console.warn = quiet; }
});

test("#15 nothing may claim every source is reporting while one is degraded", () => {
  assert.match(X.emptyBoardMessage([], ["Linear"]), /Linear could not be read/);
  assert.doesNotMatch(X.emptyBoardMessage([], ["Linear"]), /Every connected source/);
  assert.equal(X.emptyBoardMessage([], []), "Every connected source is reporting.");
  const board = X.buildPriorityBoard([]);
  const read = X.operationalRead(board, X.buildDayShape([], NOON, "Europe/London"), [], true, ["Linear"]);
  assert.match(read.shape, /Linear could not be read/);
});

// ── #16 ──────────────────────────────────────────────────────────────────────

test("#16 every tile on the stat row links to a page that exists", () => {
  const stats = X.buildStatRow(READY_EMPTY, "ready", X.buildDayShape([], NOON, "Europe/London"), null, true);
  for (const s of stats) {
    const route = s.href.replace(/\?.*$/, "");
    assert.ok(existsSync(path.join(ROOT, "app", route, "page.tsx")), `${s.key} → ${s.href} has no page`);
  }
});

test("#16 the threads queue exists and the retired signals page is no longer linked from Today", () => {
  assert.ok(existsSync(path.join(ROOT, "app/dashboard/threads/page.tsx")));
  const page = readFileSync(path.join(ROOT, "app/dashboard/page.tsx"), "utf8");
  assert.ok(!/\/dashboard\/signals/.test(page), "the signals CTA redirected straight back to Today");
});
