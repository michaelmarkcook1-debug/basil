/**
 * tests/chat-attachments.test.mjs
 *
 * Guards the fix for "Ask Basil keeps erroring when I load an image or paste a
 * URL" — which was ONE bug wearing two faces.
 *
 * Attachments are inlined into the request as base64 (~1.33x raw), and useChat
 * resends the ENTIRE conversation on every turn. So a single oversized
 * screenshot did not merely fail its own send: it sat in history and broke every
 * later message, including plain text. That is why pasting a URL "also" failed —
 * same trapped image.
 *
 * The 200 KB ceiling was sized for text-only histories and is not survivable for
 * any image workflow.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const webChat = read("app/api/chat/route.ts");
const mobileChat = read("app/api/chat/mobile/route.ts");
const page = read("app/dashboard/chat/page.tsx");
const downscale = read("lib/images/downscale.ts");

test("the body ceiling fits an image workflow and stays under Vercel's limit", () => {
  for (const [name, src] of [["web chat", webChat], ["mobile chat", mobileChat]]) {
    const m = /const MAX_BODY_BYTES = ([\d_]+);/.exec(src);
    assert.ok(m, `${name} must declare MAX_BODY_BYTES`);
    const bytes = Number(m[1].replace(/_/g, ""));
    assert.ok(bytes >= 1_000_000,
      `${name}: 200 KB was sized for text-only history — an image blows it instantly (got ${bytes})`);
    assert.ok(bytes < 4_500_000,
      `${name}: must stay under Vercel's ~4.5 MB body limit so we return a readable 413 ` +
      `rather than the platform severing the request (got ${bytes})`);
  }
});

test("the 413 tells the user what to actually do", () => {
  // "Check Settings → Readiness" is useless for an oversized body.
  for (const [name, src] of [["web chat", webChat], ["mobile chat", mobileChat]]) {
    assert.ok(/smaller image|new chat/.test(src),
      `${name}: the 413 message must name a concrete remedy`);
    assert.ok(!/max 200 KB/.test(src), `${name}: stale limit quoted in the error copy`);
  }
});

test("images are downscaled BEFORE they are staged", () => {
  assert.ok(/downscaleImage/.test(page), "the chat page must downscale attachments");
  const handler = page.slice(page.indexOf("const handleFileChange"));
  const body = handler.slice(0, handler.indexOf("}, []);"));
  assert.ok(/await Promise\.all\(files\.map\(\(f\) => downscaleImage\(f\)\)\)/.test(body),
    "downscaling must happen before setStagedFiles — staging the raw file first " +
    "would still send the oversized original");
});

test("downscaling degrades safely and never silently drops an attachment", () => {
  assert.ok(/return file;/.test(downscale), "every failure path must return the ORIGINAL file");
  assert.ok(/catch\s*\{[\s\S]{0,200}return file;/.test(downscale),
    "a downscale error must not block the send");
  assert.ok(/blob\.size >= file\.size/.test(downscale),
    "if re-encoding grew the file, keep the original");
  assert.ok(/svg\+xml/.test(downscale),
    "SVG is vector — rasterising it would make it worse, not smaller");
  assert.ok(/1568/.test(downscale),
    "cap the long edge at Claude's effective ceiling — larger pixels are discarded on arrival");
});
