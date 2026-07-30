/**
 * tests/zoom-forwarded.test.mjs
 *
 * FORWARDED Zoom summaries must reach the model.
 *
 * The canonical ZOOM_GMAIL_QUERY is `from:`-restricted to Zoom's domains —
 * correct for direct mail, but a recap a colleague forwards arrives from THEIR
 * address and could never match, so forwarded summaries were invisible to every
 * consumer: briefing, digest, meeting prep, poll-ingest, and the Gmail webhook.
 *
 * Three layers close it, pinned here:
 *   1. detector — forwarded-specific signals (Fwd+zoom-subject, and the
 *      forwarding preamble quoting Zoom as the ORIGINAL sender)
 *   2. query — ZOOM_FORWARDED_GMAIL_QUERY without the sender restriction,
 *      always gated by the detector since it is looser
 *   3. consumers — dual fetch + dedupe, so a recap arriving BOTH directly and
 *      forwarded appears once (direct copy wins)
 *
 * Contract-lock (house pattern): the detector's forwarded scoring is
 * reimplemented below. If zoom-email-detector.ts changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const detector = read("lib/google/zoom-email-detector.ts");
const summaries = read("lib/google/zoom-summaries.ts");
const poll = read("app/api/events/poll-ingest/route.ts");

test("the forwarded query exists and is never trusted without the detector", () => {
  assert.ok(/export const ZOOM_FORWARDED_GMAIL_QUERY/.test(detector),
    "a forwarded-copy query without the from: restriction must exist");
  assert.ok(/from:\(/.test(detector.slice(detector.indexOf("ZOOM_GMAIL_QUERY ="))),
    "the canonical query keeps its sender restriction — direct mail stays precise");
  // Both consumers of the looser query must gate hits through detectZoomEmail.
  for (const [name, src] of [["zoom-summaries", summaries], ["poll-ingest", poll]]) {
    assert.ok(/ZOOM_FORWARDED_GMAIL_QUERY/.test(src), `${name} must fetch forwarded copies`);
    const after = src.slice(src.indexOf("ZOOM_FORWARDED_GMAIL_QUERY"));
    assert.ok(/detectZoomEmail\(/.test(after),
      `${name} must confirm forwarded hits with the detector — the loose query alone can sweep in non-Zoom mail`);
  }
});

test("forwarded duplicates dedupe against the direct copy, direct wins", () => {
  assert.ok(/stripForwardPrefix/.test(summaries),
    "titles must shed their Fwd:/FW: prefixes");
  assert.ok(/recapKey/.test(summaries) && /seen\.has\(key\)/.test(summaries),
    "the same recap arriving direct AND forwarded must appear once");
  assert.ok(/forwarded by \$\{m\.from\}/.test(summaries),
    "the forwarder must stay visible — who shared it is real context for the model");
});

// ── Contract lock: forwarded detection decision ──────────────────────────────

const SUBJ = [
  /meeting\s+summary/i, /ai\s+companion\s+summary/i, /zoom\s+ai\s+companion/i,
  /smart\s+summary/i, /post[-\s]meeting\s+summary/i,
  /transcript\s+(?:is\s+)?(?:now\s+)?available/i,
  /recording\s+(?:is\s+)?(?:now\s+)?available/i,
  /zoom\s+recording/i, /zoom\s+meeting\s+notes?/i, /\[zoom\]/i,
  /meeting\s+assets?\b/i,
];
const detect = (from, subject, body) => {
  const signals = [];
  if (/@(?:notify\.)?zoom\.us|@zoomgov\.com/i.test(from)) signals.push("domain");
  if (SUBJ.some((p) => p.test(subject))) signals.push("subject");
  const fwd = /^\s*(?:fwd?|fw)\s*:/i.test(subject);
  if (fwd && SUBJ.some((p) => p.test(subject))) signals.push("fwd-subject");
  const preamble = /from:.{0,80}(?:@(?:notify\.)?zoom\.us|zoom\s+ai\s+companion)/i.test(body);
  if (preamble) signals.push("fwd-preamble");
  return signals.includes("domain") || preamble || signals.length >= 2;
};

test("behaviour: forwarded recaps detect, ordinary forwards do not", () => {
  // Ed forwards the AI Companion recap — subject keeps the Zoom phrasing.
  assert.equal(
    detect("Ed Woodcock <ed@analystgenius.ai>",
           "Fwd: Meeting Summary - AnalystGenius Demo",
           "---------- Forwarded message ---------\nFrom: Zoom AI Companion <no-reply@zoom.us>"),
    true, "a forwarded Zoom recap must be detected despite the colleague sender");

  // Forwarder rewrote the subject entirely — the preamble alone must carry it.
  assert.equal(
    detect("Ed Woodcock <ed@analystgenius.ai>",
           "Fwd: notes from yesterday",
           "From: Zoom AI Companion <no-reply@zoom.us>\nMeeting summary follows"),
    true, "the quoted original Zoom sender is near-proof even with a rewritten subject");

  // An ordinary forwarded email must NOT be swept in.
  assert.equal(
    detect("Ed Woodcock <ed@analystgenius.ai>",
           "Fwd: Q3 pricing question",
           "---------- Forwarded message ---------\nFrom: Regina Sobieray <regina@pwc.com>"),
    false, "a normal forward with no Zoom signals stays a normal email");

  // Direct Zoom mail still detects (regression check).
  assert.equal(
    detect("Zoom AI Companion <no-reply@zoom.us>", "Meeting Summary - Weekly Sync", ""),
    true);
});

test("behaviour: real production case — 'meeting assets' subject, retitled forward", () => {
  // Found live 2026-07-29 against michael@talentgenius.io: a colleague forwarded
  // Zoom's "your meeting assets are ready" notification, retitled to name the
  // meeting. It matched NEITHER the base ZOOM_SUBJECT_PATTERNS nor either Gmail
  // query — invisible end-to-end until "meeting assets" was added to all three.
  const REAL_SUBJECT = "Fwd: Meeting assets for social media and buyer campaigns are ready!";
  assert.equal(
    detect("Colleague <colleague@talentgenius.io>", REAL_SUBJECT, ""),
    true,
    "the exact real forwarded subject must now detect as Zoom");

  const ASSETS = /meeting\s+assets?\b/i;
  const FORWARDED_QUERY_PHRASES = /"meeting summary"|"AI Companion"|"Smart Summary"|"meeting recap"|"meeting notes"|"recording available"|"transcript available"|"meeting highlights"|"meeting assets"/;
  const detector = read("lib/google/zoom-email-detector.ts");
  assert.ok(ASSETS.test(detector), "ZOOM_SUBJECT_PATTERNS must include a meeting-assets pattern");
  const query = detector.slice(detector.indexOf("export const ZOOM_GMAIL_QUERY"), detector.indexOf("export const ZOOM_FORWARDED_GMAIL_QUERY"));
  assert.ok(/"meeting assets"/.test(query), "the DIRECT query must also cover meeting-assets — a direct send would have been missed too");
  const fwdQuery = detector.slice(detector.indexOf("export const ZOOM_FORWARDED_GMAIL_QUERY"));
  assert.ok(/"meeting assets"/.test(fwdQuery), "the forwarded query must cover meeting-assets");
});
