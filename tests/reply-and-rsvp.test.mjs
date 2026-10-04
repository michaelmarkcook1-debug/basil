/**
 * 2026-10-04: answer invitations (yes / maybe / no / propose a new time) and
 * reply to email from inside Basil. Nothing here talks to Google: Gmail and
 * Calendar are mocked, and every "send" is captured, never performed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const decode = (raw) => Buffer.from(raw, "base64url").toString("utf8");
const headersOf = (mime) => mime.split("\r\n\r\n")[0].split("\r\n");

// ── A fake Google: records what would have been sent ────────────────────────

function fakeGoogle({ message, event, selfEmail = "me@fixture.invalid" } = {}) {
  const sent = [], patched = [];
  const gmail = {
    users: {
      getProfile: async () => ({ data: { emailAddress: selfEmail } }),
      messages: {
        get: async () => ({ data: message }),
        send: async ({ requestBody }) => { sent.push(requestBody); return { data: { id: "sent-1", threadId: requestBody.threadId ?? "new-thread" } }; },
      },
      threads: { get: async () => ({ data: { messages: [] } }) },
    },
  };
  const calendar = {
    events: {
      get: async () => ({ data: structuredClone(event) }),
      patch: async (req) => { patched.push(req); return { data: {} }; },
    },
  };
  const googleapis = { google: { gmail: () => gmail, calendar: () => calendar } };
  const auth = { getAuthedClient: async () => ({}) };
  const gmailMod = loadTs("lib/google/gmail.ts", { googleapis, "./auth": auth });
  const calMod = loadTs("lib/google/calendar.ts", {
    googleapis, "./auth": auth, "./gmail": gmailMod,
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [selfEmail], names: [] }), stripSelf: (a) => a },
  });
  return { gmail: gmailMod, cal: calMod, sent, patched };
}

const header = (name, value) => ({ name, value });
const inbound = (over = {}) => ({
  id: "m1", threadId: "t1", internalDate: String(Date.parse("2026-10-01T09:00:00Z")), snippet: "Can you confirm?",
  payload: {
    mimeType: "text/plain",
    body: { data: Buffer.from("Can you confirm Thursday works?\nThanks, Jane").toString("base64url") },
    headers: [
      header("From", '"Jane Doe" <jane@partner.invalid>'),
      header("To", "me@fixture.invalid, omar@fixture.invalid"),
      header("Cc", '"Priya N" <priya@partner.invalid>, me@fixture.invalid'),
      header("Subject", "Thursday workshop"),
      header("Message-ID", "<abc123@partner.invalid>"),
      header("References", "<root1@partner.invalid>"),
      ...(over.extraHeaders ?? []),
    ],
  },
  ...over,
});

// ── Addresses and recipients ─────────────────────────────────────────────────

test("address lists: quoted commas, angle brackets and bare addresses", () => {
  const { gmail } = fakeGoogle();
  const got = gmail.parseAddressList('"Doe, Jane" <JANE@partner.invalid>, omar@fixture.invalid, <mailto:x@y.invalid>');
  assert.equal(JSON.stringify(got), JSON.stringify([
    { name: "Doe, Jane", email: "jane@partner.invalid" },
    { name: "", email: "omar@fixture.invalid" },
    { name: "", email: "x@y.invalid" },
  ]));
});

test("reply goes to the sender (or Reply-To); reply-all adds everyone else — never you", () => {
  const { gmail } = fakeGoogle();
  const me = ["me@fixture.invalid"];
  const a = (email, name = "") => ({ name, email });
  const base = { from: a("jane@partner.invalid", "Jane"), replyToHeader: [], to: [a("me@fixture.invalid"), a("omar@fixture.invalid")], cc: [a("priya@partner.invalid"), a("me@fixture.invalid")] };
  const r = gmail.replyRecipients(base, me);
  const emails = (xs) => xs.map((x) => x.email).join(",");
  assert.equal(emails(r.replyTo), "jane@partner.invalid");
  assert.equal(emails(r.replyAllCc), "omar@fixture.invalid,priya@partner.invalid");
  assert.equal(emails(gmail.replyRecipients({ ...base, replyToHeader: [a("desk@partner.invalid")] }, me).replyTo), "desk@partner.invalid");
  // Replying to your own sent message continues to the people you wrote to.
  const own = gmail.replyRecipients({ ...base, from: a("me@fixture.invalid") }, me);
  assert.equal(emails(own.replyTo), "omar@fixture.invalid");
});

// ── Threading ────────────────────────────────────────────────────────────────

test("a reply is sent IN the thread, with In-Reply-To/References, 'Re:' once, and the original quoted", async () => {
  const g = fakeGoogle({ message: inbound() });
  const out = await g.gmail.replyToEmail("u", "m1", "Thursday works — see you then.\nMichael");
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].threadId, "t1", "Gmail threadId keeps it in the conversation");
  const mime = decode(g.sent[0].raw);
  const h = headersOf(mime);
  assert.ok(h.includes("To: \"Jane Doe\" <jane@partner.invalid>"));
  assert.ok(!h.some((l) => l.startsWith("Cc:")), "plain reply has no Cc");
  assert.ok(h.includes("Subject: Re: Thursday workshop"));
  assert.ok(h.includes("In-Reply-To: <abc123@partner.invalid>"));
  assert.ok(h.includes("References: <root1@partner.invalid> <abc123@partner.invalid>"));
  assert.match(mime, /Thursday works — see you then\.\nMichael\n\nOn .*Jane Doe.* wrote:\n> Can you confirm Thursday works\?/);
  assert.equal(out.to.map((a) => a.email).join(","), "jane@partner.invalid");
});

test("reply-all copies everyone else on the message, not you", async () => {
  const g = fakeGoogle({ message: inbound() });
  await g.gmail.replyToEmail("u", "m1", "Yes", { replyAll: true });
  const cc = headersOf(decode(g.sent[0].raw)).find((l) => l.startsWith("Cc:"));
  assert.equal(cc, 'Cc: omar@fixture.invalid, "Priya N" <priya@partner.invalid>');
});

test("header injection through the subject is neutralised; non-ASCII subjects are encoded; 'Re:' is not doubled", async () => {
  const evil = inbound({ payload: { ...inbound().payload, headers: inbound().payload.headers.map((x) =>
    x.name === "Subject" ? header("Subject", "Re: Hi\r\nBcc: attacker@evil.invalid") : x) } });
  const g = fakeGoogle({ message: evil });
  await g.gmail.replyToEmail("u", "m1", "ok");
  const h = headersOf(decode(g.sent[0].raw));
  assert.ok(!h.some((l) => /^Bcc:/i.test(l)), "no injected Bcc header");
  assert.ok(h.some((l) => l === "Subject: Re: Hi Bcc: attacker@evil.invalid"));

  const intl = inbound({ payload: { ...inbound().payload, headers: inbound().payload.headers.map((x) =>
    x.name === "Subject" ? header("Subject", "Réunion — jeudi") : x) } });
  const g2 = fakeGoogle({ message: intl });
  await g2.gmail.replyToEmail("u", "m1", "ok");
  const subj = headersOf(decode(g2.sent[0].raw)).find((l) => l.startsWith("Subject:"));
  assert.match(subj, /^Subject: =\?UTF-8\?B\?.+\?=$/);
  assert.equal(Buffer.from(subj.match(/B\?(.+)\?=/)[1], "base64").toString("utf8"), "Re: Réunion — jeudi");
});

test("an empty reply is refused before anything is sent", async () => {
  const g = fakeGoogle({ message: inbound() });
  await assert.rejects(() => g.gmail.replyToEmail("u", "m1", "   "), /empty/);
  assert.equal(g.sent.length, 0);
});

// ── Invitations ──────────────────────────────────────────────────────────────

const invite = (over = {}) => ({
  id: "e1", summary: "Pipeline review",
  start: { dateTime: "2026-10-09T14:00:00+01:00", timeZone: "Europe/London" },
  end: { dateTime: "2026-10-09T14:30:00+01:00", timeZone: "Europe/London" },
  organizer: { email: "jane@partner.invalid", displayName: "Jane Doe" },
  attendees: [{ email: "jane@partner.invalid", organizer: true, responseStatus: "accepted" }, { email: "me@fixture.invalid", self: true, responseStatus: "needsAction" }],
  ...over,
});

test("answering an invitation notifies the organiser and can carry a note", async () => {
  const g = fakeGoogle({ event: invite() });
  await g.cal.respondToEvent("u", "e1", { response: "accepted", comment: "Looking forward\r\nto it" });
  assert.equal(g.patched.length, 1);
  assert.equal(g.patched[0].sendUpdates, "all", "the old route patched silently — an Outlook organiser never heard");
  const me = g.patched[0].requestBody.attendees.find((a) => a.self);
  assert.equal(me.responseStatus, "accepted");
  assert.equal(me.comment, "Looking forward to it");
  assert.equal(g.patched[0].requestBody.attendees.find((a) => a.organizer).responseStatus, "accepted", "others untouched");
});

test("not on the guest list is an error, not a silent success", async () => {
  const g = fakeGoogle({ event: invite({ attendees: [{ email: "team@partner.invalid", responseStatus: "needsAction" }] }) });
  await assert.rejects(() => g.cal.respondToEvent("u", "e1", { response: "declined" }), (e) => e instanceof g.cal.NotAnAttendeeError);
  assert.equal(g.patched.length, 0);
});

test("proposing a new time: Maybe on the invite with the proposal in the note, and an email to the organiser", async () => {
  const g = fakeGoogle({ event: invite() });
  const now = Date.parse("2026-10-04T09:00:00Z");
  const out = await g.cal.proposeNewTime("u", "e1", {
    start: "2026-10-10T15:00:00+01:00", end: "2026-10-10T15:30:00+01:00",
    note: "Clashes with a client call", senderName: "Fixture Owner", timeZone: "Europe/London", now,
  });
  const me = g.patched[0].requestBody.attendees.find((a) => a.self);
  assert.equal(me.responseStatus, "tentative");
  assert.equal(me.comment, "Proposed new time: Sat 10 Oct, 15:00–15:30 (London) — Clashes with a client call");
  assert.equal(out.emailedTo, "jane@partner.invalid");
  const mime = decode(g.sent[0].raw);
  assert.match(mime, /^To: jane@partner\.invalid/m);
  assert.match(mime, /Subject: New time for "Pipeline review"\?/);
  assert.match(mime, /Hi Jane,\n\nI can't make "Pipeline review" at Fri 9 Oct, 14:00–14:30 \(London\)\. Could we move it to Sat 10 Oct, 15:00–15:30 \(London\)\?\n\nClashes with a client call\n\nThanks,\nFixture/);
});

test("proposals are validated, and the organiser email is skipped when asked or when you organised it", async () => {
  const now = Date.parse("2026-10-04T09:00:00Z");
  const base = { senderName: "Fixture Owner", timeZone: "Europe/London", now };
  const g = fakeGoogle({ event: invite() });
  await assert.rejects(() => g.cal.proposeNewTime("u", "e1", { ...base, start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:30:00Z" }), /past/);
  await assert.rejects(() => g.cal.proposeNewTime("u", "e1", { ...base, start: "2026-10-10T10:30:00Z", end: "2026-10-10T10:00:00Z" }), /after the start/);
  assert.equal(g.patched.length, 0, "nothing changes on an invalid proposal");

  await g.cal.proposeNewTime("u", "e1", { ...base, start: "2026-10-10T10:00:00Z", end: "2026-10-10T10:30:00Z", emailOrganizer: false, response: "declined" });
  assert.equal(g.sent.length, 0);
  assert.equal(g.patched[0].requestBody.attendees.find((a) => a.self).responseStatus, "declined");

  const mine = fakeGoogle({ event: invite({ organizer: { email: "me@fixture.invalid", self: true } }) });
  await mine.cal.proposeNewTime("u", "e1", { ...base, start: "2026-10-10T10:00:00Z", end: "2026-10-10T10:30:00Z" });
  assert.equal(mine.sent.length, 0, "never email yourself");
});

// ── Routes ───────────────────────────────────────────────────────────────────

function rsvpRoute(respondToEvent) {
  return loadTs("app/api/calendar/[eventId]/rsvp/route.ts", {
    "next/server": nextServer,
    "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/google/calendar": { respondToEvent, NotAnAttendeeError: class NotAnAttendeeError extends Error {} },
    "@/lib/events/audit": { emitAuditEvent: async () => null },
  });
}
const req = (body) => ({ json: async () => body });
const params = (o) => ({ params: Promise.resolve(o) });

test("RSVP route: validates the answer, reports failures honestly", async () => {
  const ok = rsvpRoute(async () => ({ summary: "x", start: "" }));
  assert.equal((await ok.POST(req({ status: "maybe" }), params({ eventId: "e1" }))).status, 400);
  assert.equal((await ok.POST(req({ status: "tentative" }), params({ eventId: "e1" }))).status, 200);
  const broken = rsvpRoute(async () => { throw new Error("Google 500"); });
  assert.equal((await broken.POST(req({ status: "accepted" }), params({ eventId: "e1" }))).status, 502);
});

test("reply route: sends only with a body, and closes the action that asked for the reply", async () => {
  const sends = [], updates = [];
  const route = loadTs("app/api/email/[id]/reply/route.ts", {
    "next/server": nextServer,
    "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/google/gmail": {
      getReplyContext: async () => ({}),
      replyToEmail: async (_u, id, body, opts) => { sends.push({ id, body, opts }); return { id: "s", threadId: "t", to: [{ name: "Jane", email: "jane@partner.invalid" }], cc: [] }; },
    },
    "@/lib/actions/store": { updateAction: async (_u, id, patch) => { updates.push({ id, patch }); return {}; } },
    "@/lib/events/audit": { emitAuditEvent: async () => null },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }) },
  });
  assert.equal((await route.POST(req({ body: "  " }), params({ id: "m1" }))).status, 400);
  assert.equal(sends.length, 0);
  const res = await route.POST(req({ body: "Thursday works", replyAll: true, actionId: "a1" }), params({ id: "m1" }));
  assert.equal(res.status, 200);
  assert.equal(sends[0].opts.replyAll, true);
  assert.equal(JSON.stringify(updates), JSON.stringify([{ id: "a1", patch: { status: "done", archivedReason: "reply-sent" } }]));
});

// ── Ask Basil: always approved, never delegated ──────────────────────────────

test("chat tools that send are always approved and can never be delegated", () => {
  const tools = src("lib/ai/tools.ts");
  for (const name of ["replyToEmail", "respondToInvite"]) {
    const block = tools.slice(tools.indexOf(`    ${name}: tool({`), tools.indexOf("execute:", tools.indexOf(`    ${name}: tool({`)));
    assert.match(block, /needsApproval: true,/, `${name} must always ask`);
  }
  const ledger = src("lib/trust/ledger.ts");
  const reversible = ledger.slice(ledger.indexOf("REVERSIBLE_TOOLS"), ledger.indexOf("]);", ledger.indexOf("REVERSIBLE_TOOLS")));
  assert.doesNotMatch(reversible, /replyToEmail|respondToInvite|draftEmail/);
});

// ── Screens ──────────────────────────────────────────────────────────────────

test("every RSVP surface uses the shared controls, which check the server's answer", () => {
  const controls = src("components/calendar/rsvp-controls.tsx");
  assert.match(controls, /if \(!res\.ok\) throw new Error\(out\.error \|\| "Your response was not sent\."\)/);
  assert.match(controls, /\/propose`/);
  const dayView = src("app/dashboard/schedule/components/DayView.tsx");
  assert.match(dayView, /<RsvpControls/);
  assert.doesNotMatch(dayView, /fetch\(`\/api\/calendar\/\$\{detailEvent\.id\}\/rsvp`/, "the unchecked fetch is gone");
  assert.match(src("app/dashboard/meetings/page.tsx"), /<RsvpControls/);
  assert.match(src("app/dashboard/page.tsx"), /<InvitationsPanel \/>/);
});

test("Today's invitations panel lists only unanswered invitations from others that haven't ended", () => {
  const { needsAnswer } = loadTs("lib/calendar/invitations.ts");
  assert.match(src("components/today/invitations-panel.tsx"), /needsAnswer\(e\)/);
  const now = Date.parse("2026-10-04T09:00:00Z");
  const ev = (o) => ({ id: "x", summary: "s", start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", isOrganizer: false, myResponseStatus: "needsAction", ...o });
  assert.equal(needsAnswer(ev({}), now), true);
  assert.equal(needsAnswer(ev({ myResponseStatus: "accepted" }), now), false);
  assert.equal(needsAnswer(ev({ isOrganizer: true }), now), false);
  assert.equal(needsAnswer(ev({ end: "2026-10-03T10:00:00Z" }), now), false);
});

test("Reply appears on 'Awaiting your reply' (Today and Threads) and on email-based actions", () => {
  assert.match(src("components/today/panels.tsx"), /<ReplyButton messageId=\{gmailId\}/);
  assert.match(src("app/dashboard/threads/page.tsx"), /<ReplyButton/);
  assert.match(src("app/dashboard/actions/page.tsx"), /<ReplyButton messageId=\{action\.sourceRef\.slice\("gmail:"\.length\)\} actionId=\{action\.id\}/);
});
