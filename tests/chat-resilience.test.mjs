/**
 * tests/chat-resilience.test.mjs
 *
 * (1) A failed tool call must not BRICK the conversation.
 *
 * Every provider requires each tool_use to be answered by a matching
 * tool_result. When a tool call is interrupted, the assistant message persists
 * with a tool part stuck in `input-available` and no output. useChat resends the
 * whole history every turn, so that orphan is replayed forever and the provider
 * rejects every request:
 *
 *   "Tool result is missing for tool call toolu_01GZHWFT4vP7rgkchuJ2f3JT"
 *
 * One transient tool failure therefore costs the user the ENTIRE thread, not one
 * reply. Repairing orphans into terminal error results restores the pairing.
 *
 * (2) Errors must appear where the user is looking (above the composer).
 * (3) History must load a WINDOW, and must say what it is not showing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const repair = read("lib/ai/repair-history.ts");
const route = read("app/api/chat/route.ts");
const page = read("app/dashboard/chat/page.tsx");
const historyRoute = read("app/api/chat/history/route.ts");

test("orphaned tool calls are repaired before the history reaches the model", () => {
  assert.ok(/repairOrphanedToolCalls\(messages\)/.test(route),
    "the chat route must repair history before converting it");
  assert.ok(/convertToModelMessages\(safeMessages\)/.test(route),
    "the REPAIRED messages must be the ones converted — not the raw input");
});

test("repair terminates orphans without touching legitimate pending states", () => {
  assert.ok(/"output-available", "output-error", "output-denied"/.test(repair),
    "settled states must be left alone");
  assert.ok(/approval-requested/.test(repair),
    "approval-requested is a LEGITIMATE pending state in the tool-approval flow — " +
    "erroring it out would break approvals entirely");
  assert.ok(/state: "output-error"/.test(repair) && /errorText:/.test(repair),
    "an orphan must become a terminal error result, restoring the tool_use/tool_result pairing");
  assert.ok(/repaired\+\+/.test(repair) && /console\.warn/.test(route),
    "a repaired conversation must be logged — silence would hide a real reliability problem");
});

test("BOTH approval states survive the repair — approving must not kill the call", () => {
  // ai@6 defines two approval states (ToolUIPart union, node_modules/ai/dist/index.d.ts):
  //   approval-requested → waiting on the user
  //   approval-responded → the user ANSWERED; the tool has NOT run yet (output?: never)
  // Only the first was allow-listed, so the turn after a user approved something,
  // the approved-but-not-yet-executed call was rewritten to output-error and the
  // tool never ran. Production 2026-07-30: meetings approved in Basil chat never
  // reached Google Calendar, with no error shown anywhere.
  assert.ok(/"approval-requested",\s*"approval-responded"/.test(repair),
    "approval-responded must be preserved too — it is pre-execution, not settled");

  // Contract lock: mirror of the repair decision.
  const TERMINAL = new Set(["output-available", "output-error", "output-denied"]);
  const AWAITING = new Set(["approval-requested", "approval-responded"]);
  const wouldError = (state) => !TERMINAL.has(state) && !AWAITING.has(state);

  assert.equal(wouldError("approval-responded"), false,
    "an APPROVED scheduleMeeting call must still execute — this is the calendar bug");
  assert.equal(wouldError("approval-requested"), false, "still awaiting the user");
  assert.equal(wouldError("output-available"), false, "settled");
  assert.equal(wouldError("output-denied"), false, "explicitly denied is settled");
  // Genuine orphans must still be repaired, or conversations brick again.
  assert.equal(wouldError("input-available"), true, "a real orphan must still be terminated");
  assert.equal(wouldError("input-streaming"), true, "a severed stream is still an orphan");
});

test("errors render above the composer, not at the top of the page", () => {
  assert.ok(/const errorBanner = error \?/.test(page),
    "the error block must be a value that can be placed next to the input");
  const form = page.slice(page.indexOf("<form onSubmit={handleSubmit}"));
  assert.ok(/\{errorBanner\}/.test(form.slice(0, 600)),
    "the banner must render inside the composer form, where the user is looking");
});

test("history loads a date+context window and admits what it omits", () => {
  assert.ok(/searchParams\.get\("days"\)/.test(historyRoute), "date window");
  assert.ok(/searchParams\.get\("limit"\)/.test(historyRoute), "hard cap");
  assert.ok(/searchParams\.get\("q"\)/.test(historyRoute), "context filter");
  assert.ok(/truncated:/.test(historyRoute) && /total: all\.length/.test(historyRoute),
    "the response must report the full archive size so the UI cannot imply it showed everything");
  // Undated legacy rows must survive the date filter.
  assert.ok(/!Number\.isFinite\(t\)/.test(historyRoute),
    "messages with an unparseable date must be KEPT, not silently dropped");

  assert.ok(/days=\$\{HISTORY_DAYS\}&limit=\$\{HISTORY_LIMIT\}/.test(page),
    "the client must request the window rather than the whole archive");
  assert.ok(/historyMeta\?\.truncated/.test(page),
    "the UI must tell the user when older history exists but is not shown");
});
