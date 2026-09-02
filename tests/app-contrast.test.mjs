/**
 * tests/app-contrast.test.mjs
 *
 * Whole-app contrast: resolves every Tailwind class the app actually uses to the
 * colour it actually compiles to, then checks every text/background pairing.
 *
 * WHY THIS EXISTS ALONGSIDE tests/contrast-aa.test.mjs. That file checks the
 * TOKEN table — is `--muted-foreground` readable on `--muted`. It passed the
 * whole time 21 elements were painting dark gold (#906b00, authored for the
 * light paper ground) onto the dark canvas at 3:1, because no token pair was
 * wrong: a hardcoded literal was. Token-level checks cannot see a class.
 *
 * Requires a production build, since it reads the emitted CSS. Skips cleanly
 * without one so `npm test` still runs on a fresh clone.
 *
 * TWO RESOLVER TRAPS, both of which produced confident nonsense before being
 * fixed — noted so the next person does not re-introduce them:
 *   1. `\bcolor:` also matches inside `background-color:`. Without a negative
 *      lookbehind every background is also read as a text colour, and hundreds
 *      of 1.00:1 "failures" appear.
 *   2. Tailwind emits an opaque @supports fallback as a SEPARATE rule with the
 *      same selector, before the real color-mix() with alpha. CSS takes the
 *      last; a first-wins map reads every /10 utility as fully opaque.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CHUNKS = resolve(ROOT, ".next/static/chunks");

function loadCss() {
  if (!existsSync(CHUNKS)) return null;
  let css = "";
  for (const f of readdirSync(CHUNKS)) {
    if (f.endsWith(".css")) css += readFileSync(join(CHUNKS, f), "utf8");
  }
  return css || null;
}

const oklchToHex = (L, C, H) => {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (x) => {
    x = Math.max(0, Math.min(1, x));
    x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(255, x * 255)));
  };
  const r = enc(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = enc(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = enc(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
};

const rgba = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const v = (i) => parseInt(h.slice(i, i + 2), 16);
  if (h.length === 6) return [v(0), v(2), v(4), 1];
  if (h.length === 8) return [v(0), v(2), v(4), v(6) / 255];
  return null;
};
const over = (f, b) => f[3] >= 1 ? f
  : [f[0]*f[3]+b[0]*(1-f[3]), f[1]*f[3]+b[1]*(1-f[3]), f[2]*f[3]+b[2]*(1-f[3]), 1];
const lum = (c) => {
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2]);
};
const contrast = (f, b) => {
  const x = over(f, b), [hi, lo] = [lum(x), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

function tokensFrom(css, selector) {
  const out = {};
  for (const m of css.matchAll(selector)) {
    const start = css.indexOf("{", m.index);
    let depth = 0, end = start;
    for (let j = start; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) { end = j; break; }
    }
    for (const d of css.slice(start + 1, end).matchAll(/(--[\w-]+):\s*([^;}]+)/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

/**
 * Custom classes that paint a background but leave text to inherit.
 *
 * `.basil-card` is `background-color: var(--surface-1)` with a `.dark` rule that
 * only adds a box-shadow — it never changes the background. When `.wire` left
 * --surface-1 at its light value (#fafaf8), every card in the app went cream
 * under near-white inherited text. The Tailwind sweep below could not see it:
 * `.basil-card` is not a utility, and the text colour lives on a different
 * element. So the inherited foreground is checked against every custom surface.
 */
test("every custom surface class is readable with inherited text", () => {
  const css = loadCss();
  if (!css) { console.log("  (skipped: no production build)"); return; }
  const TOK = { ...tokensFrom(css, /\.dark\{/g), ...tokensFrom(css, /\.wire\{/g) };
  const rv = (v, d = 0) => {
    if (v == null || d > 8) return null;
    v = String(v).trim();
    const m = /^var\((--[\w-]+)(?:,[^)]*)?\)$/.exec(v);
    if (m) return rv(TOK[m[1]], d + 1);
    return v.startsWith("#") ? v : null;
  };
  const fg = rgba(rv(TOK["--foreground"]) ?? "#F4F1EA");
  const muted = rgba(rv(TOK["--muted-foreground"]) ?? "#A9B4C4");
  const fails = [];
  for (const m of css.matchAll(/\.(basil-[\w-]+|surface-[\w-]+)\{([^}]*)\}/g)) {
    const bgDecl = [...m[2].matchAll(/\bbackground-color:\s*([^;]+)/g)].pop();
    if (!bgDecl) continue;
    const hex = rv(bgDecl[1]);
    if (!hex) continue;
    const bg = rgba(hex);
    if (!bg) continue;
    for (const [label, ink] of [["foreground", fg], ["muted-foreground", muted]]) {
      const r = contrast(ink, bg);
      if (r < 4.5) fails.push(`.${m[1]} (${hex}) with ${label} = ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(fails, [],
    "these surfaces are painted but the inherited text cannot be read on them:\n  " +
    fails.join("\n  "));
});

test("no element in the app pairs text and background below AA", () => {
  const css = loadCss();
  if (!css) {
    console.log("  (skipped: no production build — run `npm run build` first)");
    return;
  }

  const TOK = { ...tokensFrom(css, /\.dark\{/g), ...tokensFrom(css, /\.wire\{/g) };
  const resolveVar = (v, d = 0) => {
    if (v == null || d > 8) return null;
    v = String(v).trim();
    const m = /^var\((--[\w-]+)(?:,[^)]*)?\)$/.exec(v);
    if (m) return resolveVar(TOK[m[1]], d + 1);
    if (v.startsWith("#")) return v;
    const o = /^oklch\(([\d.]+)[ _]+([\d.]+)[ _]+([\d.]+)\)$/.exec(v);
    if (o) return oklchToHex(+o[1], +o[2], +o[3]);
    return null;
  };
  const convert = (v) => {
    if (v == null) return null;
    const mm = /color-mix\(in [\w-]+,\s*([^,]+?)\s+([\d.]+)%/.exec(v);
    if (mm) {
      const base = resolveVar(mm[1].trim());
      if (!base) return null;
      return base + Math.round((+mm[2] * 255) / 100).toString(16).padStart(2, "0");
    }
    return resolveVar(v);
  };

  const FG = {}, BG = {};
  for (const m of css.matchAll(/\.((?:[^{},\s]|\\.)+?)(?::hover)?\{([^}]*)\}/g)) {
    const cls = m[1].replace(/\\/g, ""), body = m[2];
    // (1) the lookbehind, (2) last-rule-wins — see the header note.
    const c = [...body.matchAll(/(?<!-)\bcolor:\s*([^;]+)/g)].pop();
    const b = [...body.matchAll(/\bbackground-color:\s*([^;]+)/g)].pop();
    if (c) { const v = convert(c[1]); if (v) FG[cls] = v; }
    if (b) { const v = convert(b[1]); if (v) BG[cls] = v; }
  }

  const ground = rgba(resolveVar(TOK["--w-paper"]) ?? "#0E1724");
  const files = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (n === "node_modules" || n === ".next") continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  };
  walk(resolve(ROOT, "app")); walk(resolve(ROOT, "components"));

  const fails = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/"([^"\n]{0,400}?)"/g)) {
      const s = m[1];
      if (!s.includes("text-") && !s.includes("bg-")) continue;
      const toks = s.split(/\s+/);
      const fgHex = toks.map((t) => FG[t]).find(Boolean);
      const bgHex = toks.map((t) => BG[t]).find(Boolean);
      if (!fgHex || !bgHex) continue;
      let f = rgba(fgHex), b = rgba(bgHex);
      if (!f || !b) continue;
      if (b[3] < 1) b = over(b, ground);
      const r = contrast(f, b);
      if (r < 4.5) {
        const line = src.slice(0, m.index).split("\n").length;
        fails.push(`${r.toFixed(2)}:1  ${file.replace(ROOT + "/", "")}:${line}  ${fgHex} on ${bgHex}`);
      }
    }
  }

  assert.deepEqual(fails, [],
    "text that cannot be read on its own background:\n  " + fails.join("\n  "));
});
