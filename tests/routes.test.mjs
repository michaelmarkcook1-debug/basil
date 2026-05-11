/**
 * routes.test.mjs — Basil API route existence tests.
 *
 * Catches missing or renamed route files before they reach production.
 * A missing route.ts means the path returns 404 at runtime; CI should
 * catch that before deployment.
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when a Next.js route handler file exists at the given API path. */
function routeExists(apiPath) {
  // apiPath is relative to app/, e.g. "api/health"
  return existsSync(join(ROOT, "app", apiPath, "route.ts")) ||
         existsSync(join(ROOT, "app", apiPath, "route.js"));
}

/**
 * Recursively collect all source files under a directory.
 * Returns absolute paths. Ignores node_modules, .next, dist.
 */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

function* walkSource(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Search app/ and components/ source files for a literal string.
 * Returns an array of { file, line, text } matches.
 */
function grepSource(needle) {
  const hits = [];
  for (const dir of ["app", "components"]) {
    for (const file of walkSource(join(ROOT, dir))) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle)) {
          hits.push({
            file: relative(ROOT, file),
            line: i + 1,
            text: lines[i].trim(),
          });
        }
      }
    }
  }
  return hits;
}

// ── Critical routes — must always exist ──────────────────────────────────────

test("app/api/health/route.ts exists", () => {
  assert.ok(
    routeExists("api/health"),
    "Missing /api/health route — create app/api/health/route.ts"
  );
});

test("app/api/whatsapp/status/route.ts exists", () => {
  assert.ok(
    routeExists("api/whatsapp/status"),
    "Missing /api/whatsapp/status route — create app/api/whatsapp/status/route.ts"
  );
});

test("app/api/whatsapp/import-contacts/route.ts exists", () => {
  assert.ok(
    routeExists("api/whatsapp/import-contacts"),
    "Missing /api/whatsapp/import-contacts route — create app/api/whatsapp/import-contacts/route.ts"
  );
});

// ── Ledger routes ─────────────────────────────────────────────────────────────

test("app/api/ledger/route.ts exists", () => {
  assert.ok(
    routeExists("api/ledger"),
    "Missing /api/ledger route — create app/api/ledger/route.ts"
  );
});

test("app/api/ledger/convert/route.ts exists", () => {
  assert.ok(
    routeExists("api/ledger/convert"),
    "Missing /api/ledger/convert route — create app/api/ledger/convert/route.ts"
  );
});

// ── Settings readiness route ──────────────────────────────────────────────────

test("app/api/settings/readiness/route.ts exists", () => {
  assert.ok(
    routeExists("api/settings/readiness"),
    "Missing /api/settings/readiness route — create app/api/settings/readiness/route.ts"
  );
});

// ── Stig slack-command route ──────────────────────────────────────────────────

test("app/api/stig/slack-command/route.ts exists", () => {
  assert.ok(
    routeExists("api/stig/slack-command"),
    "Missing /api/stig/slack-command route — create app/api/stig/slack-command/route.ts"
  );
});

// ── Linear integration routing ────────────────────────────────────────────────
//
// At least one of the canonical paths must exist. If the UI specifically
// references /api/integrations/linear, that exact path must have a handler
// (the fallback app/api/linear/route.ts is not sufficient in that case).

test("at least one Linear route handler exists", () => {
  const primary   = routeExists("api/integrations/linear");
  const secondary = routeExists("api/linear");

  assert.ok(
    primary || secondary,
    "No Linear route handler found — expected app/api/integrations/linear/route.ts " +
    "or app/api/linear/route.ts"
  );
});

test("if UI calls /api/integrations/linear, the route handler must exist", () => {
  const uiRefs = grepSource("/api/integrations/linear");

  if (uiRefs.length === 0) {
    // No UI references to this path — nothing to enforce.
    return;
  }

  const exists = routeExists("api/integrations/linear");

  if (!exists) {
    const locations = uiRefs
      .slice(0, 5)
      .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
      .join("\n");

    assert.fail(
      `UI references /api/integrations/linear in ${uiRefs.length} place(s) ` +
      `but app/api/integrations/linear/route.ts does not exist.\n` +
      `References found:\n${locations}`
    );
  }
});

// ── No route handler is an empty file ─────────────────────────────────────────
//
// An empty route.ts builds fine but returns 404 for every method. Catch it
// early — a real handler must export at least one HTTP method function.

const CRITICAL_ROUTES = [
  "api/health",
  "api/whatsapp/status",
  "api/whatsapp/import-contacts",
  "api/integrations/linear",
  "api/ledger",
  "api/ledger/convert",
  "api/settings/readiness",
  "api/stig/slack-command",
];

for (const apiPath of CRITICAL_ROUTES) {
  test(`${apiPath}/route.ts exports at least one HTTP method`, () => {
    const tsPath = join(ROOT, "app", apiPath, "route.ts");
    const jsPath = join(ROOT, "app", apiPath, "route.js");
    const file   = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null;

    if (!file) {
      // Route doesn't exist at all — the existence tests above already cover this.
      // Skip rather than double-fail so the output stays readable.
      return;
    }

    const content = readFileSync(file, "utf8");

    // Must export at least one of GET POST PUT PATCH DELETE HEAD OPTIONS
    const hasExport = /export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(content);

    assert.ok(
      hasExport,
      `${apiPath}/route.ts exists but does not export any HTTP method handler (GET, POST, …)`
    );
  });
}
