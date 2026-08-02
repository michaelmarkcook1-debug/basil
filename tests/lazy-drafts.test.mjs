/**
 * tests/lazy-drafts.test.mjs
 *
 * Reply drafts must be written when they are USED, not when mail arrives.
 *
 * poll-ingest used to generate a draft for every draft-disposition event on the
 * FLAGSHIP tier during ingest. Measured on production 2026-08-02, that was
 * $0.96 of a $1.62 idle day — 59%, the largest single line — on a day the owner
 * never opened the app. It is the direct answer to "why is Basil spending money
 * when I'm not using it".
 *
 * It was also largely wasted work: the send path (PATCH /api/events/[id] →
 * executeEvent) accepts a user-EDITED draftBody, so a pre-written body is
 * usually replaced, and no UI surface reads event.draft.body today.
 *
 * The capability is unchanged — only its timing. Generation moved to the moment
 * of use, so a draft that is never used costs nothing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const poll = read("app/api/events/poll-ingest/route.ts");
const executor = read("lib/events/executor.ts");

test("ingest does not speculatively generate drafts by default", () => {
  const at = poll.indexOf("generateDraftForEvent(event, username)");
  assert.ok(at > -1, "the eager path must still exist behind the flag");
  const guard = poll.lastIndexOf("BASIL_PREGENERATE_DRAFTS", at);
  assert.ok(guard > -1 && guard < at,
    "eager generation must sit behind an explicitly opt-in env flag");
  assert.ok(/BASIL_PREGENERATE_DRAFTS === "true"/.test(poll),
    "default must be OFF — only an explicit 'true' re-enables pre-generation");
});

test("skipping pre-generation is logged, not silent", () => {
  assert.ok(/left ungenerated/.test(poll),
    "a behaviour change this size must be visible in the logs");
});

test("the executor generates on demand when a body is missing", () => {
  assert.ok(/generateDraftForEvent/.test(executor),
    "executeEvent must be able to produce a body at the moment of use");
  const at = executor.indexOf("generateDraftForEvent");
  const before = executor.slice(0, at);
  assert.ok(/if \(!resolvedBody/.test(before),
    "on-demand generation must trigger ONLY when no body is already available");
  assert.ok(/draftBody \?\? event\.draft\?\.body/.test(executor),
    "a user-edited body must still win over anything generated");
});

test("a failed on-demand generation never sends an empty message", () => {
  const at = executor.indexOf("generateDraftForEvent");
  const block = executor.slice(at, at + 700);
  assert.ok(/catch/.test(block), "generation failure must be caught");
  assert.ok(/console\.error/.test(block), "and surfaced");
  // The pre-existing empty-body guard must still be reachable after the catch.
  assert.ok(/if \(!resolvedBody\)/.test(executor.slice(at)),
    "the empty-body guard must still run, so a failure returns an error rather than sending nothing");
});
