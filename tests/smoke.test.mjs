/**
 * smoke.test.mjs — Basil backend smoke tests.
 *
 * Checks that the repo structure and CI configuration are intact.
 * Runs via: npm test  (node --test)
 *
 * Failures here mean a route, directory, or CI workflow has gone missing
 * or been reduced to a placeholder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

function pkg() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

function getWorkflowFiles() {
  const dir = join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({
      name: f,
      path: join(dir, f),
      content: readFileSync(join(dir, f), "utf8"),
    }));
}

// ── package.json scripts ──────────────────────────────────────────────────────

test("package.json has a build script", () => {
  const scripts = pkg().scripts ?? {};
  assert.ok(
    typeof scripts.build === "string" && scripts.build.trim().length > 0,
    'package.json is missing a "build" script'
  );
});

test("package.json has a lint script", () => {
  const scripts = pkg().scripts ?? {};
  assert.ok(
    typeof scripts.lint === "string" && scripts.lint.trim().length > 0,
    'package.json is missing a "lint" script'
  );
});

test("package.json has a typecheck script", () => {
  const scripts = pkg().scripts ?? {};
  assert.ok(
    typeof scripts.typecheck === "string" && scripts.typecheck.trim().length > 0,
    'package.json is missing a "typecheck" script'
  );
});

test("package.json has a ci:guards script", () => {
  const scripts = pkg().scripts ?? {};
  assert.ok(
    typeof scripts["ci:guards"] === "string" && scripts["ci:guards"].trim().length > 0,
    'package.json is missing a "ci:guards" script'
  );
});

// ── Directory structure ───────────────────────────────────────────────────────

test("app directory exists", () => {
  assert.ok(existsSync(join(ROOT, "app")), "app/ directory is missing");
});

test("lib directory exists", () => {
  assert.ok(existsSync(join(ROOT, "lib")), "lib/ directory is missing");
});

test("app/api directory exists", () => {
  assert.ok(existsSync(join(ROOT, "app", "api")), "app/api/ directory is missing");
});

// ── Key routes ────────────────────────────────────────────────────────────────

test("app/api/health route exists — Missing /api/health route", () => {
  assert.ok(
    existsSync(join(ROOT, "app", "api", "health")),
    "Missing /api/health route — create app/api/health/route.ts"
  );
});

test("app/api/contacts/user route exists", () => {
  assert.ok(
    existsSync(join(ROOT, "app", "api", "contacts", "user")),
    "app/api/contacts/user route is missing"
  );
});

test("app/api/integrations/linear route exists", () => {
  assert.ok(
    existsSync(join(ROOT, "app", "api", "integrations", "linear")),
    "app/api/integrations/linear route is missing"
  );
});

// ── CI workflow integrity ─────────────────────────────────────────────────────

test("at least one GitHub Actions workflow file exists", () => {
  const files = getWorkflowFiles();
  assert.ok(files.length > 0, "No workflow files found in .github/workflows/");
});

test("no workflow file is a placeholder (only echoes Hello World)", () => {
  const files = getWorkflowFiles();
  assert.ok(files.length > 0, "No workflow files to check");

  for (const { name, content } of files) {
    // Collect all inline run: values (single-line form).
    const inlineRunLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("run:"));

    for (const line of inlineRunLines) {
      const cmd = line.replace(/^run:\s*/, "").trim();
      assert.ok(
        !/^echo\s+['"]?Hello,?\s*world['"]?!?$/i.test(cmd),
        `${name}: workflow step is a Hello World placeholder — "run: ${cmd}" does nothing useful`
      );
    }

    // If every single run: line is a Hello World echo, the whole workflow is fake.
    if (inlineRunLines.length > 0) {
      const allPlaceholder = inlineRunLines.every((line) => {
        const cmd = line.replace(/^run:\s*/, "").trim();
        return /^echo\s+['"]?Hello,?\s*world['"]?!?$/i.test(cmd);
      });
      assert.ok(
        !allPlaceholder,
        `${name}: every workflow run step is a Hello World placeholder — CI is not real`
      );
    }
  }
});

test("primary CI workflow runs real checks (build, lint)", () => {
  const dir = join(ROOT, ".github", "workflows");
  const candidates = ["basil-ci.yml", "ci.yml"];
  const found = candidates.find((f) => existsSync(join(dir, f)));

  assert.ok(found, `No CI workflow found — expected one of: ${candidates.join(", ")}`);

  const content = readFileSync(join(dir, found), "utf8");

  assert.ok(
    content.includes("npm run build") || content.includes("npm ci") || content.includes("npm install"),
    `${found}: workflow does not appear to run a real build or install step`
  );

  assert.ok(
    content.includes("npm run lint") || content.includes("eslint"),
    `${found}: workflow does not appear to run a lint step`
  );
});
