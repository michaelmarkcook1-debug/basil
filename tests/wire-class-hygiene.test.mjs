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

test("the world guarantees a visible keyboard focus ring", () => {
  // Eight controls shipped with outline-style: none — no focus-visible utility
  // and no global fallback, so a keyboard user lost the caret entirely. Relying
  // on a per-control utility means one is always forgotten, and the omission is
  // invisible to anyone using a mouse.
  const wire = readFileSync(resolve(ROOT, "app/wire.css"), "utf8");
  const block = /\.wire a:focus-visible[^{]*\{([^}]*)\}/.exec(wire);
  assert.ok(block, "there must be a global focus-visible rule scoped to .wire");
  assert.ok(/outline:\s*2px solid/.test(block[1]), "the ring must be a real outline, not a colour swap");
  assert.ok(/outline-offset/.test(block[1]), "it must clear the element edge to stay visible on filled controls");
});

test("every arbitrary text colour carries the `color:` type hint", () => {
  // `text-[var(--w-carbon)]` is AMBIGUOUS to Tailwind — an arbitrary value in a
  // `text-*` utility could be a colour or a font-size, and given a bare
  // `var(...)` it cannot tell, so it emits NOTHING. 196 usages across 46 files
  // generated no rule at all; the pages looked plausible only because `.wire`
  // sets `color` as an inherited default, so every accent-coloured label had
  // been silently rendering as plain ink since the day it was written.
  //
  // `text-[color:var(--w-carbon)]` disambiguates it. Same failure family as the
  // stray-bracket bug above: valid TSX, clean build, no rule.
  const offenders = [];
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/text-\[var\(--[\w-]+/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${file.replace(ROOT + "/", "")}:${line}  ${m[0]}]`);
    }
  }
  assert.deepEqual(offenders, [],
    "these emit no CSS — write text-[color:var(--x)]:\n  " + offenders.join("\n  "));
});

test("any wire token used on the nav chrome actually reads on it", () => {
  // This began life as a blanket ban on --w- tokens in the shell, written when
  // the accent was violet (#35346B) and the pairing was 1.65:1. The world is now
  // dark and the accent is gold, so the same token is 8.3:1 — the ban would
  // forbid a correct choice. Bans encode a conclusion; this computes it, so it
  // stays right through the next palette change too.
  const layout = readFileSync(resolve(ROOT, "app/dashboard/layout.tsx"), "utf8");
  const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
  const wire = readFileSync(resolve(ROOT, "app/wire.css"), "utf8");

  const tokenValue = (css, name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css);
    return m ? m[1] : null;
  };
  const rgb = (hex) => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  };
  const lum = (c) => {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2]);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // The sidebar ground, from the DARK block (production pins dark).
  const darkBlock = globals.slice(globals.search(/^\.dark\s*\{/m));
  const sidebar = tokenValue(darkBlock, "--sidebar");
  assert.ok(sidebar, "expected a --sidebar value in the dark theme");

  const used = [...new Set([...layout.matchAll(/--w-[a-z-]+/g)].map((m) => m[0]))];
  const fails = [];
  for (const tok of used) {
    const val = tokenValue(wire, tok);
    if (!val) continue;                    // tints/alpha values are fills, skipped
    const r = ratio(rgb(val), rgb(sidebar));
    if (r < 4.5) fails.push(`${tok} ${val} on ${sidebar} = ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(fails, [],
    "these are painted on the nav chrome but cannot be read against it:\n  " + fails.join("\n  "));
});

