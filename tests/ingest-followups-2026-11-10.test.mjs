// Three loose ends the ingestion reliability pass (2026-11-10) found outside
// its list: Teams ingest still fired and forgot its writes, Zoom ingest still
// checked then created (two runs could file one meeting twice), and Linear's
// connect route orphaned a webhook at Linear on every reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("Teams ingest waits for its ingest record and audit entries before the step ends", () => {
  const s = src("lib/jobs/workflows/ingest-teams.ts");
  assert.doesNotMatch(s, /void (recordIngest|appendAuditEntries)\(/);
  assert.equal((s.match(/await (recordIngest|appendAuditEntries)\(/g) ?? []).length, 4);
});

test("Zoom ingest checks and creates the meeting's event under one lock", () => {
  const s = src("lib/jobs/workflows/ingest-zoom.ts");
  assert.match(s, /const \{ created, event \} = await createEventIfNew\(username, shaped\);/);
  assert.match(s, /if \(created\) publish\(event\);/, "a meeting already filed is not announced again");
  assert.doesNotMatch(s, /await createEvent\(username/);
});

test("Linear connect keeps the existing webhook, and removes it only for a different workspace", () => {
  const s = src("app/api/auth/linear/route.ts");
  assert.match(s, /const next = \{ \.\.\.existing, apiKey, organizationId \};/);
  assert.match(s, /existing\.organizationId !== organizationId\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*await unregisterLinearWebhook\(username, existing\.webhookId\);/);
  assert.match(s, /let webhookRegistered = !!\(next\.webhookId && next\.webhookSecret\);\s*if \(!webhookRegistered\)/);
  assert.doesNotMatch(s, /saveLinearConfig\(username, \{ apiKey, organizationId \}\)/, "no longer overwrites the stored webhook");
});

test("Linear: clearing an issue's assignee or due date is accepted (null), not refused with a 400", () => {
  const s = src("app/api/linear/issues/[id]/route.ts");
  assert.match(s, /assigneeId: z\.string\(\)\.nullable\(\)\.optional\(\)/);
  assert.match(s, /dueDate: z\.string\(\)\.nullable\(\)\.optional\(\)/);
});
