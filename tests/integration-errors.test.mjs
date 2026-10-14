/**
 * Two production errors found in the 2026-10-14 audit, pinned.
 *  - Linear answered 400 to every activity query since June: the date filter
 *    takes DateTimeOrDuration, and a variable declared DateTime! fails
 *    validation before the query runs.
 *  - OpenAI retired the Assistants API; its 404 is "nothing to show", not an
 *    error to log on every AI Tools load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

test("Linear's updatedAt filter variable is DateTimeOrDuration", () => {
  const src = fs.readFileSync(new URL("../lib/linear/client.ts", import.meta.url), "utf8");
  assert.match(src, /query RecentTeamIssues\(\$updatedAfter: DateTimeOrDuration!\)/);
  assert.doesNotMatch(src, /\$updatedAfter: DateTime!/);
});

test("the retired OpenAI Assistants API returns no projects and logs nothing", async () => {
  const noop = () => "";
  const M = loadTs("lib/ai-projects/platforms/openai.ts", { "../classifier": { classifyCategory: noop, scoreImportance: () => 0, generateSummary: noop } }, {}, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(" "));
  try {
    const out = await M.fetchOpenAIProjects("sk-test");
    assert.equal(out.length, 0);
    assert.equal(errors.length, 0, "a 404 is not logged as an error");
  } finally { console.error = orig; }
});
