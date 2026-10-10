// Today's email cards, 2026-10-10. All three "Reply to …" cards needed nothing:
//   Carter Lusher — a Microsoft Bookings confirmation (subject = the meeting title)
//   Olivia        — "I'll take a look"           (the ball is in her court)
//   Simon         — "will keep you posted"       (an update)
// and every card opened Gmail. These tests replay those cases against the real
// detector, the needs-reply judge, the invite matcher, the reply MIME and the
// email cache that lets an email open inside Basil.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const zod = require("zod");
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

function memStore(initial = {}) {
  const files = structuredClone(initial);
  return {
    files,
    readUserStore: async (_u, f, fb) => structuredClone(files[f] ?? fb),
    updateUserStore: async (_u, f, mut, fb) => { files[f] = mut(structuredClone(files[f] ?? fb)); return files[f]; },
  };
}

// ── The needs-reply judge ────────────────────────────────────────────────────

function needsReply(store, generate) {
  return loadTs("lib/email/needs-reply.ts", {
    zod,
    "@/lib/storage/user-store": store,
    "@/lib/ai/generate": { generateTextSafe: generate ?? (async () => { throw new Error("no model in this test"); }) },
    "@/lib/ai/model-config": { getTextModel: () => "fast-model" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
  });
}

test("needs-reply: judges each email once, reuses the verdict, and fails open", async () => {
  const store = memStore({ "email-reply-judgments.json": { old: { needsReply: false, reason: "thanks only", at: "2026-10-01T00:00:00Z" } } });
  const judged = [];
  const judge = async (_first, batch) => {
    judged.push(...batch.map((c) => c.id));
    return new Map([["olivia", { needsReply: false, reason: "acknowledgement" }], ["ask", { needsReply: true, reason: "asks a question" }]]);
    // "silent" gets no verdict → must stay (fail open)
  };
  const M = needsReply(store);
  const cands = ["old", "olivia", "ask", "silent"].map((id) => ({ id, from: "x", subject: "s", text: "t" }));
  const noReply = await M.filterNoReplyNeeded("u", "Michael", cands, judge);
  assert.equal([...noReply.keys()].sort().join(","), "old,olivia");
  assert.equal(judged.sort().join(","), "ask,olivia,silent", "a stored verdict is never re-judged");
  const stored = store.files["email-reply-judgments.json"];
  assert.equal(stored.olivia.needsReply, false);
  assert.equal(stored.silent, undefined, "no verdict, nothing stored — it is asked again next time");

  // Second pass: nothing new to judge.
  judged.length = 0;
  await M.filterNoReplyNeeded("u", "Michael", cands.slice(0, 3), judge);
  assert.equal(judged.length, 0);
});

test("needs-reply: the model judge parses verdicts and keeps every card when the model fails", async () => {
  const ok = needsReply(memStore(), async () => ({ text: '[{"id":"a","needsReply":false,"reason":"FYI"},{"id":"zzz","needsReply":false}]' }));
  const v = await ok.makeModelReplyJudge("u")("Michael", [{ id: "a", from: "x", subject: "s", text: "t" }]);
  assert.equal(v.get("a").needsReply, false);
  assert.equal(v.has("zzz"), false, "verdicts for ids it was not asked about are ignored");
  const broken = needsReply(memStore(), async () => { throw new Error("model down"); });
  assert.equal((await broken.makeModelReplyJudge("u")("Michael", [{ id: "a", from: "x", subject: "s", text: "t" }])).size, 0);
  const prompt = ok.needsReplyPrompt("Michael", [{ id: "m1", from: "Olivia", subject: "Re: mandate", text: "I'll take a look" }]);
  assert.match(prompt, /\[m1\] From: Olivia/);
  assert.match(prompt, /I'll take a look/);
});

// ── The detector, on today's real cards ──────────────────────────────────────

function detector({ inbox, events = [], noReplyIds = [] }) {
  return loadTs("lib/followups/detect.ts", {
    "@/lib/google/gmail": {
      getRecentEmails: async () => structuredClone(inbox),
      getGmailAddress: async () => "michael@fixture.invalid",
      getThreadState: async () => ({ later: [] }),
    },
    "@/lib/email/known-senders": { loadKnownSenders: async () => ({ isKnown: () => false }) },
    "@/lib/google/calendar": { getEventsForDateRange: async () => structuredClone(events) },
    "@/lib/followups/invitation-rsvp": loadTs("lib/followups/invitation-rsvp.ts"),
    "@/lib/slack/client": { getSlackUserClientForUser: async () => null, isSlackConnected: async () => false },
    "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: ["michael@fixture.invalid"], names: ["Michael Cook"] }), isSelf: () => false },
    "@/lib/email/needs-reply": {
      filterNoReplyNeeded: async (_u, _first, cands) =>
        new Map(cands.filter((c) => noReplyIds.includes(c.id)).map((c) => [c.id, { needsReply: false, reason: "test" }])),
    },
    "@/lib/email/view-cache": loadTs("lib/email/view-cache.ts", {
      "@/lib/storage/user-store": memStore(), "@/lib/google/gmail": { getReplyContext: async () => ({}) },
    }),
  });
}
const mail = (o) => ({ threadId: o.id, to: "michael@fixture.invalid", date: ago(3), labels: ["INBOX"], bulk: false, ...o });

const CARTER = mail({ id: "carter", from: "Carter Lusher", fromEmail: "carter@lusher.invalid",
  subject: "MICHAEL COOK - 2. Research interview with Lusher Advisory",
  snippet: "This meeting was scheduled from the bookings page of Carter Lusher. Use the following link to reschedule or cancel this meeting: Manage meet" });
const OLIVIA = mail({ id: "olivia", from: "Olivia Bond-Keith", fromEmail: "olivia@fixture.invalid",
  subject: "Re: Fw: Ai delivery mandate", snippet: "I&#39;ll take a look On Tue, Oct 6, 2026 at 7:47 AM Michael Cook wrote: Hi Olivia" });
const ASK = mail({ id: "ask", from: "Priya N", fromEmail: "priya@partner.invalid", subject: "Pricing", snippet: "Michael, can you confirm the pricing by Friday?" });

test("today's cards: the booking confirmation and the acknowledgement are gone, the real ask stays", async () => {
  const D = detector({ inbox: [CARTER, OLIVIA, ASK], noReplyIds: ["olivia"] });
  const res = await D.detectPendingFollowups("u", { staleHours: 24 });
  assert.equal(res.items.map((i) => i.id).join(","), "gmail:ask");
  assert.doesNotMatch(res.items[0].href, /mail\.google\.com/, "opens inside Basil, never Gmail");
  assert.match(res.items[0].href, /^\/dashboard\/threads\?open=gmail%3Aask$/);
});

test("previews are readable text — no &#39; on a card", async () => {
  const D = detector({ inbox: [OLIVIA] });
  const res = await D.detectPendingFollowups("u", { staleHours: 24 });
  assert.match(res.items[0].preview, /^I'll take a look/);
});

test("isBookingConfirmation: Bookings/Calendly confirmations, never a person asking for a meeting", () => {
  const D = detector({ inbox: [] });
  assert.equal(D.isBookingConfirmation(CARTER.snippet), true);
  assert.equal(D.isBookingConfirmation("A new event has been scheduled. Event type: 30 min"), true);
  assert.equal(D.isBookingConfirmation("Your appointment has been confirmed for Tuesday"), true);
  assert.equal(D.isBookingConfirmation("Can we schedule a meeting next week to go through the deck?"), false);
  assert.equal(D.isBookingConfirmation("Could you reschedule our call?"), false);
});

// ── Invites whose subject is just the meeting title ──────────────────────────

test("an email whose subject IS an answered meeting's title is that meeting's invite", () => {
  const R = loadTs("lib/followups/invitation-rsvp.ts");
  const ev = (o) => ({ summary: "MICHAEL COOK - 2. Research interview with Lusher Advisory", start: ago(-2), attendees: [], myResponseStatus: "accepted", ...o });
  const email = { subject: "MICHAEL COOK - 2. Research interview with Lusher Advisory", snippet: "See you then", from: "Carter Lusher" };
  assert.ok(R.findAnsweringCalendarEvent(email, [ev({})]), "accepted → answered");
  assert.equal(R.findAnsweringCalendarEvent(email, [ev({ myResponseStatus: "needsAction" })]), null, "not answered yet → still shows");
  assert.equal(R.findAnsweringCalendarEvent({ ...email, subject: `RE: ${email.subject}` }, [ev({})]), null,
    "a reply thread about the meeting is people talking — it stays");
  assert.equal(R.findAnsweringCalendarEvent({ subject: "Catch-up", snippet: "can you send the notes?" }, [ev({ summary: "Catch-up" })]), null,
    "a generic title never hides mail");
});

// ── Reply with your own To / Cc / Bcc ────────────────────────────────────────

test("buildReplyMime: edited recipients replace the defaults, and Bcc rides in the header", () => {
  const G = loadTs("lib/google/gmail.ts", { googleapis: { google: {} }, "./auth": {} });
  const ctx = {
    messageId: "m", threadId: "t", subject: "Pricing", date: "2026-10-09T10:00:00Z",
    from: { name: "Priya", email: "priya@partner.invalid" }, to: [], cc: [],
    replyTo: [{ name: "Priya", email: "priya@partner.invalid" }], replyAllCc: [{ name: "", email: "sam@partner.invalid" }],
    rfcMessageId: "<a@b>", references: "", body: "Can you confirm?", selfEmails: [],
  };
  const out = G.buildReplyMime(ctx, "Confirmed", { cc: [{ name: "Ann", email: "ann@x.invalid" }], bcc: [{ name: "", email: "boss@x.invalid" }] });
  const raw = Buffer.from(out.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: "Priya" <priya@partner\.invalid>\r$/m);
  assert.match(raw, /^Cc: "Ann" <ann@x\.invalid>\r$/m);
  assert.match(raw, /^Bcc: boss@x\.invalid\r$/m);
  assert.match(raw, /^In-Reply-To: <a@b>\r$/m, "still threads as a reply");
  assert.equal(out.bcc[0].email, "boss@x.invalid");
  const plain = Buffer.from(G.buildReplyMime(ctx, "Thanks").raw, "base64url").toString("utf8");
  assert.doesNotMatch(plain, /^(Cc|Bcc):/m, "untouched: no copies");
  assert.throws(() => G.buildReplyMime(ctx, "x", { to: [] }), /No one to reply to/);
});

// ── The email cache that makes opening instant ───────────────────────────────

test("view cache: serves a warm email without Gmail, flattens HTML, expires and caps", async () => {
  const store = memStore();
  let gmailCalls = 0;
  const V = loadTs("lib/email/view-cache.ts", {
    "@/lib/storage/user-store": store,
    "@/lib/google/gmail": {
      getReplyContext: async (_u, id) => {
        gmailCalls++;
        return { subject: `S ${id}`, date: "2026-10-09T10:00:00Z", from: { name: "A", email: "a@x.invalid" }, to: [], cc: [],
          replyTo: [], replyAllCc: [], body: "<html><body><p>Hi Michael,</p><p>Can we talk&nbsp;Friday?<br>Thanks</p><style>p{}</style></body></html>" };
      },
    },
  });
  assert.equal(await V.warmEmailViews("u", ["m1", "m2", "m1"]), 2);
  assert.equal(gmailCalls, 2);
  const view = await V.loadEmailView("u", "m1");
  assert.equal(gmailCalls, 2, "warm → no Gmail call on open");
  assert.equal(view.body, "Hi Michael,\nCan we talk Friday?\nThanks");
  await V.loadEmailView("u", "m1", { fresh: true });
  assert.equal(gmailCalls, 3, "?fresh=1 goes back to Gmail");

  const now = Date.parse("2026-10-10T00:00:00Z");
  const entry = (id, daysOld) => ({ id, cachedAt: new Date(now - daysOld * DAY).toISOString() });
  const pruned = V.pruneCache(Object.fromEntries([entry("fresh", 1), entry("stale", 8)].map((e) => [e.id, e])), now);
  assert.deepEqual(Object.keys(pruned), ["fresh"]);
  const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => entry(`m${i}`, i / 100)).map((e) => [e.id, e]));
  assert.equal(Object.keys(V.pruneCache(many, now)).length, 60);
});
