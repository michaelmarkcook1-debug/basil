// The "Meeting Summaries — Calls You Didn't Host" digest (lib/zoom/digest.ts).
// Zoom only mails recaps to the host; this digest is how calls the user joins
// reach Basil. Each section becomes one meeting with a stable id, and a section
// whose summary is the generator's own instructions is never mined.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const D = loadTs("lib/zoom/digest.ts");

const HTML = `<html><body>
<h2>Meeting Summaries &mdash; Meetings You Didn&#39;t Host</h2>
<p><em>Covering the last 30 days (1 Sep &ndash; 1 Oct 2026)</em></p>
<div style="border-left:4px solid #4a8">
  <h3>Northwind weekly sync</h3>
  <p><strong>Host:</strong> Dana Okafor &nbsp;|&nbsp; <strong>Date:</strong> 2026-09-30 15:30:09</p>
  <p>The team reviewed the pilot numbers and agreed to extend the trial by two weeks. Priya will send the revised pricing sheet by Friday, and Sam will set up a follow-up call with procurement.</p>
</div>
<div style="border-left:4px solid #4a8">
  <h3>Partner standup</h3>
  <p><strong>Host:</strong> Lee Park &nbsp;|&nbsp; <strong>Date:</strong> 2026-09-29 18:29:47</p>
  <p>We need summarize 3-5 sentences, topics decisions actions. Mention onboarding. Concise.</p>
</div>
<div style="border-left:4px solid #4a8">
  <h3>Design review &amp; roadmap</h3>
  <p><strong>Host:</strong> Lee Park &nbsp;|&nbsp; <strong>Date:</strong> 2026-09-28 09:00:00</p>
  <p>**Key topics:** the onboarding flow and the Q4 roadmap.</p>
  <p>**Action items:** Michael will share the prototype with the board.</p>
</div>
</body></html>`;

test("an HTML digest splits into one meeting per section", () => {
  const ms = D.parseZoomDigest(HTML);
  assert.equal(ms.length, 3);
  assert.equal(ms[0].title, "Northwind weekly sync");
  assert.equal(ms[0].host, "Dana Okafor");
  assert.equal(ms[0].date, "2026-09-30T15:30:09.000Z");
  assert.match(ms[0].summary, /^The team reviewed the pilot numbers/);
  assert.doesNotMatch(ms[0].summary, /Partner standup/, "a summary stops before the next section's title");
  assert.equal(ms[2].title, "Design review & roadmap");
  assert.match(ms[2].summary, /Key topics:.*\n.*Action items: Michael will share/s, "multi-paragraph summaries keep their paragraphs");
});

test("a summary that is the generator's instructions is marked unusable", () => {
  const ms = D.parseZoomDigest(HTML);
  assert.equal(ms[0].usable, true);
  assert.equal(ms[1].usable, false);
  assert.equal(ms[2].usable, true);
  assert.equal(D.looksLikeLeakedPrompt("Summarize in 3-5 sentences: decisions and actions only."), true);
  assert.equal(D.looksLikeLeakedPrompt("ok"), true, "too short to mine");
  assert.equal(D.looksLikeLeakedPrompt("We need to hire two engineers before the launch, so Dana will open the roles this week."), false);
});

test("plain-text / markdown digests parse too, with Host and Date on separate lines", () => {
  const text = [
    "Meeting Summaries — Meetings You Didn't Host",
    "",
    "**Quarterly planning**",
    "**Host:** Ana Ruiz",
    "**Date:** 2026-09-25 10:00",
    "Budget for Q4 was approved; Ana will circulate the final numbers.",
    "",
    "Unsubscribe",
  ].join("\n");
  const [m] = D.parseZoomDigest(text);
  assert.equal(m.title, "Quarterly planning");
  assert.equal(m.host, "Ana Ruiz");
  assert.equal(m.date, "2026-09-25T10:00:00.000Z");
  assert.equal(m.summary, "Budget for Q4 was approved; Ana will circulate the final numbers.", "footer is not part of the summary");
});

test("a meeting's id is the same in every digest that repeats it", () => {
  const a = D.parseZoomDigest(HTML)[0];
  const b = D.parseZoomDigest(HTML.replace("1 Sep", "2 Sep"))[0];
  assert.equal(D.digestMeetingRef(a), D.digestMeetingRef(b));
  assert.equal(D.digestMeetingRef(a), "zoom-digest:2026-09-30T15:30:northwind-weekly-sync");
  assert.notEqual(D.digestMeetingRef(a), D.digestMeetingRef(D.parseZoomDigest(HTML)[2]));
});

test("only a Meeting Summaries email from the user's own address counts", () => {
  const self = { emails: ["me@example.com", "me@alias.example"], names: ["michael cook"] };
  assert.equal(D.isZoomDigest({ from: "me@alias.example", subject: "Meeting Summaries — Calls You Didn't Host (Last 30 Days)" }, self), true);
  assert.equal(D.isZoomDigest({ from: "Michael <me@alias.example>", subject: "Meeting Summaries" }, self), true);
  assert.equal(D.isZoomDigest({ from: "x", fromEmail: "stranger@evil.example", subject: "Meeting Summaries" }, self), false);
  assert.equal(D.isZoomDigest({ from: "me@example.com", subject: "Re: meeting summaries from last week" }, self), false);
});

test("the extraction text names the host as a participant", () => {
  const t = D.digestMeetingText(D.parseZoomDigest(HTML)[0]);
  assert.match(t, /^Meeting: Northwind weekly sync\nHost: Dana Okafor\nDate: 2026-09-30\nMeeting participants: Dana Okafor/);
});

test("the sync reads the digest, dedupes by meeting, caps each run, and reprocess leaves digest events alone", () => {
  const r = src("app/api/events/poll-ingest/route.ts");
  assert.match(r, /searchEmails\(username, ZOOM_DIGEST_GMAIL_QUERY, 5\)/);
  assert.match(r, /isZoomDigest\(m, selfIdentity\)/);
  assert.match(r, /hasExternalId\(username, ref\)/);
  assert.match(r, /const DIGEST_PER_RUN = 10/);
  assert.match(r, /if \(!m\.usable\) \{ digestUnusable\+\+; continue; \}/, "no event for an unusable summary");
  assert.match(r, /for \(const q of queued\) \{\s*await processZoomEmail\(/, "one at a time, not in parallel");
  assert.match(r, /body: digestMeetingText\(q\.m\),\s*ensureAttendees: \[q\.m\.host\]/);
  assert.match(src("app/api/events/reprocess/route.ts"), /ev\.source === "zoom_email" && ev\.externalId!\.startsWith\("gmail:"\)/);
  const p = src("lib/email/process-gmail-message.ts");
  assert.match(p, /opts\.body !== undefined\s*\? \{ body: opts\.body, date: dateFallback \}/);
});
