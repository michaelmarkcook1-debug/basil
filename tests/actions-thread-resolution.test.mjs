/**
 * 2026-09-26: Basil kept asking for replies to marketing mail and never noticed
 * when someone else in a thread had answered. 362 actions were open, 277 of
 * them untouched for 90+ days; "Register for BPESA…", "Leave a review for OP
 * Labs…" came from list mail; July "Provide decision requested by…" Slack items
 * never closed.
 *
 * Real modules, Gmail/Slack/model mocked. Synthetic people and domains only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const zod = require("zod");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// ── Bulk mail is recognised by its headers and Gmail's tabs ─────────────────

const gmail = loadTs("lib/google/gmail.ts", { googleapis: { google: {} }, "./auth": { getAuthedClient: async () => null } });
const hdr = (h) => (n) => h[n] ?? "";

test("bulk mail: List-Unsubscribe, List-Id, Precedence and Auto-Submitted mark it; a person's email does not", () => {
  assert.equal(gmail.isBulkMail(hdr({ "List-Unsubscribe": "<mailto:u@x.invalid>" })), true);
  assert.equal(gmail.isBulkMail(hdr({ "List-Id": "events.example.invalid" })), true);
  assert.equal(gmail.isBulkMail(hdr({ Precedence: "bulk" })), true);
  assert.equal(gmail.isBulkMail(hdr({ "Auto-Submitted": "auto-generated" })), true);
  assert.equal(gmail.isBulkMail(hdr({ "Auto-Submitted": "no" })), false);
  assert.equal(gmail.isBulkMail(hdr({ From: "Jane <jane@partner.invalid>" })), false);
});

const triage = loadTs("lib/email/triage.ts").triageEmail;
const email = (over) => ({ from: "Events | Summit", fromEmail: "events@summit.invalid", subject: "Join us in Cape Town", snippet: "Register now", ...over });

test("triage drops list and promotional mail from strangers, keeps it from known correspondents", () => {
  assert.deepEqual({ ...triage(email({ bulk: true })) }, { lowValue: true, reason: "bulk-headers" });
  assert.equal(triage(email({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] })).reason, "gmail-promotions");
  assert.equal(triage(email({ labels: ["CATEGORY_SOCIAL"] })).reason, "gmail-social");
  assert.equal(triage(email({ bulk: true, knownSender: true })).lowValue, false, "a colleague's list post still counts");
  assert.equal(triage(email({ from: "Jane Doe", fromEmail: "jane@partner.invalid", subject: "Contract", snippet: "Can you sign?" })).lowValue, false);
});

const { knownSendersFrom } = loadTs("lib/email/known-senders.ts", {
  "@/lib/contacts/user-store": { listUserContacts: async () => [] }, "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
});

test("known senders: own domain and work contacts' domains; personal contacts by exact address; never a free-mail domain", () => {
  const k = knownSendersFrom(["me@fixture.invalid"], [
    { email: "ceo@partnerco.invalid", directory: "work" },
    { email: "friend@gmail.com", directory: "personal" },
    { email: "colleague@gmail.com", directory: "work" },
  ]);
  assert.ok(k.isKnown("anyone@fixture.invalid"));
  assert.ok(k.isKnown("list@partnerco.invalid"));
  assert.ok(k.isKnown("FRIEND@gmail.com"));
  assert.ok(!k.isKnown("stranger@gmail.com"), "a contact at gmail.com must not vouch for all of gmail.com");
  assert.ok(!k.isKnown("events@summit.invalid"));
});

test("both ingest paths pass headers, labels and known-sender status to triage", () => {
  for (const f of ["app/api/events/poll-ingest/route.ts", "app/api/webhooks/gmail/route.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.match(src, /knownSender:/, `${f} must tell triage who is known`);
    assert.match(src, /bulk:/, `${f} must pass the bulk flag`);
  }
});

// ── Untouched auto-extracted actions are archived ───────────────────────────

const utils = loadTs("lib/actions/utils.ts");
const action = (over) => ({ id: "a", text: "Respond to Jane", status: "open", source: "email", createdAt: ago(45), updatedAt: ago(1), ...over });

test("untouched for 30 days: auto-extracted items archive; manual, dated-ahead and recently touched ones stay", () => {
  assert.equal(utils.isUntouchedStale(action()), true);
  assert.equal(utils.isUntouchedStale(action({ source: "meeting" })), true);
  assert.equal(utils.isUntouchedStale(action({ source: "manual" })), false);
  assert.equal(utils.isUntouchedStale(action({ source: "linear" })), false);
  assert.equal(utils.isUntouchedStale(action({ dueDate: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) })), false);
  assert.equal(utils.isUntouchedStale(action({ lastActivityAt: ago(3) })), false);
  assert.equal(utils.isUntouchedStale(action({ createdAt: ago(10) })), false);
  assert.equal(utils.isUntouchedStale(action({ status: "done" })), false);
});

function actionStore(seed) {
  let file = structuredClone(seed); const writes = [];
  const store = loadTs("lib/actions/store.ts", {
    "@/lib/events/lock": makeLock(),
    "@/lib/storage/user-store": { readUserStore: async () => structuredClone(file), writeUserStore: async (_u, _f, v) => { file = structuredClone(v); writes.push(v); } },
    "./classify": { classifyAction: () => "admin" },
    "./utils": utils,
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
    "@/lib/security/sensitive": { redactSensitive: (s) => ({ text: s }) },
  });
  return { store, get: () => file, writes };
}

test("listing actions archives the untouched ones as 'stale-untouched' — status done, not deleted", async () => {
  const s = actionStore([action({ id: "old" }), action({ id: "new", createdAt: ago(2) }), action({ id: "mine", source: "manual" })]);
  const listed = await s.store.listActions("u");
  const byId = Object.fromEntries(listed.map((a) => [a.id, a]));
  assert.equal(byId.old.status, "done"); assert.equal(byId.old.archivedReason, "stale-untouched");
  assert.equal(byId.new.status, "open"); assert.equal(byId.mine.status, "open");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.get().find((a) => a.id === "old").archivedReason, "stale-untouched", "persisted");
  assert.equal(s.get().length, 3, "nothing deleted");
});

test("a background close never overwrites an item the user already closed", async () => {
  const s = actionStore([action({ id: "x", status: "done", createdAt: ago(1) }), action({ id: "y", createdAt: ago(1) })]);
  await s.store.bulkUpdateActions("u", [
    { id: "x", patch: { status: "done", archivedReason: "answered-elsewhere", threadCheckedAt: "t" } },
    { id: "y", patch: { threadCheckedAt: "t" } },
  ]);
  const x = s.get().find((a) => a.id === "x");
  assert.equal(x.archivedReason, undefined); assert.equal(x.threadCheckedAt, "t");
  assert.equal(s.writes.length, 1, "one write for the whole batch");
});

// ── The resolver ─────────────────────────────────────────────────────────────

function resolver({ actions = [], updates = [] } = {}) {
  return loadTs("lib/actions/resolve-threads.ts", {
    zod,
    "@/lib/actions/store": { listActions: async () => structuredClone(actions), bulkUpdateActions: async (_u, u) => { updates.push(...u); return u.length; } },
    "@/lib/google/gmail": { getThreadState: async () => null },
    "@/lib/slack/client": { getSlackUserClientForUser: async () => null },
    "@/lib/email/known-senders": { loadKnownSenders: async () => ({ isKnown: () => false }) },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner" }) },
    "@/lib/ai/generate": { generateTextSafe: async () => ({ text: "I think so, maybe" }) },
    "@/lib/ai/model-config": { getTextModel: () => "mock" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
    "@/lib/email/triage": loadTs("lib/email/triage.ts"),
  });
}
const view = (later, over = {}) => ({ subject: "Deck", bulk: false, original: { from: "Jane Doe", date: ago(3), text: "Can you send the deck?" }, later, ...over });
const said = (from, text, self = false) => ({ from, date: ago(1), text, self });
const judgeSays = (stillNeeded, answeredBy = "", reason = "") => async () => ({ stillNeeded, answeredBy, reason });

test("decide: your reply closes it; marketing closes it; another person settling it closes it; doubt keeps it", async () => {
  const R = resolver();
  const a = { text: "Send Jane the deck" };
  assert.equal((await R.decide(a, view([said("Fixture Owner", "Attached", true)]), judgeSays(true), "Fixture")).kind, "reply-sent");
  assert.equal((await R.decide(a, view([], { bulk: true }), judgeSays(true), "Fixture")).kind, "bulk-mail");
  const settled = await R.decide(a, view([said("Omar Haddad", "I've sent Jane the deck")]), judgeSays(false, "Omar Haddad", "Omar sent it"), "Fixture");
  assert.equal(settled.kind, "answered-elsewhere"); assert.equal(settled.by, "Omar Haddad");
  assert.equal((await R.decide(a, view([said("Omar Haddad", "Fixture, can you send it?")]), judgeSays(true), "Fixture")).kind, "open");
  assert.equal((await R.decide(a, view([]), judgeSays(false), "Fixture")).kind, "open", "no later messages → nothing to judge");
});

test("the model judge keeps the item open when its answer is not clean JSON", async () => {
  const R = resolver();
  const verdict = await R.makeModelJudge("u")({ firstName: "Fixture", ask: "x", view: view([said("Omar", "hm")]) });
  assert.equal(verdict.stillNeeded, true);
  assert.match(R.judgePrompt("Fixture", "Send Jane the deck", view([said("Omar", "done")])), /Answer stillNeeded=true .* if you are unsure/);
});

test("a run closes what moved on, stamps what it checked, and skips what it checked recently", async () => {
  const updates = [];
  const actions = [
    { id: "e1", text: "Respond to Jane", status: "open", source: "email", sourceRef: "gmail:m1", createdAt: ago(2) },
    { id: "e2", text: "Register for summit", status: "open", source: "email", sourceRef: "gmail:m2", createdAt: ago(3) },
    { id: "s1", text: "Provide decision requested by Omar", status: "open", source: "slack", sourceRef: "slack:D1:1.0", createdAt: ago(4) },
    { id: "s2", text: "Answer Priya", status: "open", source: "slack", sourceRef: "slack:D2:2.0", createdAt: ago(5) },
    { id: "recent", text: "x", status: "open", source: "email", sourceRef: "gmail:m9", createdAt: ago(1), threadCheckedAt: ago(0.2) },
    { id: "manual", text: "x", status: "open", source: "manual", createdAt: ago(1) },
  ];
  const R = resolver({ actions, updates });
  const views = {
    e1: view([said("Fixture Owner", "Here it is", true)]),
    e2: view([], { bulk: true }),
    s1: view([said("Omar Haddad", "Never mind, Ed decided")]),
    s2: view([]),
  };
  const loader = async (a) => views[a.id] ?? null;
  const out = await R.resolveThreadActions("u", { loaders: { email: loader, slack: loader }, judge: judgeSays(false, "Omar Haddad", "Ed decided") });
  assert.equal(out.checked, 4, "recently checked and manual items are skipped");
  const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch]));
  assert.equal(byId.e1.archivedReason, "reply-sent");
  assert.equal(byId.e2.archivedReason, "bulk-mail");
  assert.equal(byId.s1.archivedReason, "answered-elsewhere");
  assert.match(byId.s1.notes, /Omar Haddad replied .* Ed decided/);
  assert.equal(byId.s2.status, undefined, "nothing new → stays open");
  assert.ok(byId.s2.threadCheckedAt, "…but is stamped so it isn't re-read for a day");
});

test("poll-ingest uses the resolver instead of the old 10-item, creation-anchored check", () => {
  const src = fs.readFileSync(path.join(ROOT, "app/api/events/poll-ingest/route.ts"), "utf8");
  assert.match(src, /resolveThreadActions\(username\)/);
  assert.doesNotMatch(src, /checkThreadForSentReply\(username, originalMessageId, action\.createdAt\)/);
});

// ── "Awaiting your reply" ────────────────────────────────────────────────────

function detector({ inbox = [], threads = {}, slack = null } = {}) {
  return loadTs("lib/followups/detect.ts", {
    "@/lib/google/gmail": {
      getRecentEmails: async () => structuredClone(inbox),
      getGmailAddress: async () => "me@fixture.invalid",
      getThreadState: async (_u, id) => threads[id] ?? { later: [] },
    },
    "@/lib/email/known-senders": { loadKnownSenders: async () => ({ isKnown: (e) => (e ?? "").endsWith("@fixture.invalid") }) },
    "@/lib/google/calendar": { getEventsForDateRange: async () => [] },
    "@/lib/followups/invitation-rsvp": loadTs("lib/followups/invitation-rsvp.ts"),
    "@/lib/slack/client": { getSlackUserClientForUser: async () => slack, isSlackConnected: async () => !!slack },
    "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/self-identity": {
      getSelfIdentity: async () => ({ emails: ["me@fixture.invalid"], names: ["fixture owner"] }),
      isSelf: (v, id) => id.emails.includes((v ?? "").toLowerCase()) || id.names.includes((v ?? "").toLowerCase()),
    },
  });
}
const msg = (over) => ({ id: "m", threadId: "t", from: "Jane Doe", fromEmail: "jane@partner.invalid", to: "me@fixture.invalid", subject: "Deck", snippet: "Can you send the deck?", date: ago(3), unread: false, labels: ["INBOX"], bulk: false, ...over });

test("awaiting reply: one card per conversation, none once anyone has replied, none for list mail from strangers", async () => {
  const D = detector({
    inbox: [
      msg({ id: "a1", threadId: "t1" }),                                                        // Jane asks…
      msg({ id: "a2", threadId: "t1", from: "Omar Haddad", fromEmail: "omar@fixture.invalid",   // …a colleague answers on reply-all
        to: "jane@partner.invalid", cc: "me@fixture.invalid", snippet: "Sent it over, Jane", date: ago(2) }),
      msg({ id: "b1", threadId: "t2", from: "Events | Summit", fromEmail: "events@summit.invalid", bulk: true, snippet: "Register now" }),
      msg({ id: "c1", threadId: "t3", from: "GTM Leads", fromEmail: "gtm-leads@fixture.invalid", bulk: true, snippet: "Can you review the plan?" }),
      msg({ id: "d1", threadId: "t4", from: "Priya N", fromEmail: "priya@partner.invalid", snippet: "Could you confirm Tuesday?" }),
      msg({ id: "d2", threadId: "t4", from: "Priya N", fromEmail: "priya@partner.invalid", snippet: "Bumping this", date: ago(2) }),
    ],
    threads: { a1: { later: [{ id: "a2" }] } },
  });
  const res = await D.detectPendingFollowups("u", { staleHours: 24 });
  assert.equal(res.items.map((i) => i.id).sort().join(","), "gmail:c1,gmail:d2",
    "Jane's thread was answered by Omar; the summit blast is dropped; the colleague list post stays; Priya's thread is one card");
});

test("Slack group DMs only wait on you when the last message names you", async () => {
  const old = String(Date.now() / 1000 - 3 * 86400);
  const history = { G1: "The deck is in Drive now", G2: "Fixture, can you approve?", D1: "Can you send it?" };
  const web = {
    auth: { test: async () => ({ user_id: "USELF", team_id: "T1" }) },
    conversations: {
      list: async () => ({ channels: [{ id: "G1", is_mpim: true }, { id: "G2", is_mpim: true }, { id: "D1" }] }),
      history: async ({ channel }) => ({ messages: [{ user: "UOTHER", text: history[channel], ts: old }] }),
    },
    users: { info: async () => ({ user: { real_name: "Omar Haddad" } }) },
    chat: { getPermalink: async () => ({ permalink: "https://slack.invalid/p" }) },
  };
  const res = await detector({ slack: web }).detectPendingFollowups("u2", { staleHours: 24 });
  assert.equal(res.items.map((i) => i.id).sort().join(","), "slack:D1,slack:G2", "G1's last word answers someone else; G2 names you");
});

// ── Calendar invitations and unsolicited service requests (2026-10-04) ──────

test("calendar invitations are recognised; ordinary mail about meetings is not", () => {
  const { isCalendarInvitation } = loadTs("lib/email/triage.ts");
  for (const subj of ["Invitation: AG demo @ Fri 3 Jul", "Updated invitation with note: TG Leadership", "Updated invitation: Weekly sync",
    "Accepted: Pipeline review", "Declined: QBR", "Tentative: Board prep", "Canceled: Standup", "Invitation from Google Calendar: x"]) {
    assert.ok(isCalendarInvitation(subj), subj);
  }
  for (const subj of ["Can we find time next week?", "Re: invitation to speak at the summit", "Follow-up from the demo", ""]) {
    assert.ok(!isCalendarInvitation(subj), subj);
  }
});

test("open actions from invitations close as 'calendar-invite'; invitation emails create no actions", async () => {
  const R = resolver();
  const r = await R.decide({ text: "Respond to scheduling request from Ed" }, view([], { subject: "Updated invitation with note: TG Leadership" }), judgeSays(true), "Fixture");
  assert.equal(r.kind, "calendar-invite");
  const src = fs.readFileSync(path.join(ROOT, "lib/email/materialize-email.ts"), "utf8");
  assert.match(src, /if \(aTier !== "skip" && !isCalendarInvitation\(subject\)\)/);
});

test("the email classifier treats review, survey, registration and waitlist requests from strangers as noise", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/email/classify-email.ts"), "utf8");
  assert.match(src, /low_value_noise: [^\n]*leave a review, take a survey[^\n]*register for an event[^\n]*waitlist/);
});
