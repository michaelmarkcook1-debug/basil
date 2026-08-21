/**
 * tests/flow-shared.test.mjs
 *
 * The three components the flow pages now share, and the honesty rules that
 * make them safe to reuse.
 *
 * The pattern being prevented: each list page grew its own "here is everything"
 * default and its own empty state, so a fix to one never reached the others —
 * the same drift that produced two Resend clients and eight copies of the
 * spend-cap message.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Source with comments removed.
 *
 * Scanning raw source for a banned term keeps matching the comment that
 * explains why the term was banned — it has now broken a test in this repo four
 * separate times. Scan code; read prose with your eyes.
 */
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const attention = read("components/shared/needs-attention.tsx");
const nba       = read("components/shared/next-best-action.tsx");
const relOv     = read("components/shared/relationship-overview.tsx");

test("a zero count during an outage never renders as all-clear", () => {
  // The single rule that matters here. "Nothing needs attention" and "Basil
  // could not read whether anything needs attention" produce an identical
  // total of 0, and only one of them is safe to show.
  assert.ok(/unavailable\?:/.test(attention), "the component must accept an unavailable reason");
  const order = attention.indexOf("if (unavailable)");
  const clear = attention.indexOf("if (total === 0)");
  assert.ok(order > -1 && clear > -1, "both branches must exist");
  assert.ok(order < clear,
    "the unavailable branch must be reached BEFORE the all-clear branch, or an outage reports as calm");
  assert.ok(/Cannot tell what needs attention/.test(attention));
});

test("the attention lead never computes urgency itself", () => {
  // Counts arrive already derived from stored records. If this component started
  // deriving them it could disagree with the list beneath it — and a lead that
  // contradicts its own page is worse than no lead.
  // A `.filter` on the buckets is display (hiding zero chips), not derivation.
  // Date arithmetic would be derivation, and that is what must not appear.
  assert.ok(!/new Date\(|Date\.now|\.getTime\(/.test(attention),
    "counts must be passed in already derived, not computed from timestamps here");
  assert.ok(!/status ===|dueDate|overdue\s*=/.test(attention),
    "the lead must not know what 'overdue' means — only what number it was handed");
});

test("an absent next action says so rather than rendering an empty box", () => {
  assert.ok(/No next action recorded/.test(nba),
    "an empty 'Next best action' frame implies Basil considered the question and had nothing");
  assert.ok(/if \(!action\)/.test(nba), "the absence must short-circuit before the frame renders");
});

test("Projects uses the shared action component, not its own copy", () => {
  const projects = read("app/dashboard/projects/page.tsx");
  assert.ok(/NextBestAction/.test(projects), "Projects must consume the shared component");
  assert.ok(!/uppercase tracking-\[0\.18em\][^]{0,80}Next best action/.test(projects),
    "the inline 12px letterspaced label was the version that read as chrome and got skipped");
});

test("relationship ranking uses a stored fact and invents no score", () => {
  assert.ok(/daysSince/.test(relOv), "ranking is by time since the last recorded interaction");
  // The interface is the contract: if no importance-like FIELD is declared,
  // none can be rendered. Prose that says "Basil does not score importance" is
  // the opposite of the failure and must not trip the check.
  const iface = relOv.slice(relOv.indexOf("export interface QuietContact"), relOv.indexOf("const DAY"));
  assert.ok(!/importance|health|score|rating|weight/i.test(iface),
    "no importance-like field may exist on the contact shape — there is no such data to fill it");
  assert.ok(/\.sort\(\(a, b\) => b\.days - a\.days\)/.test(relOv),
    "the only ranking must be days since last interaction");
});

test("no recorded interaction is distinguished from a cold relationship", () => {
  assert.ok(/missing history, not a cold relationship/.test(relOv),
    "folding unknown history into 'gone quiet' asserts a relationship cooled when Basil simply has no record");
  assert.ok(/noRecord/.test(relOv), "contacts with no history must be counted separately");
});

test("People no longer opens on a placeholder", () => {
  const people = read("app/dashboard/contacts/page.tsx");
  assert.ok(/RelationshipOverview/.test(people));
  assert.ok(!/Select a contact/.test(code("app/dashboard/contacts/page.tsx")),
    "a panel explaining the interaction model to someone who already understands it spends the surface saying nothing");
});

test("Decisions shows the ABSENCE of a follow-up, not only its presence", () => {
  const d = read("app/dashboard/decisions/page.tsx");
  assert.ok(/No follow-up/.test(d),
    "a decision nobody turned into work is the risk; showing only linked actions hides exactly that case");
});

test("Meetings reuses Today's preparation rules rather than restating them", () => {
  const m = read("app/dashboard/meetings/page.tsx");
  assert.ok(/preparationReasons/.test(m) && /@\/lib\/today\/executive/.test(m),
    "two surfaces that disagree about whether a meeting needs prep are worse than one that never said");
  assert.ok(/myResponseStatus/.test(m), "RSVP state was returned by the API but never read");
});

test("Commitments gives stalled and completed work an archive treatment", () => {
  const a = read("app/dashboard/actions/page.tsx");
  assert.ok(/archive\?: boolean/.test(a), "archive must be an explicit treatment, not ad-hoc styling");
  assert.ok(/archive\n\s+note=/.test(a) || /archive$/m.test(a),
    "stalled and done must actually opt in");
  assert.ok(/they are forgotten/.test(a),
    "stalled items need saying what they ARE — not overdue, forgotten");
});

test("Briefing is anchored to Today", () => {
  const b = read("app/dashboard/briefing/page.tsx");
  assert.ok(/expanded explanation behind/.test(b),
    "it presented as a standalone generation screen, which framed it as a separate product");
});

test("every dev harness is unreachable in production", () => {
  const dir = resolve(ROOT, "app/dev-harness");
  const pages = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "page.tsx") pages.push(p);
    }
  };
  walk(dir);
  assert.ok(pages.length > 0, "expected harness pages to exist");
  for (const p of pages) {
    assert.ok(/NODE_ENV === "production"/.test(readFileSync(p, "utf8")),
      `${p.replace(ROOT + "/", "")} renders synthetic data and must be guarded`);
  }
});
