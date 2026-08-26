/**
 * tests/palette-separation.test.mjs
 *
 * Contrast is not the whole of colour accessibility. Every status colour can
 * clear 7:1 against the ground and still be useless if two of them look the
 * same as each other — the reader is not comparing a colour to the background,
 * they are comparing it to the OTHER states.
 *
 * That is exactly what shipped: warning #F5B96B sat ΔE 17.4 from the gold
 * accent, same hue family separated only by lightness. "This is a link, Basil
 * is speaking" and "this is at risk" were near-indistinguishable, and every
 * contrast test passed the whole time because each was measured against the
 * canvas and never against the other.
 *
 * Also checks WCAG 1.4.11 (non-text contrast, 3:1) — icons, bars, borders and
 * focus rings carry meaning and are not covered by the text-contrast audit.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const wire = readFileSync(resolve(ROOT, "app/wire.css"), "utf8");

function token(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(wire);
  assert.ok(m, `expected ${name} to be a 6-digit hex in app/wire.css`);
  return m[1];
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const linear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function lab(c) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [r, g, b] = c.map(linear);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

/** Brettel/Viénot LMS simulation of dichromatic vision. */
function simulate(c, kind) {
  const [r, g, b] = c.map(linear);
  let L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  let M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  let S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
  if (kind === "protan") L = 2.02344 * M - 2.52581 * S;
  else if (kind === "deutan") M = 0.494207 * L + 1.24827 * S;
  else S = -0.395913 * L + 0.801109 * M;
  const enc = (v) => {
    v = Math.max(0, Math.min(1, v));
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  return [
    enc(0.0809444479 * L - 0.130504409 * M + 0.116721066 * S),
    enc(-0.0102485335 * L + 0.0540193266 * M - 0.113614708 * S),
    enc(-0.000365296938 * L - 0.00412161469 * M + 0.693511405 * S),
  ];
}

const STATUS = {
  accent: "--w-carbon",
  danger: "--w-stamp",
  warning: "--w-manila",
  success: "--w-filed",
  information: "--w-info",
};
const GROUND = "--w-paper";
const CARD = "--w-flimsy";
const CONFUSABLE = 20; // ΔE76 below which two colours read as the same

test("no two status colours are confusable in normal vision", () => {
  const names = Object.keys(STATUS);
  const clashes = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = deltaE(rgb(token(STATUS[names[i]])), rgb(token(STATUS[names[j]])));
      if (d < CONFUSABLE) clashes.push(`${names[i]} vs ${names[j]} = ΔE ${d.toFixed(1)}`);
    }
  }
  assert.deepEqual(clashes, [],
    "these states look alike, so the reader cannot tell them apart at a glance:\n  " +
    clashes.join("\n  "));
});

test("the accent stays distinct from warning under deuteranopia", () => {
  // Deuteranopia is the common one (~6% of men) and it is where an amber
  // warning collapses into a gold accent. Red-vs-gold cannot be separated by
  // hue under it at all — that is a property of the deficiency, not a fixable
  // palette flaw — which is why every status also carries an icon and a word.
  // This pins the one pair that IS fixable and was previously broken.
  const d = deltaE(
    simulate(rgb(token("--w-carbon")), "deutan"),
    simulate(rgb(token("--w-manila")), "deutan"),
  );
  assert.ok(d >= CONFUSABLE,
    `accent and warning are ΔE ${d.toFixed(1)} under deuteranopia — an amber warning ` +
    `beside a gold accent is the specific collision this checks`);
});

test("non-text colours meet WCAG 1.4.11 (3:1) on both grounds", () => {
  // Icons, bars, rules and the focus ring carry meaning and are invisible to a
  // text-contrast audit.
  const fails = [];
  for (const [name, tok] of Object.entries(STATUS)) {
    for (const [groundName, ground] of [["canvas", GROUND], ["card", CARD]]) {
      const r = contrast(rgb(token(tok)), rgb(token(ground)));
      if (r < 3) fails.push(`${name} on ${groundName} = ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(fails, [], "non-text contrast below 3:1:\n  " + fails.join("\n  "));
});

test("status is never carried by colour alone", () => {
  // The backstop for every CVD collision hue cannot fix.
  const prim = readFileSync(resolve(ROOT, "components/today/primitives.tsx"), "utf8");
  assert.ok(/Icon: typeof AlertTriangle/.test(prim), "each urgency carries an icon");
  assert.ok(/URGENCY_LABEL\[urgency\]/.test(prim), "and a word");
});
