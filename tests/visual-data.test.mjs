/**
 * The data shaping behind the 2026-10-14 redesign's graphics. Each graphic
 * must show only what the stores and calendar say — these pin the rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const executive = { localDate: (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) };
const V = loadTs("lib/today/visual-data.ts", { "@/lib/today/executive": executive });
const A = loadTs("lib/contacts/activity-shape.ts");
const TZ = "Europe/London";
const ev = (id, s, e, extra = {}) => ({ id, summary: id, start: s, end: e, isAllDay: false, hasVideo: false, attendeeCount: 2, attendees: ["x"], isOrganizer: false, myResponseStatus: "accepted", attendeeDetails: [{ name: "Carter Hughes", email: "c@x.test" }], ...extra });

test("day ribbon: meetings, a declined ghost, and free stretches only inside working hours", () => {
  const now = new Date("2026-10-14T07:42:00Z"); // 08:42 London
  const blocks = V.buildBlocks([
    ev("standup", "2026-10-14T08:30:00Z", "2026-10-14T09:00:00Z"),
    ev("carter", "2026-10-14T10:00:00Z", "2026-10-14T10:45:00Z"),
    ev("malcolm", "2026-10-14T14:00:00Z", "2026-10-14T14:30:00Z", { myResponseStatus: "declined" }),
    ev("tomorrow", "2026-10-15T09:00:00Z", "2026-10-15T10:00:00Z"),
  ], now, TZ, 9, 18);
  const meetings = blocks.filter((b) => b.kind === "meeting").map((b) => b.id);
  assert.equal(meetings.join(","), "standup,carter", "only today's, and the declined one is not a meeting");
  assert.equal(blocks.find((b) => b.id === "malcolm").kind, "declined");
  const free = blocks.filter((b) => b.kind === "free").map((b) => b.time);
  // London is on BST: stand-up 09:30–10:00, Carter 11:00–11:45, declined 15:00.
  // Free: before the stand-up, between the two, and after Carter (the declined slot is free).
  assert.equal(free.join(" | "), "09:00 – 09:30 | 10:00 – 11:00 | 11:45 – 18:00");
  assert.ok(!blocks.some((b) => b.kind === "free" && b.start < 9), "nothing before the working day");
});

test("orbit tone: quiet after two weeks, cooler on a cooling or cool verdict, warmer when warming", () => {
  assert.equal(V.orbitTone(undefined, 20), "quiet");
  assert.equal(V.orbitTone(undefined, 1), "steady");
  assert.equal(V.orbitTone({ tone: "neutral", trend: "cooling" }, 1), "cooler");
  assert.equal(V.orbitTone({ tone: "strained", trend: "steady" }, 1), "cooler");
  assert.equal(V.orbitTone({ tone: "warm", trend: "warming" }, 1), "warmer");
});

test("orbit places the most recent closest, and never two people on the same spot", () => {
  assert.ok(V.radiusFor(0) < V.radiusFor(1) && V.radiusFor(1) < V.radiusFor(7) && V.radiusFor(7) < V.radiusFor(30));
  assert.equal(V.radiusFor(90), V.radiusFor(30), "capped at a month");
  const placed = V.placeOrbit([{ name: "A", days: 0.1, volume: 20, tone: "steady" }, { name: "B", days: 0.1, volume: 5, tone: "steady" }, { name: "C", days: 16, volume: 1, tone: "quiet" }]);
  const [a, b] = placed;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 30, "same recency, different angles");
  assert.ok(a.size > b.size, "more messages, bigger node");
});

test("name chips only wrap whole first names of people in the orbit", () => {
  const runs = V.splitByNames("Today turns on Carter. Carterville is not a person; Olivia waits.", ["Carter Hughes", "Olivia Park"]);
  assert.equal(runs.filter((r) => r.person).map((r) => r.person).join(","), "Carter Hughes,Olivia Park");
  assert.equal(runs.map((r) => r.text).join(""), "Today turns on Carter. Carterville is not a person; Olivia waits.", "text survives intact");
});

test("channel mix and weekly rhythm count the interactions the activity route already gathers", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const ints = [
    { source: "Email", date: "2026-10-13T09:00:00Z" },
    { source: "Slack (DM)", date: "2026-10-12T09:00:00Z" },
    { source: "Calendar", date: "2026-10-01T09:00:00Z" },
    { source: "Zoom", date: "2026-09-20T09:00:00Z" },
    { source: "Docs", date: "2026-08-01T09:00:00Z" },
  ];
  assert.deepEqual({ ...A.channelMix(ints) }, { email: 1, slack: 1, meetings: 2, other: 1 });
  // 1 and 2 days ago → this week; 13 days → two weeks ago; 24 days → three weeks ago; 74 days → dropped.
  assert.equal(A.weeklyCounts(ints, now).join(","), "0,1,0,1,2", "oldest first; this week last; older than 5 weeks dropped");
});

test("project sparkline buckets signals by day, oldest first", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const s = V.dailySignals([{ occurredAt: "2026-10-14T08:00:00Z" }, { occurredAt: "2026-10-13T08:00:00Z" }, { occurredAt: "2026-10-13T09:00:00Z" }, { occurredAt: "2026-09-01T00:00:00Z" }], now);
  assert.equal(s.length, 14);
  assert.equal(s[13], 1);
  assert.equal(s[12], 2);
  assert.equal(s.reduce((a, b) => a + b, 0), 3, "the old signal is outside the window");
});

test("next days skip weekends and count only meetings with other people inside working hours", () => {
  const now = new Date("2026-10-16T07:00:00Z"); // Friday
  const days = V.nextDaysLoad([
    ev("fri", "2026-10-16T09:00:00Z", "2026-10-16T11:00:00Z"),
    ev("solo", "2026-10-16T13:00:00Z", "2026-10-16T14:00:00Z", { attendeeCount: 0 }),
    ev("sat", "2026-10-17T09:00:00Z", "2026-10-17T10:00:00Z"),
  ], now, TZ, 9, 18, 3);
  assert.equal(days.map((d) => d.label).join(","), "Today,Mon,Tue");
  assert.equal(days[0].meet, 2);
  assert.equal(days[0].free, 7);
});

test("drift strip: log-scale positions and lanes that never overlap", () => {
  assert.equal(V.driftX(0), 0);
  assert.equal(Math.round(V.driftX(30)), 100);
  assert.ok(V.driftX(1) < V.driftX(3) && V.driftX(3) < V.driftX(7));
  const lanes = V.laneFor([20, 20, 20, 21, 60]);
  assert.equal(new Set(lanes.slice(0, 3)).size, 3, "three at the same x take three lanes");
  assert.equal(lanes[4], 0, "far away reuses the first lane");
  assert.equal(V.rampStep(0, 9), -1);
  assert.equal(V.rampStep(9, 9), 4);
});
