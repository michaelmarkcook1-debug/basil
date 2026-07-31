/**
 * tests/invitation-rsvp.test.mjs
 *
 * Accepting a meeting invitation on the calendar must silence the "Reply to
 * <organiser>" follow-up card.
 *
 * Production, 2026-07-30 — sitting in CRITICAL · ACT NOW at 94h waiting:
 *   "Reply to Malcolm Frank — Zoom meeting invitation - AnalystGenius -
 *    Ascendion demo"
 * for a meeting already accepted on the calendar. detectGmail's only
 * already-handled test was checkThreadForSentReply, and accepting an invite
 * sends nothing into the Gmail thread, so the card could never clear — it just
 * climbed the urgency ranking as it aged.
 *
 * Contract-lock (house pattern): the matching decision is reimplemented below.
 * If invitation-rsvp.ts changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const src = read("lib/followups/invitation-rsvp.ts");
const detect = read("lib/followups/detect.ts");

// ── Contract lock ────────────────────────────────────────────────────────────
const INVITATION = [
  /\bis inviting you to a scheduled zoom meeting\b/i,
  /\bzoom meeting invitation\b/i,
  /\bhas invited you to\b/i,
  /\byou(?:'ve| have| were)?\s+(?:been\s+)?invited\b/i,
  /^\s*invitation:\s/i,
  /^\s*updated invitation:\s/i,
  /\bgoogle calendar\b[\s\S]{0,40}\binvitation\b/i,
  /\baccepted:|\bdeclined:/i,
];
const BOILER = new Set(["analystgenius","talentgenius","demo","meeting","invite","invitation",
  "invited","inviting","scheduled","zoom","teams","google","calendar","topic","time","join",
  "with","for","from","the","and","your","this","that","eastern","july"]);
const toks = (t) => new Set((t||"").toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 4 && !BOILER.has(w) && !/^\d+$/.test(w)));
const evToks = (e) => {
  const out = toks(e.summary);
  for (const a of e.attendees ?? []) {
    for (const t of toks(a)) out.add(t);
    const at = a.indexOf("@");
    if (at > -1) {
      for (const t of toks(a.slice(0, at))) out.add(t);
      const d = a.slice(at + 1).split(".")[0];
      if (d && d.length >= 4 && !BOILER.has(d)) out.add(d);
    }
  }
  return out;
};
const shares = (a, b) => {
  for (const x of a) {
    if (b.has(x)) return true;
    if (x.length >= 5) for (const y of b) if (y.length >= 5 && (y.includes(x) || x.includes(y))) return true;
  }
  return false;
};
const ANSWERED = new Set(["accepted","declined","tentative"]);
const isInvite = (e) => INVITATION.some((p) => p.test(`${e.subject||""}\n${e.snippet||""}`));
const answeredBy = (email, events) => {
  if (!isInvite(email)) return null;
  const et = toks(`${email.subject||""} ${email.snippet||""} ${email.from||""}`);
  if (et.size === 0) return null;
  for (const ev of events) {
    if (!ANSWERED.has(ev.myResponseStatus ?? "needsAction")) continue;
    if (!shares(et, evToks(ev))) continue;
    return ev;
  }
  return null;
};

// The real email, verbatim from the production screenshot.
const REAL_EMAIL = {
  subject: "Zoom meeting invitation - AnalystGenius - Ascendion demo",
  snippet: "Malcolm Frank is inviting you to a scheduled Zoom meeting. Topic: AnalystGenius - Ascendion demo Time: Jul 30, 2026 01:00 PM Eastern",
  from: "Malcolm Frank",
};
const ACCEPTED_EVENT = {
  summary: "AnalystGenius - Ascendion demo",
  start: "2026-07-30T17:00:00.000Z",
  myResponseStatus: "accepted",
  attendees: ["Malcolm Frank <malcolm.frank@ascendion.com>"],
};

test("the real production card is suppressed once accepted", () => {
  const hit = answeredBy(REAL_EMAIL, [ACCEPTED_EVENT]);
  assert.ok(hit, "accepting the invite must clear 'Reply to Malcolm Frank'");
  assert.equal(hit.summary, "AnalystGenius - Ascendion demo");
});

test("an unanswered invite still asks for a reply", () => {
  const pending = { ...ACCEPTED_EVENT, myResponseStatus: "needsAction" };
  assert.equal(answeredBy(REAL_EMAIL, [pending]), null,
    "needsAction is NOT an answer — the user still has to respond");
});

test("declined and tentative both count as answered", () => {
  for (const s of ["declined", "tentative"]) {
    assert.ok(answeredBy(REAL_EMAIL, [{ ...ACCEPTED_EVENT, myResponseStatus: s }]),
      `${s} is an explicit response to the invitation`);
  }
});

test("a real request that merely mentions a meeting is NEVER suppressed", () => {
  const genuine = {
    subject: "Re: pricing",
    snippet: "Can we get a meeting in this week to go through the Ascendion numbers?",
    from: "Malcolm Frank",
  };
  assert.equal(answeredBy(genuine, [ACCEPTED_EVENT]), null,
    "suppressing a genuine ask would hide real work — the email must BE an invitation");
});

test("an unrelated accepted meeting does not silence an invitation", () => {
  const unrelated = {
    summary: "Dentist",
    start: "2026-07-30T09:00:00.000Z",
    myResponseStatus: "accepted",
    attendees: ["reception@dentist.example"],
  };
  assert.equal(answeredBy(REAL_EMAIL, [unrelated]), null,
    "a shared DISTINCTIVE token is required — date alone must never match");
});

test("generic words alone cannot match", () => {
  const generic = {
    summary: "AnalystGenius demo",           // every token is boilerplate
    start: "2026-07-30T17:00:00.000Z",
    myResponseStatus: "accepted",
    attendees: [],
  };
  const vague = { subject: "Zoom meeting invitation - demo", snippet: "You have been invited", from: "" };
  assert.equal(answeredBy(vague, [generic]), null,
    "'analystgenius'/'demo' are boilerplate — they cannot identify WHICH meeting");
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the detector consults calendar RSVP and degrades safely", () => {
  assert.ok(/findAnsweringCalendarEvent\(/.test(detect),
    "detectGmail must consult calendar RSVP state");
  assert.ok(/\[followups\] suppressed/.test(detect),
    "a suppression must be logged — a misfiring filter would silently hide real mail");
  const loader = detect.slice(detect.indexOf("async function loadRsvpEvents"));
  assert.ok(/catch/.test(loader) && /return \[\]/.test(loader),
    "an unavailable calendar must not take the follow-up list down, and must not suppress");
  assert.ok(/needsAction/.test(src),
    "needsAction must be explicitly excluded from the answered set");
});
