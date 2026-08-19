/**
 * tests/contrast-aa.test.mjs
 *
 * Computes real WCAG contrast for every foreground/background pair the token
 * system defines, in both scopes, and fails below AA (4.5:1).
 *
 * WHY THIS IS A TEST AND NOT A REVIEW. On 2026-08-15 the Wire Desk rebuild
 * added a LIGHT paper scope (`.wire`) nested inside the force-dark shell, and
 * defined its own palette without restating the semantic tokens it inherits.
 * Every token was individually correct; only the composition was wrong. The
 * result shipped to production:
 *
 *   text-muted-foreground  #D2D8E2 on paper #E9EAE4  = 1.18:1   (707 uses)
 *   text-foreground        #F4F1EA on paper #E9EAE4  = 1.07:1   (197 uses)
 *
 * ~900 elements of near-white text on near-white paper across every dashboard
 * surface. Nothing caught it — it typechecks, it builds, and reading either
 * stylesheet alone shows nothing wrong. Only multiplying the two scopes
 * together reveals it, which is arithmetic, so it belongs in the suite.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
const wire    = readFileSync(resolve(ROOT, "app/wire.css"), "utf8");

/** Merge every top-level block whose selector matches, in source order. */
function blocks(css, selectorRe) {
  const out = {};
  for (const m of css.matchAll(selectorRe)) {
    const start = css.indexOf("{", m.index);
    let depth = 0, end = start;
    for (let j = start; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) { end = j; break; }
    }
    for (const d of css.slice(start + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[d[1]] = d[2].trim();
    }
  }
  return out;
}

const root = blocks(globals, /^:root[ ,]/gm);
const dark = blocks(globals, /^\.dark\s*\{/gm);
const wiretok = blocks(wire, /^\.wire\s*\{/gm);

const SHELL = { ...root, ...dark };          // production pins dark
const PAPER = { ...SHELL, ...wiretok };      // .wire nests inside it

function resolveVar(value, scope, depth = 0) {
  if (value == null || depth > 10) return null;
  const v = String(value).trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
  if (m) return resolveVar(scope[m[1]], scope, depth + 1);
  return v.startsWith("#") ? v : null;
}

function rgba(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 1];
  if (h.length === 8) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), parseInt(h.slice(6,8),16)/255];
  return null;
}
const over = (f, b) => f[3] >= 1 ? f
  : [f[0]*f[3]+b[0]*(1-f[3]), f[1]*f[3]+b[1]*(1-f[3]), f[2]*f[3]+b[2]*(1-f[3]), 1];
function luminance(c) {
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2]);
}
function contrast(fg, bg) {
  const f = over(fg, bg);
  const [hi, lo] = [luminance(f), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of one token pair, compositing a translucent fill over `ground`. */
function ratioOf(scope, fgTok, bgTok, groundTok) {
  const f = resolveVar(scope[fgTok], scope), b = resolveVar(scope[bgTok], scope);
  if (!f || !b) return null;
  let fc = rgba(f), bc = rgba(b);
  if (!fc || !bc) return null;
  if (bc[3] < 1 && groundTok) {
    const g = rgba(resolveVar(scope[groundTok], scope) ?? "");
    if (g) bc = over(bc, g);
  }
  return contrast(fc, bc);
}

const SEMANTIC_PAIRS = [
  ["--foreground", "--background"],
  ["--card-foreground", "--card"],
  ["--popover-foreground", "--popover"],
  ["--muted-foreground", "--muted"],
  ["--accent-foreground", "--accent"],
  ["--secondary-foreground", "--secondary"],
  ["--primary-foreground", "--primary"],
  ["--sidebar-foreground", "--sidebar"],
  ["--sidebar-accent-foreground", "--sidebar-accent"],
];
const AA = 4.5;

function auditScope(scope, label) {
  const fails = [];
  const push = (name, r) => { if (r != null && r < AA) fails.push(`${label}: ${name} = ${r.toFixed(2)}:1`); };

  for (const [fg, bg] of SEMANTIC_PAIRS) {
    push(`${fg.slice(2)} on ${bg.slice(2)}`, ratioOf(scope, fg, bg, "--background"));
  }
  // Body and secondary text must hold on EVERY surface a component may sit on —
  // this is the check that would have caught muted-foreground on paper.
  for (const fg of ["--foreground", "--muted-foreground"]) {
    for (const bg of ["--background", "--card", "--muted", "--accent", "--secondary", "--popover"]) {
      push(`${fg.slice(2)} on ${bg.slice(2)}`, ratioOf(scope, fg, bg, "--background"));
    }
  }
  for (const s of ["critical", "warning", "positive", "info", "neutral"]) {
    push(`signal-${s} on background`, ratioOf(scope, `--signal-${s}`, "--background", "--background"));
    push(`signal-${s} on its subtle fill`, ratioOf(scope, `--signal-${s}`, `--signal-${s}-subtle`, "--background"));
    push(`signal-${s} on card`, ratioOf(scope, `--signal-${s}`, "--card", "--background"));
  }
  push("destructive on background", ratioOf(scope, "--destructive", "--background", "--background"));
  return fails;
}

test("the paper scope (.wire, as shipped inside the dark shell) meets AA everywhere", () => {
  const fails = auditScope(PAPER, "paper");
  assert.deepEqual(fails, [],
    "text below 4.5:1 is unreadable, and a token that looks right in isolation can still " +
    "compose to near-invisible once .wire nests inside .dark:\n  " + fails.join("\n  "));
});

test("the dark shell meets AA everywhere", () => {
  const fails = auditScope(SHELL, "shell");
  assert.deepEqual(fails, [], "shell pairings below AA:\n  " + fails.join("\n  "));
});

test(".wire restates every semantic token the dark theme overrides", () => {
  // The root cause: a light scope nested in a dark one that inherits the dark
  // semantic layer is two themes overlapping, not one theme. Sidebar tokens are
  // the deliberate exception — that chrome stays dark and is self-consistent.
  const overridden = Object.keys(dark)
    .filter((k) => k in root && dark[k] !== root[k])
    .filter((k) => !k.startsWith("--sidebar"));
  const missing = overridden.filter((k) => !(k in wiretok));
  assert.deepEqual(missing, [],
    "these resolve to their DARK value on light paper inside .wire: " + missing.join(", "));
});
