// Pasting into Ask Basil (lib/chat/paste.ts, app/dashboard/chat/page.tsx).
// The message box had no paste handling: a pasted screenshot or file vanished,
// and text was left entirely to the browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const P = loadTs("lib/chat/paste.ts", {}, {}, { File });

const clip = (data = {}, files = []) => ({
  getData: (t) => data[t] ?? "",
  items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
});

test("plain text comes through, Windows line endings made plain", () => {
  assert.equal(P.pastedText(clip({ "text/plain": "line one\r\nline two" })), "line one\nline two");
  assert.equal(P.pastedText(clip()), "");
});

test("a clipboard with only HTML still pastes as readable text", () => {
  const html = "<div><b>Ed Baum</b>: pricing&nbsp;call &amp; follow-up</div><p>Next line</p><style>.x{}</style>";
  assert.equal(P.pastedText(clip({ "text/html": html })), "Ed Baum: pricing call & follow-up\nNext line");
});

test("a screenshot becomes a named attachment; unsupported files are left out", () => {
  const shot = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  const zip = new File([new Uint8Array([1])], "a.zip", { type: "application/zip" });
  const pdf = new File([new Uint8Array([1])], "memo.pdf", { type: "application/pdf" });
  const files = P.pastedFiles(clip({}, [shot, zip, pdf]), new Date("2026-10-31T09:15:00Z"));
  assert.equal(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["pasted-2026-10-31T09-15-00-000Z.png", "memo.pdf"]));
});

test("the message box handles paste; text wins over the picture a spreadsheet also copies", () => {
  const s = fs.readFileSync(path.join(ROOT, "app/dashboard/chat/page.tsx"), "utf8");
  assert.match(s, /onPaste=\{handlePaste\}/);
  assert.match(s, /const files = text \? \[\] : pastedFiles\(cd\);/);
  assert.match(s, /setInput\(el\.value\.slice\(0, start\) \+ text \+ el\.value\.slice\(end\)\);/);
});
