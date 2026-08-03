/**
 * tests/linkedin-from-signature.test.mjs
 *
 * Harvesting LinkedIn profiles from email signatures.
 *
 * The LinkedIn AutoFill plugin and profile API both only ever return the
 * AUTHENTICATED member's own profile, so neither can enrich a contact list.
 * The usable signal is the URL people put in their own email signature — which
 * Basil already has, because it fetches full bodies for classification.
 *
 * The dangerous failure here is MIS-attribution: writing the wrong person's
 * profile onto a contact. That is worse than an empty field, because the user
 * has to notice it to fix it. These tests pin the conservative behaviour.
 *
 * Contract-lock (house pattern): the extraction is reimplemented below. If
 * linkedin-from-signature.ts changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/contacts/linkedin-from-signature.ts"), "utf8");

// ── Contract lock: mirror of the extractor ───────────────────────────────────
const PROFILE_RE =
  /(?:https?:\/\/)?(?:(?:[a-z]{2,3}|www|m)\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%À-ÿ.]{2,100})/gi;
const TRAILING_JUNK = /[.,;:)\]}>"'|]+$/;

function extract(text) {
  if (!text) return [];
  const out = [], seen = new Set();
  for (const m of text.matchAll(PROFILE_RE)) {
    let slug = (m[1] ?? "").replace(TRAILING_JUNK, "").split(/[/?#]/)[0] ?? "";
    if (!slug) continue;
    try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, url: `https://www.linkedin.com/in/${slug}` });
  }
  return out;
}
const senderProfile = (body) => { const f = extract(body); return f.length === 1 ? f[0] : null; };

// ── Realistic signatures ─────────────────────────────────────────────────────

test("plain-text signature", () => {
  const body = [
    "Thanks Michael — let's pick this up Thursday.",
    "",
    "Malcolm Frank",
    "VP Strategy | Ascendion",
    "m: +1 555 0134",
    "https://www.linkedin.com/in/malcolm-frank-1234567/",
  ].join("\n");
  const hit = senderProfile(body);
  assert.ok(hit, "a single signature link must be attributed to the sender");
  assert.equal(hit.url, "https://www.linkedin.com/in/malcolm-frank-1234567");
});

test("HTML signature (href) needs no HTML parsing", () => {
  const body = `<p>Best,</p><p>Olivia</p>
    <a href="https://uk.linkedin.com/in/olivia-bond-keith?trk=email_sig">LinkedIn</a>`;
  const hit = senderProfile(body);
  assert.ok(hit);
  assert.equal(hit.url, "https://www.linkedin.com/in/olivia-bond-keith",
    "country subdomain normalises to www and tracking params are dropped");
});

test("bare domain, no scheme, trailing punctuation", () => {
  const hit = senderProfile("Find me at linkedin.com/in/jane-doe.");
  assert.ok(hit);
  assert.equal(hit.slug, "jane-doe", "the trailing full stop is not part of the slug");
});

test("the same profile written twice yields one result", () => {
  const body = `www.linkedin.com/in/sam-rivera
                https://www.linkedin.com/in/Sam-Rivera/`;
  assert.equal(extract(body).length, 1, "case-insensitive dedupe on the slug");
});

// ── Attribution safety ───────────────────────────────────────────────────────

test("MULTIPLE profiles → no attribution", () => {
  const body = [
    "Intro: Malcolm (linkedin.com/in/malcolm-frank) meet Olivia",
    "(linkedin.com/in/olivia-bond-keith) — you two should talk.",
  ].join("\n");
  assert.equal(extract(body).length, 2, "both are found…");
  assert.equal(senderProfile(body), null,
    "…but attributing either to the sender would be a confident wrong answer");
});

test("company, school, pulse and feed links are never treated as people", () => {
  for (const url of [
    "https://www.linkedin.com/company/ascendion",
    "https://www.linkedin.com/school/mit",
    "https://www.linkedin.com/pulse/some-article-name",
    "https://www.linkedin.com/feed/update/urn:li:activity:123",
    "https://www.linkedin.com/jobs/view/456",
  ]) {
    assert.equal(extract(url).length, 0, `${url} is not a personal profile`);
  }
});

test("lnkd.in short links are ignored rather than guessed", () => {
  assert.equal(extract("see https://lnkd.in/abc123").length, 0,
    "resolving needs a network fetch; guessing is how a wrong profile gets attached");
});

test("empty and profile-free bodies are safe", () => {
  assert.equal(senderProfile(""), null);
  assert.equal(senderProfile("No links here at all."), null);
  assert.equal(senderProfile("mail me at malcolm@ascendion.com"), null);
});

// ── Search fallback ──────────────────────────────────────────────────────────

test("the no-profile fallback is a SEARCH link, never a guessed profile", () => {
  assert.ok(/search\/results\/people/.test(src),
    "a contact with no known profile gets a search URL to click");
  // Scoped to the fallback function: building /in/<slug> from an EXTRACTED slug
  // is canonicalisation and correct. Building one from a NAME would be
  // fabricating a record, so the name-based path must never emit /in/.
  const fn = src.slice(src.indexOf("export function linkedInSearchUrl"));
  assert.ok(!/linkedin\.com\/in\//.test(fn),
    "a vanity URL must never be synthesised from a name — that fabricates a record");
  assert.ok(/encodeURIComponent/.test(fn),
    "the query must be encoded — names contain spaces and punctuation");
});
