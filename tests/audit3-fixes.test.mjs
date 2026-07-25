/**
 * tests/audit3-fixes.test.mjs
 *
 * Guards the fixes from the 2026-07-23 full audit.
 *
 * The headline one is `apiFetchTargetsExist`: a component fetched "/api/contacts",
 * which has no route.ts (only sub-routes), so it 404'd on every load. The failure
 * was invisible — the widget just read "Loading contacts…" forever. A typo'd
 * fetch path is a whole bug CLASS that nothing else in the suite catches, so
 * this test enumerates every literal /api/... fetch in the app and asserts a
 * matching route exists.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

/** Recursively collect files under dir matching a predicate. */
function walk(dir, pred, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

test("every literal /api/... fetch target has a route that exists", () => {
  const sources = walk(resolve(ROOT, "app"), (f) => /\.(tsx?|jsx?)$/.test(f))
    .concat(walk(resolve(ROOT, "components"), (f) => /\.(tsx?|jsx?)$/.test(f)));

  const bad = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    // Only LITERAL paths — skip anything with a template placeholder, since a
    // dynamic segment can't be resolved statically.
    for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[^"'`?]*)["'`?]/g)) {
      const path = m[1].replace(/\/$/, "");
      if (path.includes("${")) continue;
      const routeFile = resolve(ROOT, "app" + path, "route.ts");
      if (existsSync(routeFile)) continue;
      // A dynamic sibling ([id]) can legitimately serve this path.
      const parent = resolve(ROOT, "app" + path, "..");
      let dynamicMatch = false;
      try {
        dynamicMatch = readdirSync(parent).some(
          (d) => d.startsWith("[") && existsSync(join(parent, d, "route.ts"))
        );
      } catch { /* parent may not exist — that's the bug we're reporting */ }
      if (!dynamicMatch) bad.push(`${file.replace(ROOT + "/", "")} → ${path}`);
    }
  }

  assert.deepEqual(bad, [], `fetch() targets with no matching API route:\n  ${bad.join("\n  ")}`);
});

test("cron routes all fail CLOSED when CRON_SECRET is unset", () => {
  const dir = resolve(ROOT, "app/api/cron");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "route.ts");
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    assert.ok(
      /!cronSecret\s*\|\|/.test(src),
      `${name}: must guard on !cronSecret — without it an unset secret makes the ` +
      `comparison "Bearer undefined", which any caller can send`
    );
  }
});

test("the QStash job handler fails closed in production", () => {
  const src = read("app/api/jobs/handler/route.ts");
  assert.ok(
    /else if \(process\.env\.NODE_ENV === "production"\)/.test(src),
    "with no signing keys, production must 403 — never fall through to a client-supplied Host check"
  );
});

test("zoom is not locked (WCAG 1.4.4) and the warning banner is legible", () => {
  const layout = read("app/layout.tsx");
  assert.ok(!/maximumScale:\s*1/.test(layout) && !/userScalable:\s*false/.test(layout),
    "layout must not disable pinch-zoom — inputs are already 16px so it buys nothing");
  // Match the live className only (className="…"), not prose in comments that
  // quotes the old broken value for context.
  const memory = read("app/dashboard/memory/page.tsx");
  const classNames = [...memory.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
  // NB: `\b` would also match the -subtle/-border variants (a hyphen counts as a
  // word boundary), so exclude any trailing segment explicitly. Only the SOLID
  // bg paired with the SOLID text is the invisible case.
  const invisible = classNames.filter(
    (c) => /bg-signal-warning(?![-\w])/.test(c) && /text-signal-warning(?![-\w])/.test(c)
  );
  assert.deepEqual(invisible, [],
    "same token for bg and text = 1:1 contrast (invisible banner)");
});

test("a failed legacy import never deletes the only local copy", () => {
  const src = read("app/dashboard/actions/page.tsx");
  // Anchor on the destructive call itself, and look at the code ABOVE it.
  const idx = src.indexOf("removeItem(LEGACY_STORAGE_KEY)");
  assert.ok(idx > -1, "expected the legacy-import cleanup to exist");
  const block = src.slice(Math.max(0, idx - 1200), idx);
  assert.ok(/if \(!res\.ok\)/.test(block),
    "must check res.ok before removeItem — fetch() does not reject on 5xx, so a " +
    "failed import was permanently destroying every legacy action");
});

// ── Silent failure: an outage must never render as "you have nothing to do" ──
// This is the highest-severity class in the audit. For an assistant whose job is
// "I'll tell you what needs you", a failure that REASSURES is the one failure
// the user would never think to retry.

test("an upstream Linear failure surfaces as an error, not an empty backlog", () => {
  const client = read("lib/linear/client.ts");
  const idx = client.indexOf("[linear] getAllIssues error:");
  assert.ok(idx > -1, "expected the getAllIssues catch block");
  const block = client.slice(idx, idx + 200);
  assert.ok(/throw /.test(block) && !/return \[\]/.test(block),
    "getAllIssues must rethrow — returning [] made an outage indistinguishable from an empty backlog");

  const route = read("app/api/linear/issues/route.ts");
  assert.ok(/status: 502/.test(route),
    "the route must answer 502 on upstream failure so the page's !res.ok branch is reachable");
});

test("the Linear AI tool never reports an outage as 'no issues'", () => {
  const tools = read("lib/ai/tools.ts");
  const catches = [...tools.matchAll(/Couldn't reach Linear/g)];
  assert.ok(catches.length >= 2,
    "both getAllIssues call sites in the AI tools must catch and tell the model the list is UNKNOWN, " +
    "otherwise Ask Basil states the backlog is empty during a Linear outage");
});

test("the home feed fetcher throws, and a failed feed is not an all-clear", () => {
  const page = read("app/dashboard/page.tsx");
  assert.ok(!/r\.ok \? r\.json\(\) : null/.test(page),
    "swrFetch must not swallow the status — SWR then never errors and the page claims 'All clear'");
  assert.ok(/if \(!r\.ok\) throw/.test(page), "swrFetch must throw on a bad response");
  assert.ok(/error: feedError/.test(page), "the page must read SWR's error for the feed");
  assert.ok(/!isLoading && !feedError && totalNeeds === 0/.test(page),
    "the 'Nothing needs you' empty state must be gated on there being no error");
});

test("mode-intelligence does not double-count high-priority actions", () => {
  const src = read("components/ui/mode-intelligence.tsx");
  assert.ok(!/stats\.critical \+ stats\.high/.test(src),
    "critical and high were identical filters; summing them reported 2x the real count");
  assert.ok(!/:\s*"Loading (commitments|inbox|contacts)…"/.test(src),
    "the null-stats branch runs AFTER loading is false — saying 'Loading' there is a lie");
});
