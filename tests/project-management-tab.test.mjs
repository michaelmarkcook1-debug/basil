/**
 * Linear and AI tools are one menu tab, "Project management", with a toggle.
 * These pin where the tab lands, which pages light it up, and that the old
 * URLs still exist (deep links, Cmd-K and feed items point at them).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const V = loadTs("lib/project-management/views.ts");

test("the tab reopens the view used last, and Linear when there is none", () => {
  assert.equal(V.pmHrefFor("ai-tools"), "/dashboard/ai-projects");
  assert.equal(V.pmHrefFor("linear"), "/dashboard/linear");
  assert.equal(V.pmHrefFor(undefined), "/dashboard/linear");
  assert.equal(V.pmHrefFor("something-else"), "/dashboard/linear");
});

test("both views light up the tab; the separate Projects page does not", () => {
  for (const p of ["/dashboard/project-management", "/dashboard/linear", "/dashboard/ai-projects"]) {
    assert.ok(V.inProjectManagement(p), p);
  }
  for (const p of ["/dashboard/projects", "/dashboard", "/dashboard/linear-ish"]) {
    assert.ok(!V.inProjectManagement(p), p);
  }
});

test("the old URLs survive: both pages sit in a route group under one layout", () => {
  const group = resolve(ROOT, "app/dashboard/(project-management)");
  assert.ok(existsSync(resolve(group, "layout.tsx")));
  assert.ok(existsSync(resolve(group, "linear/page.tsx")));
  assert.ok(existsSync(resolve(group, "ai-projects/page.tsx")));
});

test("the menu has one Project management entry, not separate Linear and AI Tools", () => {
  const nav = readFileSync(resolve(ROOT, "components/app-sidebar.tsx"), "utf8");
  assert.ok(/label: "Project management"/.test(nav));
  assert.ok(!/label: "Linear"/.test(nav) && !/label: "AI Tools"/.test(nav));
});
