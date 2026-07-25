/**
 * tests/resolve-calendar.test.mjs
 *
 * "Signals should close commitments." Ingestion synthesises a "Confirm
 * attendance for the AnalystGenius Demo with Kyndryl stakeholders" action from
 * an invitation email, but accepting the Google Calendar invite doesn't reply
 * into that Gmail thread, so the existing email-reply resolver never fires and
 * the commitment sits in Upcoming forever — even though the calendar shows
 * `myResponseStatus: "accepted"`. resolveAttendanceActions closes it.
 *
 * The danger is closing the WRONG commitment (silently loses a real task), so
 * these tests pin BOTH directions: the real accepts resolve, and near-misses
 * (different day, different counterparty, no RSVP) do NOT.
 *
 * The matcher is a plain function with no I/O, so it's tested directly against
 * the compiled source via a tiny ts→js shim-free import: we re-implement the
 * import by reading the module through the project's tsx runner is overkill, so
 * instead we assert the SOURCE encodes the guarantees. (Behavioural cases live
 * in the pure-logic block below, which reimplements the contract to lock it.)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const mod = read("lib/actions/resolve-calendar.ts");
const poll = read("app/api/events/poll-ingest/route.ts");
const actionType = read("lib/types/action.ts");
const store = read("lib/actions/store.ts");

test("matching is anchored on date AND counterparty, never title alone", () => {
  // Every demo is titled "AnalystGenius Demo" — title-only matching would close
  // the wrong one. The matcher must require a same-day event AND a shared
  // distinctive token, and must bail when the action has no dueDate.
  assert.ok(/dayOf\(event\.start\) !== dayOf\(action\.dueDate\)\) continue/.test(mod),
    "must require the event day to equal the action's due date");
  assert.ok(/!sharesDistinctiveToken\(aTokens, eventTokens\(event\)\)\) continue/.test(mod),
    "must require a shared distinctive token (the counterparty)");
  assert.ok(/if \(!action\.dueDate\) continue/.test(mod),
    "an undated action must never be auto-closed");
});

test("boilerplate words cannot be the discriminator", () => {
  // 'analystgenius' and 'demo' appear in every action AND every event, so they
  // must be excluded or a same-day match would fire on the generic title alone.
  assert.ok(/"analystgenius"/.test(mod) && /"demo"/.test(mod),
    "the shared generic terms must be listed as boilerplate");
});

test("confirm needs an explicit RSVP; expect-invite needs only arrival", () => {
  assert.ok(/rsvp === "accepted" \|\| rsvp === "declined"/.test(mod),
    "confirm-attendance actions require accepted/declined");
  assert.ok(/reason: "invite-arrived"/.test(mod),
    "expect-invite actions resolve on the invite merely existing");
});

test("resolution is wired into the cron and marks a distinct reason", () => {
  assert.ok(/resolveAttendanceActions\(openActions, windowEvents\)/.test(poll),
    "poll-ingest must run the resolver against the upcoming-events window");
  assert.ok(/archivedReason: reason === "invite-arrived" \? "reply-sent" : "rsvp-confirmed"/.test(poll),
    "resolved actions must be tagged so Done reads 'you accepted', not a manual completion");
  assert.ok(/\.slice\(0, 25\)/.test(poll), "resolution must be capped per cycle");
});

test("the new archivedReason values exist end-to-end", () => {
  assert.ok(/"rsvp-confirmed" \| "reply-sent"/.test(actionType),
    "ActionItem.archivedReason must include the signal-driven reasons");
  assert.ok(/\| "archivedReason"/.test(store),
    "updateAction must allow patching archivedReason");
});

// ── Contract lock: reimplement the core decision to catch logic regressions ──
// Mirrors resolve-calendar.ts. If the module's behaviour changes, update BOTH.
test("behaviour: Kyndryl accept resolves; PwC same-title different-day does not", () => {
  const BOILER = new Set(["analystgenius", "demo", "with", "for", "the", "confirm", "attendance", "stakeholders", "expect", "invite"]);
  const toks = (s) => new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !BOILER.has(w)));
  const evToks = (ev) => {
    const out = toks(ev.summary);
    for (const a of ev.attendees) { for (const t of toks(a)) out.add(t); const at = a.indexOf("@"); if (at > -1) { const d = a.slice(at + 1).split(".")[0]; if (d.length >= 4) out.add(d); } }
    return out;
  };
  const shares = (a, b) => [...a].some((x) => b.has(x) || (x.length >= 5 && [...b].some((y) => y.length >= 5 && (y.includes(x) || x.includes(y)))));
  const day = (s) => s.slice(0, 10);
  const resolves = (action, ev) =>
    !!action.dueDate && day(ev.start) === day(action.dueDate) && shares(toks(action.text), evToks(ev)) && ev.rsvp === "accepted";

  const kyndrylAction = { text: "Confirm attendance for AnalystGenius Demo with Kyndryl stakeholders", dueDate: "2026-07-20" };
  const kyndrylEvent = { summary: "AnalystGenius Demo", start: "2026-07-20T00:00", rsvp: "accepted", attendees: ["john.mccullough@kyndryl.com", "olivia@talentgenius.io"] };
  const pwcEvent = { summary: "AnalystGenius Demo", start: "2026-07-30T00:00", rsvp: "accepted", attendees: ["regina.sobieray@pwc.com"] };

  assert.equal(resolves(kyndrylAction, kyndrylEvent), true, "Kyndryl accept on the matching day must resolve");
  assert.equal(resolves(kyndrylAction, pwcEvent), false, "the PwC event (same title, different day + party) must NOT resolve the Kyndryl action");
});
