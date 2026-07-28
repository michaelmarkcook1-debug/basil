/**
 * tests/loose-reminders.test.mjs
 *
 * Loose text like "follow up with demo attendees two weeks after each demo"
 * must become CONCRETE, DATED actions — not a friendly acknowledgement.
 *
 * The primitives already existed (today's date in the prompt, getCalendarEvents
 * with ranges, addAction with dueDate); what was missing was the WORKFLOW:
 * resolve relative dates, fan out event-anchored rules to one action per
 * matching event, and store standing rules honestly (future events don't
 * auto-generate reminders yet — the model must say so, not imply coverage).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const prompt = read("lib/ai/system-prompt.ts");
const tools = read("lib/ai/tools.ts");

test("the prompt teaches the loose-reminder workflow", () => {
  assert.ok(/## Loose Reminders — Turn Intent Into Dated Actions/.test(prompt),
    "the workflow section must exist");
  assert.ok(/ONCE PER EVENT/.test(prompt),
    "event-anchored rules must fan out to one dated action per matching event");
  assert.ok(/Never create an undated action when a date is stated or implied/.test(prompt),
    "an undated reminder never resurfaces — dates are mandatory when implied");
  assert.ok(/rememberThis/.test(prompt.slice(prompt.indexOf("## Loose Reminders"))),
    "standing rules must be persisted to memory");
  assert.ok(/won't auto-generate/.test(prompt),
    "the model must be HONEST that future events don't auto-generate reminders yet");
});

test("addAction's dueDate description demands resolved relative dates", () => {
  const idx = tools.indexOf("ALWAYS set this when the user states or implies");
  assert.ok(idx > -1, "dueDate must instruct resolving relative phrases to concrete dates");
  assert.ok(/anchoring to the referenced calendar event/.test(tools),
    "event-anchored phrasing must anchor to the event's date, not today");
});
