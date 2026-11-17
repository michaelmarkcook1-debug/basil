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
  assert.match(s, /const action = pasteAction\(cd\);/);
  assert.match(s, /setInput\(el\.value\.slice\(0, start\) \+ text \+ el\.value\.slice\(end\)\);/);
});

// 2026-11-10: "I need to be able to copy and paste images into the chat box".
// A screenshot copied straight to the clipboard worked; a screenshot FILE copied
// in Finder pasted its file name, and an image copied with its address pasted
// the URL — the picture was lost both times. Reproduced on the live page.
test("an image copied as a file attaches the image, not its file name", () => {
  const shot = new File([new Uint8Array([1, 2, 3])], "Screenshot 2026-11-10 at 10.00.00.png", { type: "image/png" });
  const a = P.pasteAction(clip({ "text/plain": "Screenshot 2026-11-10 at 10.00.00.png" }, [shot]));
  assert.equal(JSON.stringify(a.files?.map((f) => f.name)), JSON.stringify(["Screenshot 2026-11-10 at 10.00.00.png"]));
  // Two files copied together list both names, one per line.
  const b = new File([new Uint8Array([1])], "chart.jpg", { type: "image/jpeg" });
  const two = P.pasteAction(clip({ "text/plain": "Screenshot 2026-11-10 at 10.00.00.png\nchart.jpg" }, [shot, b]));
  assert.equal(two.files?.length, 2);
  // A full path is a name too.
  assert.ok(P.pasteAction(clip({ "text/plain": "/Users/m/Desktop/chart.jpg" }, [b])).files);
});

test("an image copied with its web address attaches the image", () => {
  const img = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  assert.ok(P.pasteAction(clip({ "text/plain": "https://files.slack.com/files-pri/T0/F0/chart.png" }, [img])).files);
  assert.ok(P.pasteAction(clip({ "text/html": '<img src="https://example.com/a.png" alt="">' }, [img])).files);
  assert.ok(P.pasteAction(clip({}, [img])).files, "a screenshot on the clipboard");
});

test("real text still wins over the picture a spreadsheet copies with it", () => {
  const img = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  const a = P.pasteAction(clip({ "text/plain": "Q3\t12\nQ4\t15" }, [img]));
  assert.equal(a.text, "Q3\t12\nQ4\t15");
  assert.equal(P.pasteAction(clip({ "text/plain": "see https://x.com/a and reply" }, [img])).text, "see https://x.com/a and reply");
  assert.equal(P.pasteAction(clip()), null);
});
