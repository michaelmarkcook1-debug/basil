/**
 * tests/linkedin-notification.test.mjs
 *
 * LinkedIn sits in MARKETING_DOMAINS because most of its volume is promotional.
 * That was right for job alerts and "People you may know", and wrong for "X sent
 * you a message" — which is precisely the relational signal Basil exists to
 * catch, and was being binned with the adverts.
 *
 * The asymmetry that governs this file: a false "needs you" costs far more than
 * a missed digest, so marketing is checked FIRST and anything unrecognised stays
 * suppressed. LinkedIn's promotional subjects deliberately borrow the grammar of
 * notifications ("See who viewed your profile"), so the ordering is load-bearing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/email/linkedin-notification.ts"), "utf8");
const route = readFileSync(resolve(ROOT, "app/api/email/route.ts"), "utf8");

// ── Reimplementation of the classifier (contract-lock) ───────────────────────
const isLinkedIn = (e) => /@([a-z0-9-]+\.)*linkedin\.com$/i.test((e ?? "").trim().toLowerCase());
const MARKETING = [/people you may know/i, /job alert|jobs? for you|new jobs?|hiring/i,
  /your network (has|is)|network update|weekly|daily digest|this week/i,
  /see who|profile views?|appeared in \d+ search/i,
  /trending|top (voices?|stories)|news(letter)?|premium|free (month|trial)|upgrade/i,
  /course|learning|skill assessment|webinar|event reminder/i,
  /congratulate|work anniversary|birthday/i];
const MESSAGE = [/sent you a message/i, /\bnew message\b/i, /replied to (you|your)/i, /\bInMail\b/i];
const INVITATION = [/invitation (to connect|from)/i, /wants to connect/i, /would like to connect/i,
  /\byour invitation\b/i, /accepted your invitation/i];
const MENTION = [/mentioned you/i, /tagged you/i, /commented on your/i, /reacted to your/i];

function classify(from, subject) {
  if (!isLinkedIn(from)) return "unknown";
  const s = subject ?? "", local = (from.split("@")[0] ?? "").toLowerCase();
  if (/^(jobs|job-alerts|jobs-listings|news|updates|notifications?|learning|education|premium|marketing)/.test(local)) return "marketing";
  if (MARKETING.some((r) => r.test(s))) return "marketing";
  if (/^(messag|inmail)/.test(local) || MESSAGE.some((r) => r.test(s))) return "message";
  if (/^invit/.test(local) || INVITATION.some((r) => r.test(s))) return "invitation";
  if (MENTION.some((r) => r.test(s))) return "mention";
  return "unknown";
}
const actionable = (f, s) => ["message", "invitation", "mention"].includes(classify(f, s));

test("real interpersonal notifications get through", () => {
  assert.equal(classify("messaging-digest-noreply@linkedin.com", "Ed Baum sent you a message"), "message");
  assert.equal(classify("invitations-noreply@linkedin.com", "Invitation to connect from Mei Lin"), "invitation");
  assert.equal(classify("noreply@linkedin.com", "Daniel Okafor mentioned you in a post"), "mention");
  assert.equal(classify("inmail-hit-reply@linkedin.com", "You have a new InMail"), "message");
  for (const s of ["Ed sent you a message", "Mei wants to connect", "Tom commented on your post"]) {
    assert.ok(actionable("noreply@linkedin.com", s), `"${s}" is real signal`);
  }
});

test("marketing stays suppressed", () => {
  for (const [from, subj] of [
    ["jobs-noreply@linkedin.com", "New jobs for you"],
    ["noreply@linkedin.com", "People you may know"],
    ["noreply@linkedin.com", "See who viewed your profile"],
    ["news-noreply@linkedin.com", "Top stories this week"],
    ["noreply@linkedin.com", "Your network has been busy"],
    ["noreply@linkedin.com", "Congratulate Ed on his work anniversary"],
  ]) {
    assert.equal(classify(from, subj), "marketing", `"${subj}" is an advert`);
    assert.ok(!actionable(from, subj));
  }
});

test("marketing is checked BEFORE notifications", () => {
  // LinkedIn writes adverts in notification grammar on purpose. If the message
  // patterns ran first, "See who viewed your profile after your new message"
  // would surface as someone contacting the user.
  const body = src.slice(src.indexOf("export function classifyLinkedInEmail"));
  assert.ok(body.indexOf("MARKETING.some") < body.indexOf("MESSAGE.some"),
    "the marketing check must come first, or promotional copy borrowing notification " +
    "grammar produces a false 'needs you'");
});

test("unrecognised LinkedIn mail is suppressed but LOGGED", () => {
  assert.equal(classify("something-new@linkedin.com", "A subject nobody predicted"), "unknown");
  assert.ok(!actionable("something-new@linkedin.com", "A subject nobody predicted"),
    "defaulting an unknown to actionable would flood the feed with adverts");
  assert.ok(/console\.info\([^)]*linkedin/i.test(src) || /\[linkedin\]/.test(src),
    "an unrecognised kind must surface as a log line, not vanish — that is how these " +
    "patterns get corrected once real mail arrives");
});

test("only genuine LinkedIn domains match", () => {
  assert.ok(isLinkedIn("noreply@linkedin.com"));
  assert.ok(isLinkedIn("x@mail.linkedin.com"));
  // A lookalike domain must not inherit LinkedIn's allowance.
  assert.ok(!isLinkedIn("noreply@linkedin.com.evil.net"));
  assert.ok(!isLinkedIn("noreply@notlinkedin.com"));
});

test("the email filter consults the classifier instead of the blanket domain rule", () => {
  const li = route.indexOf("isLinkedInSender(addr)");
  const blanket = route.indexOf("MARKETING_DOMAINS.test(addr)) return false");
  assert.ok(li > -1, "the route must ask the classifier");
  assert.ok(li < blanket,
    "LinkedIn must be decided BEFORE the blanket domain rule, which would drop it");
});
