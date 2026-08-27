/**
 * tests/linkedin-self-exclusion.test.mjs
 *
 * The mis-attribution the user's own profile URL exists to prevent.
 *
 * Signature harvesting reads a LinkedIn profile out of a mail body and attaches
 * it to the sender. But a REPLY quotes the user's own signature beneath the
 * sender's — which is most business mail — so when the sender has no LinkedIn of
 * their own, the only profile in the body is the USER'S, and it gets attached to
 * them. A confident wrong profile is the worst outcome here: the user has to
 * notice it to fix it, and a plausible one is exactly what nobody notices.
 *
 * The same exclusion RECOVERS yield. A reply carrying both profiles was
 * discarded as ambiguous; removing the user's leaves precisely one — the
 * sender's — which is the single most common shape of real mail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/contacts/linkedin-from-signature.ts"), "utf8");
const enrich = readFileSync(resolve(ROOT, "lib/contacts/enrich-linkedin.ts"), "utf8");

// ── Reimplementation (contract-lock) ─────────────────────────────────────────
const RE = /(?:https?:\/\/)?(?:(?:[a-z]{2,3}|www|m)\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%À-ÿ.]{2,100})/gi;
const JUNK = /[.,;:)\]}>"'|]+$/;
function extract(text) {
  const out = [], seen = new Set();
  for (const m of (text ?? "").matchAll(RE)) {
    let slug = (m[1] ?? "").replace(JUNK, "").split(/[/?#]/)[0] ?? "";
    if (!slug) continue;
    try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
    const k = slug.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push({ slug, url: `https://www.linkedin.com/in/${slug}` });
  }
  return out;
}
function slugOf(input) {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const m = /linkedin\.com\/in\/([A-Za-z0-9\-_%À-ÿ.]{2,100})/i.exec(raw);
  const slug = (m ? m[1] : raw).split(/[/?#]/)[0] ?? "";
  return slug ? slug.replace(JUNK, "").toLowerCase() : null;
}
function senderProfile(body, self) {
  const s = slugOf(self);
  const found = extract(body).filter((p) => !s || p.slug.toLowerCase() !== s);
  return found.length === 1 ? found[0] : null;
}

const SELF = "https://www.linkedin.com/in/mike-cook-85550755/";

test("a reply quoting only the user's signature attributes NOTHING", () => {
  // The bug. Sender has no LinkedIn; the user's own is quoted below.
  const body = `
    Thanks Michael, that works for me.
    Regards, Ed
    ________________________________
    From: Michael Cook
    Michael Cook | TalentGenius
    https://www.linkedin.com/in/mike-cook-85550755/
  `;
  assert.equal(senderProfile(body, null)?.slug, "mike-cook-85550755",
    "without the exclusion the user's own profile is what gets attributed");
  assert.equal(senderProfile(body, SELF), null,
    "with it, Basil correctly concludes it does not know the sender's profile");
});

test("a reply carrying BOTH profiles now resolves to the sender", () => {
  const body = `
    Good to speak. Ed Baum | Northwind
    https://linkedin.com/in/edbaum
    ________________________________
    Michael Cook | TalentGenius
    https://www.linkedin.com/in/mike-cook-85550755/
  `;
  assert.equal(senderProfile(body, null), null,
    "previously discarded as ambiguous — the most common shape of real mail");
  assert.equal(senderProfile(body, SELF)?.slug, "edbaum",
    "excluding the user's own leaves exactly one, and it is the sender's");
});

test("a genuinely ambiguous body is still refused", () => {
  const body = `Intro: https://linkedin.com/in/alice and https://linkedin.com/in/bob
                — Michael https://www.linkedin.com/in/mike-cook-85550755/`;
  assert.equal(senderProfile(body, SELF), null,
    "two candidates that are not the user remain unattributable");
});

test("the slug parser accepts a URL or a bare slug, and normalises", () => {
  for (const form of [
    "https://www.linkedin.com/in/mike-cook-85550755/",
    "linkedin.com/in/mike-cook-85550755",
    "uk.linkedin.com/in/Mike-Cook-85550755",
    "mike-cook-85550755",
  ]) {
    assert.equal(slugOf(form), "mike-cook-85550755", `${form} must normalise`);
  }
  assert.equal(slugOf(""), null);
  assert.equal(slugOf(undefined), null);
});

test("live ingest reads the user's own profile from settings", () => {
  assert.ok(/getSettings\(username\)/.test(enrich), "the exclusion must apply during ingest");
  assert.ok(/senderProfileFrom\(rawBody, selfProfile\)/.test(enrich),
    "the enricher must pass it, or the guard exists but never runs");
  assert.ok(/catch\(\(\) => undefined\)/.test(enrich),
    "unreadable settings must degrade to no-exclusion, never fail the ingest");
});

test("the exclusion happens BEFORE the ambiguity test", () => {
  const fn = src.slice(src.indexOf("export function senderProfileFrom"));
  assert.ok(fn.indexOf(".filter(") < fn.indexOf("found.length === 1"),
    "filtering after the count would keep discarding the both-profiles case that " +
    "this change exists to recover");
});
