/**
 * tests/wire-class-hygiene.test.mjs
 *
 * Two defects the Wire Desk rebuild shipped to production on 2026-08-15, both
 * invisible to typecheck, tests and the build.
 *
 * 1. MALFORMED ARBITRARY VALUES. Fifteen classNames were written
 *    `bg-[var(--w-carbon-tint)]]` — one bracket too many. Tailwind generates no
 *    rule for the malformed candidate, and the DOM token does not match the
 *    correct-form rule either (class matching is exact on whitespace-delimited
 *    tokens), so every one of those fills rendered as NO background. Selected
 *    states, cards and badges across six surfaces silently lost their fill.
 *    Nothing catches this: it is valid TSX, valid JSX, and a clean build.
 *
 * 2. PAPER INK ON DARK CHROME. The mobile top bar is `bg-sidebar` (#0B131F)
 *    while the app is pinned to the dark theme, but the wordmark was painted in
 *    `--w-carbon` (#35346B) — a token from the LIGHT paper world. That is
 *    1.65:1, far under WCAG's 4.5:1, on the surface a PWA user sees most.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
}

const SOURCES = [...walk(resolve(ROOT, "app")), ...walk(resolve(ROOT, "components"))];

test("no Tailwind arbitrary value carries a stray closing bracket", () => {
  // `-[var(--x)]]` and `-[#abc]]` are the shapes seen in the wild. Both are
  // unambiguous: a utility's arbitrary value followed by an extra `]`.
  const BAD = /[a-z-]\[(?:var\([^)]*\)|#[0-9a-fA-F]{3,8}|[0-9]+(?:px|rem|%))\]\]/g;
  const hits = [];
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(BAD)) {
      const line = src.slice(0, m.index).split("\n").length;
      hits.push(`${file.replace(ROOT + "/", "")}:${line}  ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [],
    "these classes generate no CSS and render as nothing — the build stays green while the fill disappears:\n" +
    hits.join("\n"));
});

test("the dark chrome does not paint itself with paper-world tokens", () => {
  // `.wire` is a LIGHT ground. The sidebar and mobile bar are dark chrome
  // (bg-sidebar / bg-background under the forced dark theme), so any --w- ink or
  // tint used there is being read against the wrong background by construction.
  const layout = readFileSync(resolve(ROOT, "app/dashboard/layout.tsx"), "utf8");
  const paperTokens = [...layout.matchAll(/--w-[a-z-]+/g)].map((m) => m[0]);
  assert.deepEqual(paperTokens, [],
    `the dashboard shell paints dark chrome with light-paper tokens (${[...new Set(paperTokens)].join(", ")}); ` +
    "carbon #35346B on sidebar #0B131F is 1.65:1 and the wordmark disappears");
});

test("the wordmark uses a foreground token that reads on its own background", () => {
  const layout = readFileSync(resolve(ROOT, "app/dashboard/layout.tsx"), "utf8");
  assert.ok(/basil-display text-base text-sidebar-foreground/.test(layout),
    "the mobile wordmark must use the sidebar's own foreground, not an ink borrowed from the paper world");
});
