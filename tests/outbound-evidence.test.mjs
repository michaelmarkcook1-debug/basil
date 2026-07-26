/**
 * tests/outbound-evidence.test.mjs
 *
 * Guards the fix for the worst class of briefing error: telling Michael
 * something is blocked when he has already dealt with it.
 *
 * The real failure, verbatim from a weekly brief:
 *   "BLOCKERS — Kyndryl pricing is sitting on your desk, not Ed's. […] Six days
 *    later there's no revised sheet and no logged decision."
 * He had sorted the pricing, emailed the deck to Olivia, and told Ed it was
 * handled. All three are OUTBOUND, and the digest's email feed is `in:inbox`,
 * so it was structurally incapable of seeing any of them.
 *
 * Two things must hold, and the SECOND is the dangerous one:
 *   1. Completion language is recognised  → the item is closed.
 *   2. FUTURE-TENSE language is NOT       → "I'll sort it tomorrow" is a
 *      promise, not a completion. Treating it as done would recreate the bug in
 *      the opposite direction: silently closing work that has not happened.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const mod = read("lib/briefing/outbound-evidence.ts");
const digest = read("app/api/generate/digest/route.ts");
const gmail = read("lib/google/gmail.ts");

test("sent mail is reachable, and kept separate from the inbox feed", () => {
  assert.ok(/export async function getSentEmails/.test(gmail),
    "there must be a sent-mail accessor — in:inbox alone hid every resolution");
  assert.ok(/"in:sent"/.test(gmail), "it must query in:sent");
  // The inbox restriction must REMAIN — it stops the user's own mail being
  // ingested as inbound signal. The two coexist deliberately.
  assert.ok(/"in:inbox"/.test(gmail),
    "getRecentEmails must stay inbox-only; getSentEmails is the separate counterpart");
});

test("the digest reads outbound evidence and is told not to mine it for work", () => {
  assert.ok(/getSentEmails\(username/.test(digest), "digest must fetch sent mail");
  assert.ok(/fromSelf/.test(digest), "digest must include the user's OWN Slack messages");
  assert.ok(/WHAT MICHAEL ALREADY DID/.test(digest), "the block must be present in the prompt");
  assert.ok(/NOT a source of new actions/.test(digest),
    "the prompt must forbid mining outbound evidence for new work");
});

test("the blockers instruction encodes all three states", () => {
  const blockers = digest.slice(digest.indexOf('"blockers":'), digest.indexOf('"blockers":') + 2200);
  assert.ok(/CLOSED/.test(blockers) && /OMIT IT ENTIRELY/.test(blockers),
    "an explicitly-completed item must be omitted, not softened");
  assert.ok(/IN FLIGHT/.test(blockers) && /awaiting/i.test(blockers),
    "a sent-but-unconfirmed item must read as awaiting the other side");
  assert.ok(/GENUINELY BLOCKED/.test(blockers),
    "only items with no outbound action may be called blocked");
  assert.ok(/prefer \(b\) over \(c\)/.test(blockers),
    "ambiguity must fail toward 'in flight', never toward accusing him of inaction");
});

// ── Contract lock: mirrors statesCompletion() in outbound-evidence.ts ────────
// The module is server-only, so the decision is re-implemented here. If the
// module's patterns change, update BOTH.
test("behaviour: completions are recognised, promises are NOT", () => {
  const DONE = [
    /\b(?:i've|i have|just|now)\s+(?:sorted|sent|shared|handled|resolved|finished|completed|actioned|done)\b/i,
    /\b(?:sorted|handled|resolved|actioned)\s+(?:it|this|that|now)\b/i,
    /\b(?:it's|thats|that's|this is|all)\s+(?:sorted|done|handled|sent|resolved|finished|complete[d]?)\b/i,
    /\b(?:sent|shared|sending)\s+(?:it|this|that|the deck|the sheet|the list|over|across|through)\b/i,
    /\bhas been (?:sent|shared|sorted|handled|resolved|completed)\b/i,
    /\btaken care of\b/i,
    /\bclosed (?:this |that |it )?out\b/i,
    /\bwrapped (?:this |that |it )?up\b/i,
    /\bno longer (?:blocked|blocking|an issue)\b/i,
  ];
  const FUTURE = [
    /\b(?:i'll|i will|going to|gonna|planning to|need to|should|about to|once i|when i)\b/i,
    /\b(?:tomorrow|later today|next week|shortly|in a bit|by (?:friday|monday|eod|cob))\b/i,
  ];
  const states = (t) => !!t && !FUTURE.some((r) => r.test(t)) && DONE.some((r) => r.test(t));

  // Michael's actual words — these MUST resolve the Kyndryl blocker.
  assert.equal(states("I've sorted the pricing and sent the deck to Olivia"), true);
  assert.equal(states("that's sorted, deck went over this morning"), true);
  assert.equal(states("sent it over to Olivia"), true);
  assert.equal(states("Pricing has been sent"), true);
  assert.equal(states("taken care of"), true);

  // Promises must NOT close anything — this is the dangerous direction.
  assert.equal(states("I'll get that sorted tomorrow"), false, "a promise is not a completion");
  assert.equal(states("going to send the deck over later today"), false);
  assert.equal(states("I need to sort the Kyndryl pricing"), false);
  assert.equal(states("will have it done by Friday"), false);
  assert.equal(states("once I sort the pricing I'll send it"), false);

  assert.equal(states(""), false);
  assert.equal(states("Thanks — looks good"), false, "acknowledgement is not completion");
});
