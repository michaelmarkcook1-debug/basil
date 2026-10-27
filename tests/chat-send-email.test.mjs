// Approving a new email in chat must SEND it. It used to go through draftEmail,
// whose approval only saved a Gmail draft: the card said "Approve", Basil said
// it was done, and nothing left the outbox (reported 2026-10-27).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("chat has a sendEmail tool that really sends, always with approval", () => {
  const t = src("lib/ai/tools.ts");
  const block = t.slice(t.indexOf("sendEmail: tool({"), t.indexOf("draftEmail: tool({"));
  assert.ok(block.length > 100, "sendEmail tool exists, before draftEmail");
  assert.match(block, /needsApproval: true,/, "never delegated, never auto-run");
  assert.match(block, /await sendGmail\(username, to, subject, body\)/, "calls Gmail's send, not createDraft");
  assert.doesNotMatch(block, /createDraft/);
  assert.match(block, /if \(!sent\.id\) return \{ error: "Gmail did not confirm the send\. The email was NOT sent\." \}/);
  assert.match(block, /return \{ status: "sent", messageId: sent\.id/);
  assert.doesNotMatch(src("lib/trust/ledger.ts").match(/REVERSIBLE_TOOLS[^;]*;/s)[0], /sendEmail/, "cannot be delegated");
});

test("draftEmail says plainly that nothing was sent", () => {
  const t = src("lib/ai/tools.ts");
  const block = t.slice(t.indexOf("draftEmail: tool({"), t.indexOf("replyToEmail: tool({"));
  assert.match(block, /Only when \$\{name\} explicitly asks for a draft/);
  assert.match(block, /status: "saved_to_drafts", sent: false, note: "NOT sent\./);
  const p = src("lib/ai/system-prompt.ts");
  assert.match(p, /send a new email with \\`sendEmail\\` \(approval; approving SENDS it\)/);
  assert.match(p, /Never say an email was sent unless \\`sendEmail\\` or \\`replyToEmail\\` returned status "sent"/);
});

test("the approval button says Send for sends and Save draft for drafts", () => {
  const c = src("app/dashboard/chat/page.tsx");
  assert.match(c, /if \(toolName === "sendEmail" \|\| toolName === "replyToEmail" \|\| toolName === "sendSlackMessage"\) return "Send";/);
  assert.match(c, /if \(toolName === "draftEmail"\) return "Save draft";/);
  assert.match(c, /\{approveLabel\(toolName\)\}/);
  assert.match(c, /case "draftEmail":\s*return `Saved to Gmail Drafts, NOT sent/);
});

test("new emails and drafts encode a non-ASCII subject (em dash, curly quote)", () => {
  const g = src("lib/google/gmail.ts");
  assert.equal((g.match(/Subject: \$\{encodeHeader\(hdr\(subject\)\)\}\\r\\nMIME-Version: 1\.0/g) ?? []).length, 2, "sendEmail and createDraft");
  const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  assert.equal(encodeHeader("Pricing next steps"), "Pricing next steps");
  assert.equal(Buffer.from(encodeHeader("Pricing — next steps").slice(10, -2), "base64").toString("utf8"), "Pricing — next steps");
});
