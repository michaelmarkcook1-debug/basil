/**
 * tests/linear-route-consistency.test.mjs
 *
 * Prevents the UI from calling a Linear API route that doesn't exist.
 *
 * The bug this guards against: a client component calls /api/integrations/linear
 * but only /api/linear is wired up (or vice versa), resulting in silent 404s.
 *
 * How it works
 * ────────────
 * 1. Walk every client-side TypeScript / TSX file (app/** except app/api/**,
 *    and lib/**) looking for string literals that contain a Linear API path.
 * 2. Extract each unique route.
 * 3. Derive the expected Next.js route file:
 *      /api/foo/bar  →  app/api/foo/bar/route.ts  (or route.tsx)
 * 4. Assert the file exists.  If it doesn't, the test fails with the exact
 *    calling file and line number so the developer knows what to fix.
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Route prefix patterns to track.  Any string literal in client code that
 * matches one of these prefixes is treated as a route call that must have a
 * corresponding Next.js route file.
 */
const TRACKED_PREFIXES = [
  "/api/linear",
  "/api/integrations/linear",
  "/api/auth/linear",
];

/** Source roots to scan (client-side code only). */
const SCAN_ROOTS = [
  join(ROOT, "app"),
  join(ROOT, "lib"),
];

/** Directories to skip entirely. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  // Skip the API route files themselves — they DEFINE routes, not call them.
  "app/api",
]);

/** File extensions to scan. */
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

// ── File walker ────────────────────────────────────────────────────────────────

/**
 * Recursively collect all scannable files, skipping SKIP_DIRS.
 * `root` is an absolute path; returns absolute file paths.
 */
function collectFiles(dir, rootForSkip = ROOT) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel  = relative(rootForSkip, full);
    // Skip if any path component is in SKIP_DIRS.
    if ([...SKIP_DIRS].some((skip) => rel === skip || rel.startsWith(skip + "/"))) {
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFiles(full, rootForSkip));
    } else if (st.isFile() && SCAN_EXTS.has(full.slice(full.lastIndexOf(".")))) {
      results.push(full);
    }
  }
  return results;
}

// ── Route extractor ────────────────────────────────────────────────────────────

/**
 * Extract every occurrence of a tracked route from `source`.
 *
 * Matches string literals (single-quote, double-quote, template literal)
 * that start with one of the TRACKED_PREFIXES.  The route ends at the
 * matching quote, a template-literal `${}` interpolation, or a `?` query.
 *
 * Returns an array of { route, line } objects.
 */
function extractRoutes(source) {
  const hits = [];
  // Match: "  or '  or `  followed by /api/...linear..., capturing until
  // the closing quote / interpolation / query string.
  const re = /["'`](\/api\/[a-zA-Z0-9/_-]+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const route = m[1];
    if (TRACKED_PREFIXES.some((p) => route === p || route.startsWith(p + "/") || route.startsWith(p + "?"))) {
      // Strip any query string so the route maps cleanly to a file path.
      const cleanRoute = route.split("?")[0];
      // Calculate line number (1-based).
      const line = source.slice(0, m.index).split("\n").length;
      hits.push({ route: cleanRoute, line });
    }
  }
  return hits;
}

/**
 * Map a route like "/api/foo/bar" to the expected Next.js route file path.
 * Tries both .ts and .tsx extensions.
 */
function routeToFile(route) {
  // Remove leading slash and build the path under app/api/.
  const rel = route.replace(/^\//, "");           // "api/foo/bar"
  const ts  = join(ROOT, "app", rel, "route.ts");
  const tsx = join(ROOT, "app", rel, "route.tsx");
  return { ts, tsx };
}

// ── Scan ───────────────────────────────────────────────────────────────────────

/**
 * Map of route → [{ file, line }, ...] for every Linear route call found in
 * client source files.  Built once at module load so tests can share it.
 */
const routeCallSites = new Map(); // route → [{ file: relative path, line }]

for (const root of SCAN_ROOTS) {
  for (const absFile of collectFiles(root)) {
    const relFile = relative(ROOT, absFile);
    let source;
    try {
      source = readFileSync(absFile, "utf8");
    } catch {
      continue;
    }
    for (const { route, line } of extractRoutes(source)) {
      if (!routeCallSites.has(route)) routeCallSites.set(route, []);
      routeCallSites.get(route).push({ file: relFile, line });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Pretty-print call sites for a route in assertion messages. */
function callSitesSummary(route) {
  const sites = routeCallSites.get(route) ?? [];
  return sites
    .map(({ file, line }) => `  ${file}:${line}`)
    .join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── 1. Sanity: the scanner found calls for the known routes ───────────────────

test("scanner finds client calls to /api/integrations/linear", () => {
  assert.ok(
    routeCallSites.has("/api/integrations/linear"),
    "Expected to find at least one client call to /api/integrations/linear — " +
    "did the scanner skip the file or did the route get renamed?"
  );
});

test("scanner finds client calls to /api/linear", () => {
  assert.ok(
    routeCallSites.has("/api/linear"),
    "Expected to find at least one client call to /api/linear — " +
    "did the scanner skip the file or did the route get renamed?"
  );
});

test("scanner finds client calls to /api/auth/linear", () => {
  assert.ok(
    routeCallSites.has("/api/auth/linear"),
    "Expected to find at least one client call to /api/auth/linear — " +
    "did the scanner skip the file or did the route get renamed?"
  );
});

// ── 2. Every called route has a corresponding route file ─────────────────────

for (const route of TRACKED_PREFIXES) {
  test(`route file exists for every client call to ${route}`, () => {
    // If no code calls this route, the test trivially passes — the sanity
    // tests above will have already caught a missing call for known routes.
    const sites = routeCallSites.get(route);
    if (!sites || sites.length === 0) return;

    const { ts, tsx } = routeToFile(route);
    const exists = existsSync(ts) || existsSync(tsx);
    assert.ok(
      exists,
      `Route ${route} is called by client code but no route file exists.\n` +
      `Expected one of:\n  ${relative(ROOT, ts)}\n  ${relative(ROOT, tsx)}\n` +
      `Called from:\n${callSitesSummary(route)}`
    );
  });
}

// ── 3. Cross-check: no Linear route file is orphaned (has a file but no call) ─

test("app/api/linear/route.ts is actually called by client code", () => {
  const routeFile = join(ROOT, "app", "api", "linear", "route.ts");
  if (!existsSync(routeFile)) return; // If the file doesn't exist, skip.

  assert.ok(
    routeCallSites.has("/api/linear"),
    "app/api/linear/route.ts exists but no client code calls /api/linear — " +
    "the route may be dead code (route or call renamed without updating the other)"
  );
});

test("app/api/integrations/linear/route.ts is actually called by client code", () => {
  const routeFile = join(ROOT, "app", "api", "integrations", "linear", "route.ts");
  if (!existsSync(routeFile)) return;

  assert.ok(
    routeCallSites.has("/api/integrations/linear"),
    "app/api/integrations/linear/route.ts exists but no client code calls /api/integrations/linear — " +
    "the route may be dead code or the call was renamed"
  );
});

test("app/api/auth/linear/route.ts is actually called by client code", () => {
  const routeFile = join(ROOT, "app", "api", "auth", "linear", "route.ts");
  if (!existsSync(routeFile)) return;

  assert.ok(
    routeCallSites.has("/api/auth/linear"),
    "app/api/auth/linear/route.ts exists but no client code calls /api/auth/linear — " +
    "the route may be dead code or the call was renamed"
  );
});

// ── 4. Call-site inventory (informational, always passes) ────────────────────
//
// Prints which files call which routes so the test output doubles as
// documentation.  Uses a sub-test so it shows up in verbose mode.

test("call-site inventory (all Linear routes)", (t) => {
  for (const [route, sites] of [...routeCallSites.entries()].sort()) {
    for (const { file, line } of sites) {
      t.diagnostic(`${route}  ←  ${file}:${line}`);
    }
  }
});
