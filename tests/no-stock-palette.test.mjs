/**
 * tests/no-stock-palette.test.mjs
 *
 * Regression guard for the Phase 4 design-token sweep: dashboard UI must use
 * the semantic signal tokens (bg-signal-critical, text-signal-warning,
 * border-signal-positive-border, …) and the single gold (bg-gold/text-gold),
 * never raw stock-palette utilities in the four signal hue families. Raw
 * palette classes render light-mode pastels that break on the dark theme and
 * reintroduce "badge soup".
 *
 * Scope: app/dashboard/** and components/** (.tsx). The auth pages and email
 * templates have their own systems and are out of scope. Neutral grays
 * (stone/slate/gray/zinc) are not yet banned — they get a separate pass.
 *
 * Escape hatch: annotate the line with  // ci-ok: <reason>
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

const BANNED = /\b(?:hover:|focus:|dark:)?(?:bg|text|border|ring)-(?:red|rose|amber|yellow|orange|emerald|green|teal|blue|sky|violet|purple)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(p, files);
    } else if (p.endsWith(".tsx")) {
      files.push(p);
    }
  }
  return files;
}

test("no stock signal-hue palette classes in dashboard/components", () => {
  const files = [...walk(resolve(ROOT, "app/dashboard")), ...walk(resolve(ROOT, "components"))];
  const violations = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (BANNED.test(line) && !/\/\/\s*ci-ok\b/.test(line)) {
        violations.push(`${f.replace(ROOT + "/", "")}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.equal(
    violations.length,
    0,
    `Stock palette classes found — use signal tokens (bg-signal-critical-subtle, text-signal-warning, …) instead:\n` +
      violations.slice(0, 20).join("\n")
  );
});
